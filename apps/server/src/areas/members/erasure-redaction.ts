// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { auditEvents, classCreditEntries, forGym, households, paymentMethods, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { z } from 'zod';
import { withJobTransaction, type JobRecovery, type Jobs } from '../../infra/jobs/index.js';
import type { Uploads } from '../../infra/storage/index.js';
import { billingEmailKeyId, type ClearCustomerEmail, type ClearedCustomerEmail } from '../../infra/payments/index.js';
import { detachJob } from '../billing/payments.mutations.js';
import { logError, logInfo } from '../../core/log.js';
import { billingEmailAbandonedAction, billingEmailClearedAction, billingEmailErasuresToRetry, billingEmailMissingAction, billingEmailNoMatchAction, billingEmailQueuedAction, billingEmailResets, billingEmailResetAction, billingEmailSkippedAction, customerRedactedAction, erasuresToRedact, lockBillingEmailErasure, redactionQueuedAction } from './erasure-redaction.query.js';

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
  keyId: z.string().regex(/^[a-f0-9]{16}$/).optional(), // The key the digest was made with; older jobs carry none.
  paymentMethodIds: z.array(z.string().regex(/^(?:pm|card|ba|src)_[A-Za-z0-9_]+$/)).optional(),
  paymentMethodId: z.string().regex(/^(?:pm|card|ba|src)_[A-Za-z0-9_]+$/).optional() }); // Imported cards and already queued jobs keep legacy IDs.
export type ClearBillingEmail = (gymId: string, customerId: string, options: ClearCustomerEmail) => Promise<ClearedCustomerEmail>;

/** The outcome audits (cleared, no match, skipped) already recorded on the household for one erasure. */
async function erasureOutcomes(tx: Transaction, gymId: string, householdId: string, erasureId: string): Promise<ReadonlySet<string>> {
  const rows = await tx.select({ action: auditEvents.action, after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, householdId),
      inArray(auditEvents.action, [billingEmailClearedAction, billingEmailNoMatchAction, billingEmailSkippedAction])));
  return new Set(rows.filter(row => (row.after as { erasure?: unknown } | null)?.erasure === erasureId).map(row => row.action));
}

const retiredReason = 'notice_email_erased';
/** Whether this erasure already retired one of the household's bank accounts: its revocation audit names the erasure. */
async function erasureRetired(tx: Transaction, gymId: string, householdId: string, erasureId: string): Promise<boolean> {
  const rows = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'billing.card.revoked'), eq(auditEvents.targetType, 'payment_method'),
      inArray(auditEvents.targetId, tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.householdId, householdId)))));
  return rows.some(row => {
    const after = row.after as { reason?: unknown; erasure?: unknown } | null;
    return after?.reason === retiredReason && after.erasure === erasureId;
  });
}

/**
 * Recheck the local customer link before calling out; a reassigned customer is left alone. A method the clear leaves
 * holding the placeholder email (the processor won't leave it blank) has no notice address for the household's debits:
 * its local row is revoked, audited and queued for a plain detach, so no new charge attempt selects it (a charge the
 * runner already released for confirmation can still confirm once). When the clear reports a method it couldn't write,
 * the retirements still commit, no outcome audit is written, and the call throws so the job retries. With an erasure ID,
 * a run after the erasure's cleared or skipped outcome is recorded writes nothing, and each outcome is recorded once:
 * the skip and the provider result both take the erasure's lock and reread its outcomes before writing, and a skip is
 * written only while the erasure has no outcome. A revocation names the erasure, so a retry that finds nothing left to
 * clear after the retired account was detached still records the erasure as cleared.
 */
