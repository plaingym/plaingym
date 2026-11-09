// SPDX-License-Identifier: AGPL-3.0-only
import { forSystem, intakeRateLimits } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Reviewed atomic counter expression; no dynamic table names or raw handles.
import { inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJobs } from '../infra/jobs/postgres.js';
import type { Clock } from './clock.js';
import { logError } from './log.js';
import { cacheRefusals, configureSharedRateLimits, type SharedRateLimitStore } from './rate-limit.js';

/** Where a failed counter write goes; the log by default, at most once a minute per store. */
export type IntakeStoreReport = (error: unknown) => void;
const logStoreFailure: IntakeStoreReport = error => logError('rate_limit.intake_store_failed', {}, error);
const reportEveryMs = 60_000;

/**
 * One atomic upsert per request the limiter doesn't already know is refused. Saturation keeps refused traffic from
 * overflowing the counter.
 */
export function createIntakeRateLimitStore(scope: typeof forSystem = forSystem, report: IntakeStoreReport = logStoreFailure): SharedRateLimitStore {
  let reportedAt = -Infinity;
  return {
    async consume({ gymId, routeKey, clientKey, now, windowMs, limit }) {
      const start = Math.floor(now / windowMs) * windowMs, resetAt = start + windowMs;
      try {
        const [row] = await scope(tx => tx.insert(intakeRateLimits).values({
          gymId, routeKey, clientKey, windowStart: new Date(start), expiresAt: new Date(resetAt), count: 1,
        }).onConflictDoUpdate({
          target: [intakeRateLimits.gymId, intakeRateLimits.routeKey, intakeRateLimits.clientKey, intakeRateLimits.windowStart],
          set: { count: sql`least(${intakeRateLimits.count} + 1, ${limit + 1})` },
        }).returning({ count: intakeRateLimits.count }));
        return { allowed: row !== undefined && row.count <= limit, resetAt };
      } catch (error) {
        // Distinguish a counter write failure from a database outage. If this read also fails,
        // propagate it to the ordinary request error handler instead of disguising an outage as 429.
        // eslint-disable-next-line database/system-tables -- Constant connectivity probe, independent of the counters table.
        await scope(tx => tx.execute(sql`select 1`));
        // The database answers, so the counters themselves failed: refuse, but say so, since it looks like rate limiting.
        if (now - reportedAt >= reportEveryMs) {
          reportedAt = now;
          try { report(error); } catch { /* Reporting never changes the answer. */ }
        }
        return { allowed: false, resetAt, failed: true };
      }
    },
  };
}

/** Deletes ended windows in short transactions of at most `batchSize` rows; returns how many went. */
export async function sweepIntakeRateLimits(now: Date, scope: typeof forSystem = forSystem, batchSize = 5000): Promise<number> {
  let removed = 0;
  for (;;) {
    const batch = await scope(tx => tx.delete(intakeRateLimits).where(inArray(intakeRateLimits.id,
      tx.select({ id: intakeRateLimits.id }).from(intakeRateLimits).where(lte(intakeRateLimits.expiresAt, now)).limit(batchSize)))
      .returning({ id: intakeRateLimits.id }));
    removed += batch.length;
    if (batch.length < batchSize) return removed;
  }
}

export const intakeRateLimitSweepJob = 'intake-rate-limits.sweep';
const hourMs = 60 * 60 * 1000;
/**
 * Register once at runtime startup, after database initialization and before serving requests. Counters are
 * install-wide, including those with no gym, so the sweep is one system job rather than a schedule run for each gym.
 * It runs hourly, so a flood of new client keys leaves at most about an hour of ended windows behind.
 */
export function registerIntakeRateLimits(queue: Pick<PostgresJobs, 'handleSystem' | 'enqueueSystem'>, clock: Clock,
  scope: typeof forSystem = forSystem) {
  queue.handleSystem(intakeRateLimitSweepJob, async (_payload, context) => {
    await sweepIntakeRateLimits(context.clock.now(), scope);
  });
  return {
    /** Stops database counting; call during shutdown. */
    reset: configureSharedRateLimits(cacheRefusals(createIntakeRateLimitStore(scope))),
    /** Call once a minute or so. The hour's idempotency key collapses repeated calls and competing processes into one run. */
    async scheduleDue(): Promise<void> {
      const hour = new Date(Math.floor(clock.now().getTime() / hourMs) * hourMs);
      await queue.enqueueSystem(intakeRateLimitSweepJob, {}, { timezone: 'UTC', runAt: hour,
        idempotencyKey: 'sweep:' + hour.toISOString(), maxAttempts: 3 });
    },
  };
}
