// SPDX-License-Identifier: AGPL-3.0-only
import { forSystem, intakeRateLimits } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Reviewed atomic counter expression; no dynamic table names or raw handles.
import { lte, sql } from 'drizzle-orm';
import type { PostgresJobs } from '../infra/jobs/postgres.js';
import type { Clock } from './clock.js';
import { configureSharedRateLimits, type SharedRateLimitStore } from './rate-limit.js';

/** One atomic upsert per request. Saturation keeps refused traffic from overflowing the counter. */
export function createIntakeRateLimitStore(scope: typeof forSystem = forSystem): SharedRateLimitStore {
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
      } catch {
        // Distinguish a counter write failure from a database outage. If this read also fails,
        // propagate it to the ordinary request error handler instead of disguising an outage as 429.
        // eslint-disable-next-line database/system-tables -- Constant connectivity probe, independent of the counters table.
        await scope(tx => tx.execute(sql`select 1`));
        return { allowed: false, resetAt };
      }
    },
  };
}

export async function sweepIntakeRateLimits(now: Date, scope: typeof forSystem = forSystem): Promise<void> {
  await scope(async tx => { await tx.delete(intakeRateLimits).where(lte(intakeRateLimits.expiresAt, now)); });
}

export const intakeRateLimitSweepJob = 'intake-rate-limits.sweep';
const dayMs = 24 * 60 * 60 * 1000;
/**
 * Register once at runtime startup, after database initialization and before serving requests. Counters are
 * install-wide, including those with no gym, so the sweep is one system job rather than a schedule run for each gym.
 */
export function registerIntakeRateLimits(queue: Pick<PostgresJobs, 'handleSystem' | 'enqueueSystem'>, clock: Clock,
  scope: typeof forSystem = forSystem) {
  queue.handleSystem(intakeRateLimitSweepJob, async (_payload, context) => {
    await sweepIntakeRateLimits(context.clock.now(), scope);
  });
  return {
    /** Stops database counting; call during shutdown. */
    reset: configureSharedRateLimits(createIntakeRateLimitStore(scope)),
    /** Call once a minute or so. The day's idempotency key collapses repeated calls and competing processes into one run. */
    async scheduleDue(): Promise<void> {
      const day = new Date(Math.floor(clock.now().getTime() / dayMs) * dayMs);
      await queue.enqueueSystem(intakeRateLimitSweepJob, {}, { timezone: 'UTC', runAt: day,
        idempotencyKey: 'sweep:' + day.toISOString(), maxAttempts: 3 });
    },
  };
}
