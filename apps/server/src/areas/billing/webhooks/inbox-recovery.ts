// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, isNotNull, isNull, notExists, type SQL, type SQLWrapper } from 'drizzle-orm';
import { auditEvents, forGym, stripeEvents, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../../core/clock.js';
import { logError } from '../../../core/log.js';
import { withJobTransaction, type JobRecovery } from '../../../infra/jobs/index.js';

/** Audited by every dispatch reset, from this sweep or a redelivery; the sweep's limit counts both. */
export const webhookDispatchRetried = 'billing.webhook.dispatch_retried';
export const webhookDispatchRecoveryExhausted = 'billing.webhook.dispatch_recovery_exhausted';
export const webhookRecoveryDelayMs = 15 * 60_000, webhookRecoveryLimit = 5;

function dispatchAudits(tx: Transaction, gymId: string, action: string, eventId: string | SQLWrapper) {
  return tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, action), eq(auditEvents.targetId, eventId)));
}

export function webhookRecoveryPage(tx: Transaction, gymId: string, cursor?: string) {
  // Keep the predicates separate so each branch can use its own partial index.
  const events = (marker: SQL) => tx.select({ id: stripeEvents.id }).from(stripeEvents).where(and(
    eq(stripeEvents.gymId, gymId), isNull(stripeEvents.processedAt), marker,
    cursor ? gt(stripeEvents.id, cursor) : undefined));
  const candidates = events(isNotNull(stripeEvents.error)).unionAll(events(isNull(stripeEvents.error))).as('candidates');
  return tx.select({ id: candidates.id }).from(candidates)
    .where(notExists(dispatchAudits(tx, gymId, webhookDispatchRecoveryExhausted, candidates.id)))
    .orderBy(asc(candidates.id)).limit(100);
}

/** Reset the original dispatch (`job`), never a replay or a newly enqueued copy. */
export function createWebhookInboxRecovery(options: { job: string; scope?: typeof forGym; clock?: Clock; recovery?: JobRecovery }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return async (gymId: string) => {
    const recovery = options.recovery;
    let recovered = 0, exhausted = 0, cursor: string | undefined;
    if (!recovery) return { recovered, exhausted };
    for (;;) {
      const rows = await scope(gymId, tx => webhookRecoveryPage(tx, gymId, cursor));
      if (!rows.length) break;
      for (const job of await recovery.failedJobs(options.job, rows.map(row => row.id), { gymId })) {
        const eventId = job.idempotencyKey;
        try {
          const outcome = await withJobTransaction(scope, gymId, async transaction => {
            const { tx } = transaction;
            const event = and(eq(stripeEvents.gymId, gymId), eq(stripeEvents.id, eventId), isNull(stripeEvents.processedAt));
            // Serialize sweeps of this event and recheck the audit after acquiring the row lock.
            const [row] = await tx.select({ error: stripeEvents.error, failedAt: stripeEvents.failedAt }).from(stripeEvents)
              .where(event).for('update');
            if (!row || (await dispatchAudits(tx, gymId, webhookDispatchRecoveryExhausted, eventId).limit(1)).length) return;
            const [current] = await recovery.failedJobs(options.job, [eventId], { gymId }, transaction);
            if (!current) return;
            // Health can now count a failed dispatch whose attempts never recorded a handler error, from when its job
            // failed; the sweep's own marker follows the job's latest failure after a reset.
            if (row.error === null || (row.error === 'dispatch_failed' && (!row.failedAt || row.failedAt < current.failedAt)))
              await tx.update(stripeEvents).set({ error: 'dispatch_failed', failedAt: current.failedAt }).where(event);
            const history = await dispatchAudits(tx, gymId, webhookDispatchRetried, eventId).limit(webhookRecoveryLimit);
            const now = clock.now();
            if (history.length >= webhookRecoveryLimit) {
              await writeAudit(tx, { gymId, actorKind: 'system', action: webhookDispatchRecoveryExhausted, targetType: 'stripe_event',
                targetId: eventId, after: { jobId: current.jobId, resets: history.length }, occurredAt: now });
              return 'exhausted';
            }
            const delayMs = webhookRecoveryDelayMs * 2 ** history.length;
            if (now.getTime() - current.failedAt.getTime() < delayMs) return;
            if (!await recovery.retryFailed(current.jobId, { gymId, runAt: now }, transaction)) return;
            await writeAudit(tx, { gymId, actorKind: 'system', action: webhookDispatchRetried, targetType: 'stripe_event',
              targetId: eventId, after: { jobId: current.jobId, delayMs }, occurredAt: now });
            return 'recovered';
          });
          if (outcome === 'exhausted') exhausted++;
          if (outcome === 'recovered') recovered++;
        } catch (error) {
          logError('billing.webhook.recovery_failed', { gymId, eventId, jobId: job.jobId }, error);
        }
      }
      cursor = rows.at(-1)!.id;
    }
    return { recovered, exhausted };
  };
}
