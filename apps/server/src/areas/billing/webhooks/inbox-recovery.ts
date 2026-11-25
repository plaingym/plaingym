// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, exists, gt, gte, inArray, isNotNull, isNull, max, not, notExists, or, type SQL, type SQLWrapper } from 'drizzle-orm';
import { auditEvents, forGym, stripeEvents, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../../core/clock.js';
import { logError } from '../../../core/log.js';
import { withJobTransaction, type JobRecovery } from '../../../infra/jobs/index.js';

/** Audited by every dispatch reset, from this sweep or a redelivery; the sweep's limit counts both. */
export const webhookDispatchRetried = 'billing.webhook.dispatch_retried';
export const webhookDispatchRecoveryExhausted = 'billing.webhook.dispatch_recovery_exhausted';
export const webhookRecoveryDelayMs = 15 * 60_000, webhookRecoveryLimit = 5;

type EventId = string | SQLWrapper;

function dispatchAudits(tx: Transaction, gymId: string, action: string, eventId: EventId, condition?: SQL) {
  return tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, action), eq(auditEvents.targetId, eventId), condition));
}

/** The time of the event's latest exhaustion audit; null before the first one. */
function latestExhaustion(tx: Transaction, gymId: string, eventId: EventId) {
  return tx.select({ at: max(auditEvents.occurredAt) }).from(auditEvents).where(and(eq(auditEvents.gymId, gymId),
    eq(auditEvents.action, webhookDispatchRecoveryExhausted), eq(auditEvents.targetId, eventId)));
}

/** True for an audit row at or after the event's latest exhaustion audit, and for every row while it has none. */
function sinceExhaustion(tx: Transaction, gymId: string, eventId: EventId): SQL {
  return or(notExists(dispatchAudits(tx, gymId, webhookDispatchRecoveryExhausted, eventId)),
    gte(auditEvents.occurredAt, latestExhaustion(tx, gymId, eventId)))!;
}

/** Automatic recovery is closed once an exhaustion audit has no reset at or after it; a redelivery's reset reopens it. */
export function closedEvent(tx: Transaction, gymId: string, eventId: EventId): SQL {
  return and(exists(dispatchAudits(tx, gymId, webhookDispatchRecoveryExhausted, eventId)),
    notExists(dispatchAudits(tx, gymId, webhookDispatchRetried, eventId,
      gte(auditEvents.occurredAt, latestExhaustion(tx, gymId, eventId)))))!;
}

/** The resets the limit counts: those at or after the latest exhaustion audit, or all of them before the first one. */
function resetsSinceExhaustion(tx: Transaction, gymId: string, eventId: string) {
  return dispatchAudits(tx, gymId, webhookDispatchRetried, eventId, sinceExhaustion(tx, gymId, eventId)).limit(webhookRecoveryLimit);
}

export function webhookRecoveryPage(tx: Transaction, gymId: string, cursor?: string) {
  // Keep the predicates separate so each branch can use its own partial index.
  const events = (marker: SQL) => tx.select({ id: stripeEvents.id }).from(stripeEvents).where(and(
    eq(stripeEvents.gymId, gymId), isNull(stripeEvents.processedAt), marker,
    cursor ? gt(stripeEvents.id, cursor) : undefined));
  const candidates = events(isNotNull(stripeEvents.error)).unionAll(events(isNull(stripeEvents.error))).as('candidates');
  return tx.select({ id: candidates.id }).from(candidates)
    .where(not(closedEvent(tx, gymId, candidates.id)))
    .orderBy(asc(candidates.id)).limit(100);
}

