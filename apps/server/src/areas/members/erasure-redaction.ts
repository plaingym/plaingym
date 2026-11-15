// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { classCreditEntries, forGym, households, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { z } from 'zod';
import type { JobRecovery, Jobs } from '../../infra/jobs/index.js';
import type { Uploads } from '../../infra/storage/index.js';
import type { ClearCustomerEmail } from '../../infra/payments/index.js';
import { logError, logInfo } from '../../core/log.js';
import { billingEmailClearedAction, billingEmailErasuresToRetry, billingEmailQueuedAction, customerRedactedAction, erasuresToRedact, redactionQueuedAction } from './erasure-redaction.query.js';

/** The sole ledger update: erase free text while preserving the append-only credit history. */
export async function eraseCreditReasons(tx: Transaction, memberId: string) {
  await tx.update(classCreditEntries).set({ reason: '' })
    .where(and(eq(classCreditEntries.memberId, memberId), eq(classCreditEntries.kind, 'adjust')));
}

/** Queues the provider redaction of the customer an erased household had. */
export const redactCustomerJob = 'members.erasure.redact_customer';
/** Clears the erased payer's email while the household keeps its customer and cards. */
export const clearBillingEmailJob = 'members.erasure.clear_billing_email';
const billingEmailPayload = z.object({ householdId: z.uuid(), customerId: z.string().regex(/^cus_[A-Za-z0-9_]+$/),
  erasureId: z.uuid().optional(), emailDigest: z.string().regex(/^(?:k1:)?[a-f0-9]{64}$/),
  paymentMethodIds: z.array(z.string().regex(/^(?:pm|card|ba|src)_[A-Za-z0-9_]+$/)).optional(),
  paymentMethodId: z.string().regex(/^(?:pm|card|ba|src)_[A-Za-z0-9_]+$/).optional() }); // Imported cards and already queued jobs keep legacy IDs.
export type ClearBillingEmail = (gymId: string, customerId: string, options: ClearCustomerEmail) => Promise<void>;

/** Recheck the local customer link before calling out; a reassigned customer is left alone. */
export async function clearErasedBillingEmail(payload: unknown, gymId: string, clear: ClearBillingEmail,
  config: { secret: string; clock: Clock; scope?: typeof forGym }): Promise<void> {
  const { customerId, erasureId, ...options } = billingEmailPayload.parse(payload);
  if (options.emailDigest.startsWith('k1:') && !config.secret) throw new Error('Billing email erasure is not configured');
  const scope = config.scope ?? forGym;
  const linked = await scope(gymId, tx => tx.select({ id: households.id }).from(households)
    .where(eq(households.stripeCustomerId, customerId)));
  if (linked.length !== 1 || linked[0]!.id !== options.householdId) {
    logInfo('members.erasure.billing_email_skipped_linked', { gymId, householdId: options.householdId });
    return;
  }
  await clear(gymId, customerId, { ...options, secret: config.secret });
  await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: billingEmailClearedAction,
    targetType: 'household', targetId: options.householdId, after: { stripeCustomerId: customerId, ...(erasureId ? { erasure: erasureId } : {}) },
    occurredAt: config.clock.now() }));
}
/** Marks deleted the photo and signature images an erasure released; committed with the erasure, under `release:<member ID>`. */
export const releaseErasedFilesJob = 'members.erasure.release_files';
const releasePayload = z.object({ keys: z.array(z.string().min(1)).min(1) });
/**
 * The release job's work: every key must carry the job's gym prefix, and marking a key deleted again is harmless, so a retry
 * after a partial run repeats only what is left. A storage failure throws, and the queue retries it.
 */
export async function releaseErasedFiles(payload: unknown, gymId: string, uploadsFor: (gymId: string) => Promise<Pick<Uploads, 'markDeleted'>>) {
  const { keys } = releasePayload.parse(payload);
  if (keys.some(key => !key.startsWith(`${gymId}/`))) throw new Error('Erased file key outside the job gym');
  const uploads = await uploadsFor(gymId);
  for (const key of keys) await uploads.markDeleted(key);
}
/** Daily check that every erased household's provider customer has a redaction queued (see `queueEarlierRedactions`). */
export const redactEarlierJob = 'members.erasure.redact_earlier';
export { billingEmailClearedAction, billingEmailQueuedAction, customerRedactedAction, redactionQueuedAction };
/** Each run queues at most this many customer redactions and retries this many exhausted email clears. */
export const redactEarlierBatch = 200;

