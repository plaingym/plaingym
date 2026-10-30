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

/**
 * The rate-limit key for a client address: IPv4 as it is, an IPv4-mapped IPv6 address as its IPv4 address, and any
 * other IPv6 address by its /64 prefix, since one subscriber is usually given a whole /64 (Better Auth's own limiter
 * groups IPv6 the same way). Anything else, such as `unknown`, is returned unchanged.
 */
export function clientKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address.split('%')[0]!);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  return groups.slice(0, 4).map((group) => group.toString(16)).join(':') + '::/64';
}
/** The eight 16-bit groups of an address `isIP` has accepted as IPv6. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head = '', tail] = text.split('::');
  const parse = (part: string) => part ? part.split(':').map((group) => parseInt(group, 16)) : [];
  const left = parse(head), right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export interface RateBucket { count: number; resetAt: number }
/**
 * Fixed-window buckets in creation order. A full table evicts buckets rather than refusing new keys, so a flood of
 * new keys can't lock out new visitors. Ended windows and the oldest buckets still within their limits go first;
 * a bucket over its limit (`blocked`) goes only once every other bucket is too, so a flood can't lift a refusal.
 */
export class RateBuckets<Bucket extends RateBucket = RateBucket> {
  readonly #buckets = new Map<string, Bucket>();
  constructor(readonly maxBuckets: number, readonly blocked: (bucket: Bucket) => boolean) {}
  /** The key's bucket while its window is open. */
  get(key: string, now: number): Bucket | undefined {
    const bucket = this.#buckets.get(key);
    if (bucket && bucket.resetAt <= now) { this.#buckets.delete(key); return undefined; }
    return bucket;
  }
  /** Starts the key's bucket, first making room in a full table. The buckets of `keep` (the request's own) stay. */
  add(key: string, bucket: Bucket, now: number, keep: readonly string[] = []): Bucket {
    this.#buckets.delete(key);
    const evict = (evictable: (bucket: Bucket) => boolean) => {
      for (const [id, value] of this.#buckets) {
        if (this.#buckets.size < this.maxBuckets) return;
        if (!keep.includes(id) && evictable(value)) this.#buckets.delete(id);
      }
    };
    evict((value) => value.resetAt <= now || !this.blocked(value));
    evict(() => true);
    this.#buckets.set(key, bucket);
    return bucket;
  }
  /** Whether the key still holds this bucket (it may have expired, been evicted or been replaced). */
  holds(key: string, bucket: Bucket): boolean { return this.#buckets.get(key) === bucket; }
  delete(key: string): void { this.#buckets.delete(key); }
}

export interface RateLimitOptions extends ClientIpOptions {
  /** Share one route budget across every client address of the resolved gym. */
  readonly perGym?: boolean;
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
  const buckets = new RateBuckets(maxBuckets, (bucket) => bucket.count >= limit);
  return async (context, next) => {
    const { clock, gym, clientIp: resolved } = context.get('context');
    // Route-level limiters share the app's proxy-aware address instead of the proxy's socket peer.
    const now = clock.now().getTime(), key = options.perGym ? gym?.gymId ?? 'install'
      : `${gym?.gymId ?? 'install'}:${clientKey(resolved ?? clientIp(context, options))}`;
    const bucket = buckets.get(key, now) ?? buckets.add(key, { count: 0, resetAt: now + windowMs }, now);
    if (bucket.count >= limit) {
      context.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      throw new AppError('rate_limited', 'Too many requests.');
    }
    bucket.count++;
    await next();
  };
}
