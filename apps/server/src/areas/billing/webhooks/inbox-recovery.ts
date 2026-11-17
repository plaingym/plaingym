// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { auditEvents, forGym, stripeEvents, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../../core/clock.js';
import { logError } from '../../../core/log.js';
import type { JobRecovery } from '../../../infra/jobs/index.js';

/** Audited by every dispatch reset, from this sweep or a redelivery; the sweep's limit counts both. */
export const webhookDispatchRetried = 'billing.webhook.dispatch_retried';
export const webhookRecoveryDelayMs = 15 * 60_000, webhookRecoveryLimit = 5;

/** Reset the original dispatch (`job`), never a replay or a newly enqueued copy. */
export function createWebhookInboxRecovery(options: { job: string; scope?: typeof forGym; clock?: Clock; recovery?: JobRecovery }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return async (gymId: string) => {
    const recovery = options.recovery;
    let recovered = 0, exhausted = 0, cursor: string | undefined;
    if (!recovery) return { recovered, exhausted };
    for (;;) {
      const rows = await scope(gymId, tx => tx.select({ id: stripeEvents.id }).from(stripeEvents).where(and(
        eq(stripeEvents.gymId, gymId), isNull(stripeEvents.processedAt), isNotNull(stripeEvents.error),
        cursor ? gt(stripeEvents.id, cursor) : undefined)).orderBy(asc(stripeEvents.id)).limit(100));
      if (!rows.length) break;
      for (const job of await recovery.failedJobs(options.job,rows.map(row => row.id), { gymId })) {
        const eventId = job.idempotencyKey;
        try {
          const history = await scope(gymId, tx => tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
            eq(auditEvents.action, webhookDispatchRetried), eq(auditEvents.targetId, eventId))).limit(webhookRecoveryLimit));
          if (history.length >= webhookRecoveryLimit) { exhausted++; continue; }
          const now = clock.now(), delayMs = webhookRecoveryDelayMs * 2 ** history.length;
          if (now.getTime() - job.failedAt.getTime() < delayMs) continue;
          if (!await recovery.retryFailed(job.jobId, { gymId, runAt: now })) continue;
          await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: webhookDispatchRetried,
            targetType: 'stripe_event', targetId: eventId, after: { jobId: job.jobId, delayMs }, occurredAt: now }));
          recovered++;
        } catch (error) {
          logError('billing.webhook.recovery_failed', { gymId, eventId, jobId: job.jobId }, error);
        }
      }
      cursor = rows.at(-1)!.id;
    }
    return { recovered, exhausted };
  };
}