export async function clearErasedBillingEmail(payload: unknown, gymId: string, clear: ClearBillingEmail,
  config: { secret: string; clock: Clock; timezone: string; jobs?: Pick<Jobs, 'enqueue'> | undefined; scope?: typeof forGym }): Promise<void> {
  const { customerId, erasureId, keyId, ...options } = billingEmailPayload.parse(payload);
  if (options.emailDigest.startsWith('k1:') && !config.secret) throw new Error('Billing email erasure is not configured');
  const jobs = config.jobs;
  if (!jobs) throw new Error('Billing email erasure is not configured');
  const scope = config.scope ?? forGym;
  // A replay of an erasure whose outcome is already recorded (its job ran again after committing) changes nothing.
  const settled = (recorded: ReadonlySet<string>) => recorded.has(billingEmailClearedAction) || recorded.has(billingEmailSkippedAction);
  if (erasureId && settled(await scope(gymId, tx => erasureOutcomes(tx, gymId, options.householdId, erasureId)))) {
    logInfo('members.erasure.billing_email_replayed', { gymId, householdId: options.householdId });
    return;
  }
  const linked = await scope(gymId, tx => tx.select({ id: households.id }).from(households)
    .where(eq(households.stripeCustomerId, customerId)));
  if (linked.length !== 1 || linked[0]!.id !== options.householdId) {
    logInfo('members.erasure.billing_email_skipped_linked', { gymId, householdId: options.householdId });
    await scope(gymId, async tx => {
      // An overlapping attempt of the same erasure may have recorded an outcome since the check above: under the
      // erasure's lock, the skip is written only while the erasure has none. A legacy payload records one per run.
      if (erasureId) {
        await lockBillingEmailErasure(tx, gymId, erasureId);
        if ((await erasureOutcomes(tx, gymId, options.householdId, erasureId)).size > 0) return;
      }
      await writeAudit(tx, { gymId, actorKind: 'system', action: billingEmailSkippedAction,
        targetType: 'household', targetId: options.householdId, after: { stripeCustomerId: customerId, ...(erasureId ? { erasure: erasureId } : {}) },
        occurredAt: config.clock.now() });
    });
    return;
  }
  // A digest made under an earlier install secret matches nothing now, so a placeholder method alone would certify an
  // erasure while another method still holds the address. Such a run calls nothing and records nothing; the job retries
  // until the earlier secret is back or the sweep abandons it.
  if (keyId !== undefined && keyId !== billingEmailKeyId(config.secret)) {
    logError('members.erasure.billing_email_key_changed', { gymId, householdId: options.householdId, ...(erasureId ? { erasureId } : {}) });
    throw new Error('Billing email erasure key changed');
  }
  const { matched, placeholderMethods, failedMethods } = await clear(gymId, customerId, { ...options, secret: config.secret });
  const complete = failedMethods.length === 0;
  // One transaction for the outcome: the retirements and the household's outcome audit commit or roll back together, so
  // recovery keeps retrying the erasure until both have. With a failed method no outcome audit is written, but the
  // retirements commit and the job then fails, so its retry writes only the methods still left.
  if (placeholderMethods.length > 0 || complete) await withJobTransaction(scope, gymId, async transaction => {
    const { tx } = transaction;
    // The erasure's lock first (the skip takes it too), then the household before its methods, as staff default changes
    // lock them.
    if (erasureId) await lockBillingEmailErasure(tx, gymId, erasureId);
    await tx.select({ id: households.id }).from(households).where(eq(households.id, options.householdId)).for('update');
    const recorded = erasureId ? await erasureOutcomes(tx, gymId, options.householdId, erasureId) : new Set<string>();
    if (settled(recorded)) return;
    // A bank account holding the placeholder email holds no erased address: when a run that wrote it rolled back (a
    // failed detach enqueue, say), its recovery finds nothing left to match, and the erasure is still cleared. So is
    // one whose retirement for this erasure committed earlier: once its detach has run, the provider no longer lists it.
    const cleared = matched || placeholderMethods.length > 0
      || (complete && erasureId !== undefined && await erasureRetired(tx, gymId, options.householdId, erasureId));
    const outcome = cleared ? billingEmailClearedAction : billingEmailNoMatchAction;
    if (placeholderMethods.length > 0) {
      // Only this household's unrevoked rows: a retry finds them revoked, and the detach key queues no second job.
      const rows = await tx.select({ id: paymentMethods.id }).from(paymentMethods)
        .where(and(eq(paymentMethods.householdId, options.householdId), inArray(paymentMethods.processorId, [...placeholderMethods]),
          isNull(paymentMethods.revokedAt))).orderBy(paymentMethods.id).for('update');
      for (const row of rows) {
        const now = config.clock.now();
        await tx.update(paymentMethods).set({ revokedAt: now, isDefault: false }).where(eq(paymentMethods.id, row.id));
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.card.revoked', targetType: 'payment_method', targetId: row.id,
          after: { reason: retiredReason, ...(erasureId ? { erasure: erasureId } : {}) }, occurredAt: now });
        // A plain detach, like a staff removal: the method's name may be a surviving payer's.
        await jobs.enqueue(detachJob, { paymentMethodId: row.id },
          { gymId, timezone: config.timezone, idempotencyKey: `detach:${row.id}`, maxAttempts: 12 }, transaction);
      }
    }
    // An erasure records each outcome once; a legacy payload (no erasure ID) records one per run.
    if (complete && !recorded.has(outcome)) await writeAudit(tx, { gymId, actorKind: 'system', action: outcome,
      targetType: 'household', targetId: options.householdId, after: { stripeCustomerId: customerId, ...(erasureId ? { erasure: erasureId } : {}) },
      occurredAt: config.clock.now() });
  });
  if (!complete) {
    logError('members.erasure.billing_email_incomplete', { gymId, householdId: options.householdId, failed: failedMethods.length });
    throw new Error('Billing email erasure incomplete');
  }
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
/** At most four extra sets of queue attempts, after exponentially increasing delays from the final failure. */
export const billingEmailMaxResets = 4;
export const billingEmailResetDelayMs = 24 * 60 * 60_000;

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
 * (`erasuresToRedact`). Also resets exhausted billing email clears through JobRecovery, with a durable cap and backoff.
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
      const markers = new Map(emails.map(row => [`clear-billing-email:${row.erasureId}`, row]));
      const keys = [...markers.keys()];
      if (jobs.existingJobs) {
        const existing = new Set(await jobs.existingJobs(clearBillingEmailJob, keys, { gymId }));
        for (const [key, marker] of markers) if (!existing.has(key)) await scope(gymId, tx => writeAudit(tx, {
          gymId, actorKind: 'system', action: billingEmailMissingAction, targetType: 'household', targetId: marker.householdId,
          after: { erasure: marker.erasureId }, occurredAt: clock.now() }));
      }
      const failed = await jobs.failedJobs(clearBillingEmailJob, keys, { gymId });
      for (const job of failed) {
        const marker = markers.get(job.idempotencyKey)!;
        const history = await scope(gymId, tx => billingEmailResets(tx, gymId, marker.id, billingEmailMaxResets));
        const now = clock.now(), delay = billingEmailResetDelayMs * 2 ** history.length;
        if (history.length >= billingEmailMaxResets) {
          await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: billingEmailAbandonedAction,
            targetType: 'audit_event', targetId: marker.id, after: { erasure: marker.erasureId, jobId: job.jobId }, occurredAt: now }));
          // The erased address may still be at the provider, and nothing retries it again: tell the operator.
          logError(billingEmailAbandonedAction, { gymId, householdId: marker.householdId, erasureId: marker.erasureId, jobId: job.jobId });
          continue;
        }
        if (now.getTime() - job.failedAt.getTime() < delay) continue;
        if (!await jobs.retryFailed(job.jobId, { gymId, runAt: now })) continue;
        await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: billingEmailResetAction,
          targetType: 'audit_event', targetId: marker.id, after: { erasure: marker.erasureId, jobId: job.jobId, delayMs: delay }, occurredAt: now }));
        if (++retried >= batch) break;
      }
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