/**
 * Redaction of erased households' provider customers that erasure's own job missed: customers erased before the
 * redaction covered every personal field (or before it existed), and an erasure whose own job ran out of attempts before
 * one succeeded. Reads the gym's own `household.anonymized` audits, whose `before.stripeCustomerId` kept the cleared ID,
 * and queues one redaction job per erasure under a stable key (`redact-earlier:<erasure audit ID>`), each with a
 * `members.erasure.redaction_queued` audit naming the erasure, so a rerun queues nothing new even after the job queue has
 * pruned its finished rows, and a customer erased, reused and erased again is queued again for the second erasure. An
 * erasure whose customer was redacted after it (`members.erasure.customer_redacted`, written by `guardRedaction`) needs
 * none. The redaction itself is idempotent, so a crash between the job and its marker only repeats it. A customer that a
 * household of the gym links today is skipped (and not marked): the gym has since reused it, and redacting it would erase
 * a live customer (`guardRedaction` checks again when the job runs). The selection and the batch limit run in SQL
 * (`erasuresToRedact`). Also resets exhausted billing email clears without a completion audit, through JobRecovery.
 * Returns the number of customer redactions queued plus email clears reset (each capped at `batch`).
 */
export async function queueEarlierRedactions(options: { gymId: string; timezone: string; jobs: Pick<Jobs, 'enqueue'> & Partial<JobRecovery>; clock: Clock; scope?: typeof forGym; batch?: number }): Promise<number> {
  const { gymId, timezone, jobs, clock, scope = forGym, batch = redactEarlierBatch } = options;
  const pending = await scope(gymId, tx => erasuresToRedact(tx, gymId, batch));
  for (const { id, householdId, customerId } of pending) {
    // The job first, then the marker: no network or queue call runs inside the audit's transaction.
    await jobs.enqueue(redactCustomerJob, { customerId }, { gymId, timezone, idempotencyKey: `redact-earlier:${id}`, maxAttempts: 12 });
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: redactionQueuedAction, targetType: 'household',
      targetId: householdId, after: { stripeCustomerId: customerId, erasure: id }, occurredAt: clock.now() }));
  }
  let retried = 0;
  if (jobs.failedJobs && jobs.retryFailed) {
    let afterId: string | undefined;
    for (;;) {
      const emails = await scope(gymId, tx => billingEmailErasuresToRetry(tx, gymId, batch, afterId));
      const failed = await jobs.failedJobs(clearBillingEmailJob, emails.map(row => `clear-billing-email:${row.erasureId}`), { gymId });
      for (const job of failed.slice(0, batch - retried)) if (await jobs.retryFailed(job.jobId, { gymId, runAt: clock.now() })) retried++;
      // Pending or deliberately skipped jobs must not hide exhausted jobs on a later page.
      if (emails.length < batch || retried >= batch) break;
      afterId = emails.at(-1)!.id;
    }
  }
  return pending.length + retried;
}

/**
 * Wraps the provider's customer redaction for erasure (its inline attempt and the `members.erasure.redact_customer` job):
 * a customer that a household of the gym links when the redaction runs is skipped and logged, since the gym has reused it
 * since it was queued (an import, say, while Stripe was down and the job retried), and redacting it would erase a live
 * customer. A redaction that succeeds is audited (`members.erasure.customer_redacted`), so the daily check doesn't queue
 * that erasure again. The check and the call can't share a transaction (no network call runs in one).
 */
export function guardRedaction(redact: (gymId: string, customerId: string) => Promise<void>, options: { clock: Clock; scope?: typeof forGym }) {
  const scope = options.scope ?? forGym;
  return async (gymId: string, customerId: string): Promise<void> => {
    const [linked] = await scope(gymId, tx => tx.select({ id: households.id }).from(households).where(eq(households.stripeCustomerId, customerId)).limit(1));
    if (linked) { logInfo('members.erasure.redaction_skipped_linked', { gymId, householdId: linked.id }); return; }
    await redact(gymId, customerId);
    const [relinked] = await scope(gymId, tx => tx.select({ id: households.id }).from(households).where(eq(households.stripeCustomerId, customerId)).limit(1));
    if (relinked) logError('members.erasure.redaction_relinked', { gymId, householdId: relinked.id });
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: customerRedactedAction, targetType: 'gym', targetId: gymId,
      after: { stripeCustomerId: customerId }, occurredAt: options.clock.now() }));
  };
}