/** Unlocked read of the open, unprocessed events among `eventIds`: their marker and the resets since exhaustion. */
function openEvents(tx: Transaction, gymId: string, eventIds: string[]) {
  return tx.select({ id: stripeEvents.id, error: stripeEvents.error, failedAt: stripeEvents.failedAt, resets: count(auditEvents.id) })
    .from(stripeEvents)
    .leftJoin(auditEvents, and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, webhookDispatchRetried),
      eq(auditEvents.targetId, stripeEvents.id), sinceExhaustion(tx, gymId, stripeEvents.id)))
    .where(and(eq(stripeEvents.gymId, gymId), inArray(stripeEvents.id, eventIds), isNull(stripeEvents.processedAt),
      not(closedEvent(tx, gymId, stripeEvents.id))))
    .groupBy(stripeEvents.id, stripeEvents.error, stripeEvents.failedAt);
}

// Health can count a failed dispatch whose attempts never recorded a handler error, from when its job failed;
// an existing marker's failure time also follows the job's latest failure after a reset, keeping its marker kind.
function markerUpdate(row: { error: string | null; failedAt: Date | null }, failedAt: Date): 'dispatch_failed' | 'failed_at' | null {
  if (row.error === null) return 'dispatch_failed';
  if (!row.failedAt || row.failedAt < failedAt) {
    if (row.error === 'dispatch_failed') return 'dispatch_failed';
    if (row.error === 'handler_failed') return 'failed_at';
  }
  return null;
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
      cursor = rows.at(-1)!.id;
      const failed = await recovery.failedJobs(options.job, rows.map(row => row.id), { gymId });
      if (!failed.length) continue;
      // Decide the cooldown without a lock; only an event the sweep may mark, reset or close goes on to the locked step.
      let open: Map<string, Awaited<ReturnType<typeof openEvents>>[number]>;
      try {
        open = new Map((await scope(gymId, tx => openEvents(tx, gymId, failed.map(job => job.idempotencyKey))))
          .map(row => [row.id, row]));
      } catch (error) {
        logError('billing.webhook.recovery_failed', { gymId }, error);
        continue;
      }
      const checkedAt = clock.now().getTime();
      for (const job of failed) {
        const eventId = job.idempotencyKey, seen = open.get(eventId);
        if (!seen) continue;
        const resets = Math.min(seen.resets, webhookRecoveryLimit);
        if (!markerUpdate(seen, job.failedAt) && resets < webhookRecoveryLimit
          && checkedAt - job.failedAt.getTime() < webhookRecoveryDelayMs * 2 ** resets) continue;
        try {
          const outcome = await withJobTransaction(scope, gymId, async transaction => {
            const { tx } = transaction;
            const event = and(eq(stripeEvents.gymId, gymId), eq(stripeEvents.id, eventId), isNull(stripeEvents.processedAt));
            // Serialize sweeps of this event, then recheck in a new statement that sees what they committed.
            const [row] = await tx.select({ error: stripeEvents.error, failedAt: stripeEvents.failedAt }).from(stripeEvents)
              .where(event).for('update');
            if (!row || (await tx.select({ id: stripeEvents.id }).from(stripeEvents)
              .where(and(event, closedEvent(tx, gymId, eventId)))).length) return;
            // Take the time before reading the job: a redelivery that resets it after this read audits its reset no
            // earlier on the same clock, so an exhaustion audit written here doesn't hide that reopening reset.
            const now = clock.now();
            const [current] = await recovery.failedJobs(options.job, [eventId], { gymId }, transaction);
            if (!current) return;
            const update = markerUpdate(row, current.failedAt);
            if (update === 'dispatch_failed')
              await tx.update(stripeEvents).set({ error: 'dispatch_failed', failedAt: current.failedAt }).where(event);
            else if (update === 'failed_at')
              await tx.update(stripeEvents).set({ failedAt: current.failedAt }).where(event);
            const resets = (await resetsSinceExhaustion(tx, gymId, eventId)).length;
            if (resets >= webhookRecoveryLimit) {
              await writeAudit(tx, { gymId, actorKind: 'system', action: webhookDispatchRecoveryExhausted, targetType: 'stripe_event',
                targetId: eventId, after: { jobId: current.jobId, resets }, occurredAt: now });
              return 'exhausted';
            }
            const delayMs = webhookRecoveryDelayMs * 2 ** resets;
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
    }
    return { recovered, exhausted };
  };
}
