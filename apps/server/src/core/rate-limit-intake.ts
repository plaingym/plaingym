// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { addDays, localDate, localMidnight } from '@plaingym/shared/time';
import type { Context } from 'hono';
import type { RequestEnvironment } from './context.js';
import { logInfo } from './log.js';
import { RateBuckets, rateLimitStore, type IntakeReservationResult, type SharedRateLimitStore } from './rate-limit.js';

export const publicIntakeLimits = {
  participants: 10_000, signatureKiB: 1024 * 1024, dailySignatureKiB: 4 * 1024 * 1024, windowMs: 3_600_000,
} as const;
/** Shared across join, trial and drop-in creation; existing admissions can always finish. */
export function createPublicIntakeCeiling(options: {
  store?: SharedRateLimitStore; participants?: number; signatureKiB?: number; dailySignatureKiB?: number;
} = {}) {
  const local = new RateBuckets(10_000, () => false), reports = new RateBuckets(1000, () => false);
  return async (input: { gymId: string; timezone: string; now: number; participants: number; signatureBytes: number }) => {
    const { gymId, now, timezone } = input, windowMs = publicIntakeLimits.windowMs;
    if (![input.participants, input.signatureBytes].every(amount => Number.isSafeInteger(amount) && amount >= 0))
      throw new Error('Invalid public intake reservation');
    const start = Math.floor(now / windowMs) * windowMs, resetAt = start + windowMs;
    const today = localDate(new Date(now), timezone), signatureKiB = Math.ceil(input.signatureBytes / 1024);
    const buckets = [
      { routeKey: 'public.intake.participants', amount: input.participants, limit: options.participants ?? publicIntakeLimits.participants, start, resetAt },
      { routeKey: 'public.intake.signature_kib', amount: signatureKiB, limit: options.signatureKiB ?? publicIntakeLimits.signatureKiB, start, resetAt },
      { routeKey: 'public.intake.signature_kib_day', amount: signatureKiB, limit: options.dailySignatureKiB ?? publicIntakeLimits.dailySignatureKiB,
        start: localMidnight(today, timezone).getTime(), resetAt: localMidnight(addDays(today, 1), timezone).getTime() },
    ].filter(bucket => bucket.amount > 0);
    if (!buckets.length) return;
    const store = options.store ?? rateLimitStore();
    const result: IntakeReservationResult = store
      ? await store.reserve?.({ gymId, now, buckets }) ?? { allowed: false, resetAt: now + 1000, failed: true }
      : (() => {
        const keys = buckets.map(bucket => `${gymId}:${bucket.routeKey}:${bucket.start}`);
        for (const [i, bucket] of buckets.entries()) {
          if ((local.get(keys[i]!, now)?.count ?? 0) + bucket.amount > bucket.limit)
            return { allowed: false, resetAt: bucket.resetAt, routeKey: bucket.routeKey };
        }
        for (const [i, bucket] of buckets.entries()) {
          const counter = local.get(keys[i]!, now) ?? local.add(keys[i]!, { count: 0, resetAt: bucket.resetAt }, now, keys);
          counter.count += bucket.amount;
        }
        return { allowed: true, resetAt };
      })();
    if (result.allowed) return;
    if (result.failed) throw new AppError('rate_limited', 'Public intake is busy', { reason: ['intake_store_failed'], resetAt: [String(now + 1000)] });
    const bucket = buckets.find(bucket => bucket.routeKey === result.routeKey)!, key = `${gymId}:${bucket.routeKey}`;
    if (!reports.get(key, now)) {
      reports.add(key, { count: 1, resetAt: result.resetAt }, now);
      logInfo('public.intake.ceiling_reached', { gymId, resource: bucket.routeKey.slice('public.intake.'.length), limit: bucket.limit, resetAt: result.resetAt });
    }
    throw new AppError('rate_limited', 'Public intake is busy', { reason: ['intake_ceiling'], resetAt: [String(result.resetAt)] });
  };
}
export const reservePublicIntake = createPublicIntakeCeiling();
/** The route supplies translated ceiling and short-retry messages. */
export function publicIntakeRefusal(error: unknown, context: Context<RequestEnvironment>, message: string, retry: string): AppError | undefined {
  if (!(error instanceof AppError) || !['intake_ceiling', 'intake_store_failed'].includes(error.details?.reason?.[0] ?? '')) return undefined;
  const failed = error.details!.reason![0] === 'intake_store_failed', resetAt = Number(error.details!.resetAt?.[0]);
  context.header('Retry-After', failed ? '1' : String(Math.max(1, Math.ceil((resetAt - context.get('context').clock.now().getTime()) / 1000))));
  return new AppError('rate_limited', failed ? retry : message, { ...error.details, reason: [failed ? 'busy' : 'intake_ceiling'] });
}
