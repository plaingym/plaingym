// SPDX-License-Identifier: AGPL-3.0-only
import { forSystem, intakeRateLimits } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Reviewed atomic counter expression; no dynamic table names or raw handles.
import { inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJobs } from '../infra/jobs/postgres.js';
import type { Clock } from './clock.js';
import { logError } from './log.js';
import { cacheRefusals, configureSharedRateLimits, type IntakeReservationResult, type SharedRateLimitStore } from './rate-limit.js';

/** Where a failed counter write goes; the log by default, at most once a minute per store. */
export type IntakeStoreReport = (error: unknown) => void;
const logStoreFailure: IntakeStoreReport = error => logError('rate_limit.intake_store_failed', {}, error);
const reportEveryMs = 60_000;
/** Throwing out of the transaction rolls back every earlier counter increment. */
class ReservationRefused extends Error {
  constructor(readonly result: IntakeReservationResult) { super('Intake reservation refused'); }
}

/**
 * One atomic upsert per request the limiter doesn't already know is refused. Saturation keeps refused traffic from
 * overflowing the counter.
 */
export function createIntakeRateLimitStore(scope: typeof forSystem = forSystem, report: IntakeStoreReport = logStoreFailure): SharedRateLimitStore {
  let reportedAt = -Infinity;
  async function failed(error: unknown, now: number) {
    // A working database with a broken counter table gets a short retry; an outage propagates.
    // eslint-disable-next-line database/system-tables -- Constant connectivity probe, independent of the counters table.
    await scope(tx => tx.execute(sql`select 1`));
    if (now - reportedAt >= reportEveryMs) {
      reportedAt = now;
      try { report(error); } catch { /* Reporting never changes the answer. */ }
    }
  }
  return {
    async reserve({ gymId, now, buckets }) {
      for (const bucket of buckets) {
        if (!Number.isSafeInteger(bucket.amount) || bucket.amount <= 0 || !Number.isSafeInteger(bucket.limit) || bucket.limit <= 0
          || !Number.isSafeInteger(bucket.start) || !Number.isSafeInteger(bucket.resetAt) || bucket.start > now || bucket.resetAt <= now)
          throw new Error('Invalid public intake reservation');
        if (bucket.amount > bucket.limit) return { allowed: false, resetAt: bucket.resetAt, routeKey: bucket.routeKey };
      }
      try {
        // Consistent order prevents competing reservations from deadlocking. A refusal rolls back the
        // entire transaction, so neither byte window nor participants can be spent independently.
        await scope(async tx => {
          for (const bucket of [...buckets].sort((a, b) => a.routeKey.localeCompare(b.routeKey))) {
            const [row] = await tx.insert(intakeRateLimits).values({ gymId, routeKey: bucket.routeKey, clientKey: '*',
              windowStart: new Date(bucket.start), expiresAt: new Date(bucket.resetAt), count: bucket.amount,
            }).onConflictDoUpdate({
              target: [intakeRateLimits.gymId, intakeRateLimits.routeKey, intakeRateLimits.clientKey, intakeRateLimits.windowStart],
              set: { count: sql`${intakeRateLimits.count} + ${bucket.amount}` },
              setWhere: lte(intakeRateLimits.count, bucket.limit - bucket.amount),
            }).returning({ id: intakeRateLimits.id });
            if (!row) throw new ReservationRefused({ allowed: false, resetAt: bucket.resetAt, routeKey: bucket.routeKey });
          }
        });
        return { allowed: true, resetAt: Math.min(...buckets.map(bucket => bucket.resetAt)) };
      } catch (error) {
        if (error instanceof ReservationRefused) return error.result;
        await failed(error, now);
        return { allowed: false, resetAt: now + 1000, failed: true };
      }
    },
    async consume({ gymId, routeKey, clientKey, now, windowMs, limit, amount }) {
      const start = Math.floor(now / windowMs) * windowMs, resetAt = start + windowMs;
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) throw new Error('Invalid reservation amount');
      if (amount !== undefined && amount > limit) return { allowed: false, resetAt };
      try {
        const [row] = await scope(tx => tx.insert(intakeRateLimits).values({
          gymId, routeKey, clientKey, windowStart: new Date(start), expiresAt: new Date(resetAt), count: amount ?? 1,
        }).onConflictDoUpdate({
          target: [intakeRateLimits.gymId, intakeRateLimits.routeKey, intakeRateLimits.clientKey, intakeRateLimits.windowStart],
          set: { count: amount === undefined ? sql`least(${intakeRateLimits.count} + 1, ${limit + 1})` : sql`${intakeRateLimits.count} + ${amount}` },
          ...(amount === undefined ? {} : { setWhere: lte(intakeRateLimits.count, limit - amount) }),
        }).returning({ count: intakeRateLimits.count }));
        return { allowed: row !== undefined && row.count <= limit, resetAt };
      } catch (error) {
        await failed(error, now);
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
