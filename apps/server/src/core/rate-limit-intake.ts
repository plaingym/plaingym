// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import type { Context } from 'hono';
import type { RequestEnvironment } from './context.js';
import { logInfo } from './log.js';
import { RateBuckets, rateLimitStore, type SharedRateLimitStore } from './rate-limit.js';

export const publicIntakeLimits = { participants: 10_000, signatureKiB: 8 * 1024 * 1024, windowMs: 3_600_000 } as const;
/** Shared across join, trial and drop-in creation; existing admissions can always finish. */
export function createPublicIntakeCeiling(options: { store?: SharedRateLimitStore; participants?: number; signatureKiB?: number } = {}) {
  const local = new RateBuckets(10_000, () => false), reports = new RateBuckets(1000, () => false);
  return async (input: { gymId: string; now: number; participants: number; signatureBytes: number }) => {
    const { gymId, now } = input, windowMs = publicIntakeLimits.windowMs;
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
    const store = options.store ?? rateLimitStore();
    for (const [resource, amount, limit] of [
      ['participants', input.participants, options.participants ?? publicIntakeLimits.participants],
      ['signature_kib', Math.ceil(input.signatureBytes / 1024), options.signatureKiB ?? publicIntakeLimits.signatureKiB],
    ] as const) {
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid public intake reservation');
      if (!amount) continue;
      const routeKey = `public.intake.${resource}`, key = `${gymId}:${routeKey}`;
      const result: Awaited<ReturnType<SharedRateLimitStore['consume']>> = store ? await store.consume({ gymId, routeKey, clientKey: '*', now, windowMs, limit, amount }) : (() => {
        const bucket = local.get(key, now) ?? local.add(key, { count: 0, resetAt }, now);
        if (bucket.count + amount > limit) return { allowed: false, resetAt };
        bucket.count += amount;
        return { allowed: true, resetAt };
      })();
      if (result.allowed) continue;
      if (!result.failed && !reports.get(key, now)) {
        reports.add(key, { count: 1, resetAt: result.resetAt }, now);
        logInfo('public.intake.ceiling_reached', { gymId, resource, limit, resetAt: result.resetAt });
      }
      throw new AppError('rate_limited', 'Public intake is busy', { reason: ['intake_ceiling'], resetAt: [String(result.resetAt)] });
    }
  };
}
export const reservePublicIntake = createPublicIntakeCeiling();
/** The route supplies its own translated refusal and the window's retry header. */
export function publicIntakeRefusal(error: unknown, context: Context<RequestEnvironment>, message: string): AppError | undefined {
  if (!(error instanceof AppError) || error.details?.reason?.[0] !== 'intake_ceiling') return undefined;
  const resetAt = Number(error.details.resetAt?.[0]);
  context.header('Retry-After', String(Math.max(1, Math.ceil((resetAt - context.get('context').clock.now().getTime()) / 1000))));
  return new AppError('rate_limited', message, error.details);
}
