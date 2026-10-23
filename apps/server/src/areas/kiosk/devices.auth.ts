// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { kioskContracts } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { clientIp, type ClientIpOptions } from '../../core/rate-limit.js';
import { createKioskDeviceService } from './devices.js';

const checkins = [kioskContracts.lookup, kioskContracts.checkinNamePin, kioskContracts.checkinQr];
const pinPaths = new Set<string>([kioskContracts.lookup.path, kioskContracts.checkinNamePin.path]);
const pinAttempts = new WeakMap<Request, { verified: boolean }>();
/** Called only after the check-in service verifies the household's name and PIN. */
export function markKioskPinVerified(request: Request): void {
  const attempt = pinAttempts.get(request);
  if (attempt) attempt.verified = true;
}
export interface KioskAuthOptions extends ClientIpOptions {
  readonly service?: ReturnType<typeof createKioskDeviceService>;
  /** Wrap the existing session middleware: it must not overwrite a kiosk principal. */
  readonly session?: MiddlewareHandler<RequestEnvironment>;
  readonly pinLimit?: number;
  readonly windowMs?: number;
  readonly maxBuckets?: number;
}

/** Mount after gym resolution. Only exact check-in POSTs accept a kiosk bearer. */
export function createKioskAuthMiddleware(options: KioskAuthOptions = {}): MiddlewareHandler<RequestEnvironment> {
  const service = options.service ?? createKioskDeviceService();
  const limit = options.pinLimit ?? 10, windowMs = options.windowMs ?? 60_000, maxBuckets = options.maxBuckets ?? 10_000;
  for (const value of [limit, windowMs, maxBuckets])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Kiosk rate limit settings must be positive integers');
  // Process-local limits are independent for device and client address; neither can bypass the other.
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (authorization === undefined) return options.session ? options.session(c, next) : next();
    if (!checkins.some((contract) => contract.method.toUpperCase() === c.req.method && contract.path === c.req.path))
      throw new AppError('not_found', 'Not found');
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) throw new AppError('not_found', 'Device not found');
    const current = c.get('context');
    const principal = await service.authenticate(current.gym.gymId, match[1]!);
    c.set('context', { ...current, principal });
    c.header('Cache-Control', 'no-store');
    if (pinPaths.has(c.req.path)) {
      const now = current.clock.now().getTime();
      const keys = [JSON.stringify([principal.gymId, 'device', principal.deviceId]),
        JSON.stringify([principal.gymId, 'address', clientIp(c, options)])];
      for (const key of keys) {
        const bucket = buckets.get(key);
        if (bucket && bucket.resetAt <= now) buckets.delete(key);
      }
      if (buckets.size + keys.filter((key) => !buckets.has(key)).length > maxBuckets)
        for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      const blocked = keys.map((key) => buckets.get(key)).find((bucket) => bucket && bucket.count >= limit);
      if (blocked || buckets.size + keys.filter((key) => !buckets.has(key)).length > maxBuckets) {
        c.header('Retry-After', String(Math.max(1, Math.ceil(((blocked?.resetAt ?? now + windowMs) - now) / 1000))));
        throw new AppError('rate_limited', 'Too many requests.');
      }
      const reservations = keys.map((key) => {
        const bucket = buckets.get(key) ?? { count: 0, resetAt: now + windowMs };
        bucket.count++; buckets.set(key, bucket);
        return { key, bucket };
      });
      // Reserve before verification so concurrent guesses cannot bypass the limit.
      // Successful PIN checks release only their own slots, never earlier failures.
      const attempt = { verified: false };
      pinAttempts.set(c.req.raw, attempt);
      try { await next(); }
      finally {
        pinAttempts.delete(c.req.raw);
        if (attempt.verified) for (const { key, bucket } of reservations) {
          if (buckets.get(key) !== bucket) continue;
          if (--bucket.count === 0) buckets.delete(key);
        }
      }
      return;
    }
    await next();
  };
}
