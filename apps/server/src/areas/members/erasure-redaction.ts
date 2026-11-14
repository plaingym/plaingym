// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { classCreditEntries, forGym, households, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { z } from 'zod';
import type { Jobs } from '../../infra/jobs/index.js';
import type { Uploads } from '../../infra/storage/index.js';
import { logError, logInfo } from '../../core/log.js';
import { customerRedactedAction, erasuresToRedact, redactionQueuedAction } from './erasure-redaction.query.js';

/** The sole ledger update: erase free text while preserving the append-only credit history. */
export async function eraseCreditReasons(tx: Transaction, memberId: string) {
  await tx.update(classCreditEntries).set({ reason: '' })
    .where(and(eq(classCreditEntries.memberId, memberId), eq(classCreditEntries.kind, 'adjust')));
}

/** Queues the provider redaction of the customer an erased household had. */
export const redactCustomerJob = 'members.erasure.redact_customer';
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
export { customerRedactedAction, redactionQueuedAction };
/** One run queues at most this many erasures; the next daily run continues. */
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
 * (`erasuresToRedact`). Returns the number of erasures queued, at most `redactEarlierBatch`.
 */
export async function queueEarlierRedactions(options: { gymId: string; timezone: string; jobs: Pick<Jobs, 'enqueue'>; clock: Clock; scope?: typeof forGym; batch?: number }): Promise<number> {
  const { gymId, timezone, jobs, clock, scope = forGym, batch = redactEarlierBatch } = options;
  const pending = await scope(gymId, tx => erasuresToRedact(tx, gymId, batch));
  for (const { id, householdId, customerId } of pending) {
    // The job first, then the marker: no network or queue call runs inside the audit's transaction.
    await jobs.enqueue(redactCustomerJob, { customerId }, { gymId, timezone, idempotencyKey: `redact-earlier:${id}`, maxAttempts: 12 });
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: redactionQueuedAction, targetType: 'household',
      targetId: householdId, after: { stripeCustomerId: customerId, erasure: id }, occurredAt: clock.now() }));
  }
  return pending.length;
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
