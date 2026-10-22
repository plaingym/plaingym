// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AppError } from '@plaingym/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from './context.js';

export interface ClientIpOptions {
  /** Immediate socket peer, supplied by the server adapter, never request headers. */
  readonly peerAddress?: (context: Context<RequestEnvironment>) => string | undefined;
  readonly trustedProxy?: (address: string) => boolean;
}

export function clientIp(context: Context<RequestEnvironment>, options: ClientIpOptions = {}): string {
  let peer: string | undefined;
  if (options.peerAddress) peer = options.peerAddress(context);
  else {
    try { peer = getConnInfo(context).remote.address; }
    catch { /* In-process requests have no socket; share a conservative bucket. */ }
  }
  if (!peer || !isIP(peer)) return 'unknown';
  if (options.trustedProxy?.(peer)) {
    // The closest proxy appends the actual client; never trust the caller's first entry.
    const forwarded = context.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return peer;
}

export interface RateLimitOptions extends ClientIpOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly maxBuckets?: number;
}

/** Process-local flood protection. Authentication has its own shared database limiter. */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler<RequestEnvironment> {
  const limit = options.limit ?? 300, windowMs = options.windowMs ?? 60_000, maxBuckets = options.maxBuckets ?? 10_000;
  for (const value of [limit, windowMs, maxBuckets]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Rate limit settings must be positive integers');
  }
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return async (context, next) => {
    const { clock, gym } = context.get('context');
    const now = clock.now().getTime(), key = `${gym.gymId}:${clientIp(context, options)}`;
    let bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= now) { buckets.delete(key); bucket = undefined; }
    if (!bucket) {
      if (buckets.size >= maxBuckets) {
        for (const [id, value] of buckets) if (value.resetAt <= now) buckets.delete(id);
      }
      if (buckets.size >= maxBuckets) {
        context.header('Retry-After', String(Math.max(1, Math.ceil(windowMs / 1000))));
        throw new AppError('rate_limited', 'Too many requests.');
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      context.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      throw new AppError('rate_limited', 'Too many requests.');
    }
    bucket.count++;
    await next();
  };
}
