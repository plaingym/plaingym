// SPDX-License-Identifier: AGPL-3.0-only
import { BlockList, isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AppError } from '@plaingym/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from './context.js';
import { cloudflareRanges } from './cloudflare-ranges.js';
import { logInfo } from './log.js';

let lastCloudflareHeaderWarning: number | undefined;

export interface ClientIpOptions {
  /** Immediate socket peer, supplied by the server adapter, never request headers. */
  readonly peerAddress?: (context: Context<RequestEnvironment>) => string | undefined;
  readonly trustedProxy?: (address: string) => boolean;
  /**
   * `TRUST_CLOUDFLARE`: behind a trusted proxy, when the address it forwards is one of Cloudflare's published
   * ranges, take the client from `CF-Connecting-IP`. From any other address the header is ignored, so this changes
   * nothing for a server that isn't behind Cloudflare. Those ranges are shared by every Cloudflare customer, so
   * traffic sent from inside Cloudflare (a Worker opening its own connection to this server) can still set the
   * header; only per-address limits depend on it (docs/security-model.md).
   */
  readonly cloudflare?: boolean;
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
    if (forwarded && isIP(forwarded)) {
      if (options.cloudflare && isCloudflareAddress(forwarded)) {
        const header = context.req.header('cf-connecting-ip')?.trim();
        if (!header || !isIP(header)) {
          const now = Date.now();
          if (lastCloudflareHeaderWarning === undefined || now - lastCloudflareHeaderWarning >= 60_000) {
            lastCloudflareHeaderWarning = now;
            logInfo('client_ip.cloudflare_header_invalid', { reason: !header ? 'missing' : header.includes(',') ? 'multiple' : 'invalid' });
          }
        }
        const visitor = header?.split(',').map((entry) => entry.trim()).find((entry) => isIP(entry));
        if (visitor) return visitor;
      }
      return forwarded;
    }
  }
  return peer;
}

const cloudflareNetworks = new BlockList();
for (const range of cloudflareRanges) {
  const [base, prefix] = range.split('/') as [string, string];
  cloudflareNetworks.addSubnet(base, Number(prefix), isIP(base) === 6 ? 'ipv6' : 'ipv4');
}
/** Whether an address is inside one of Cloudflare's published proxy ranges (`cloudflare-ranges.ts`). */
export function isCloudflareAddress(address: string): boolean {
  const version = isIP(address);
  // BlockList also matches an IPv4-mapped IPv6 address against the IPv4 ranges.
  return version !== 0 && cloudflareNetworks.check(address, version === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The rate-limit key for a client address: IPv4 as it is, an IPv4-mapped IPv6 address as its IPv4 address, and any
 * other IPv6 address by its /64 prefix by default (as Better Auth does). Public intake opts into /56 to group
 * a subscriber's adjacent /64s. Anything else, such as `unknown`, is returned unchanged.
 */
export function clientKey(address: string, ipv6Prefix: 56 | 64 = 64): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address.split('%')[0]!);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  if (ipv6Prefix === 56) groups[3] = groups[3]! & 0xff00;
  return groups.slice(0, 4).map((group) => group.toString(16)).join(':') + `::/${ipv6Prefix}`;
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
 * Fixed-window buckets in two maps, each in insertion order: `#open` holds buckets in creation order until a walk
 * making room finds them over their limit (`blocked`), and then sets them aside in `#blocked`, once, in the order
 * found. A full table evicts buckets rather than refusing new keys, so a flood of new keys can't lock out new
 * visitors. Ended windows and the oldest buckets still within their limits go first; a bucket over its limit goes
 * only once every other bucket is too, so lifting a refusal takes a flood that fills the whole table with refused
 * keys, and a table full of them costs no full walk per new key.
 *
 * A set-aside bucket stays in the over-limit order even if its count later drops below its limit or its window ends.
 * A table's buckets share one window length, so `#blocked`'s oldest are usually the first to end and ended windows
 * there still go first. The exception is a request's own bucket that a walk passed while it was within its limit: once
 * over it, a later walk sets it aside behind the buckets set aside meanwhile, and they go before it even after its
 * window ends.
 */
export class RateBuckets<Bucket extends RateBucket = RateBucket> {
  readonly #open = new Map<string, Bucket>();
  readonly #blocked = new Map<string, Bucket>();
  constructor(readonly maxBuckets: number, readonly blocked: (bucket: Bucket) => boolean) {}
  /** The key's bucket while its window is open. */
  get(key: string, now: number): Bucket | undefined {
    const map = this.#open.has(key) ? this.#open : this.#blocked, bucket = map.get(key);
    if (bucket && bucket.resetAt <= now) { map.delete(key); return undefined; }
    return bucket;
  }
  /**
   * Starts the key's bucket, first making room in a full table: the first ended or within-limit buckets in `#open`
   * (over-limit ones met on the way are set aside, kept ones too), else the oldest set aside and not kept. The
   * buckets of `keep` (the request's own) stay, so they can hold the table over its bound until a later addition
   * makes room for them as well.
   */
  add(key: string, bucket: Bucket, now: number, keep: readonly string[] = []): Bucket {
    this.delete(key);
    let excess = this.#open.size + this.#blocked.size - this.maxBuckets + 1;
    if (excess > 0) {
      for (const [id, value] of this.#open) {
        const kept = keep.includes(id), ended = value.resetAt <= now;
        if (kept && ended) continue;
        if (!ended && this.blocked(value)) { this.#open.delete(id); this.#blocked.set(id, value); continue; }
        if (kept) continue;
        this.#open.delete(id);
        if (--excess === 0) break;
      }
      if (excess > 0) {
        for (const id of this.#blocked.keys()) {
          if (keep.includes(id)) continue;
          this.#blocked.delete(id);
          if (--excess === 0) break;
        }
      }
    }
    this.#open.set(key, bucket);
    return bucket;
  }
  /** Whether the key still holds this bucket (it may have expired, been evicted or been replaced). */
  holds(key: string, bucket: Bucket): boolean { return (this.#open.get(key) ?? this.#blocked.get(key)) === bucket; }
  delete(key: string): void { this.#open.delete(key); this.#blocked.delete(key); }
}

export interface RateLimitOptions extends ClientIpOptions {
  /** Public intake groups a subscriber's IPv6 addresses by /56; other budgets keep /64. */
  readonly ipv6Prefix?: 56 | 64;
  /** Stable budget identity; runtime registration enables database counting for these budgets. */
  readonly sharedKey?: string;
  readonly sharedStore?: SharedRateLimitStore;
  /** Share one route budget across every client address of the resolved gym. */
  readonly perGym?: boolean;
  readonly limit?: number;
  readonly windowMs?: number;
  readonly maxBuckets?: number;
  /** Optional `error.details.reason` entry included when this limiter refuses a request. */
  readonly reason?: string;
  /**
   * Requests this budget neither counts nor refuses, chosen where the limiter is mounted (the app's flood limit
   * passes the routes that carry their own budget). Never set on a route's own limiter.
   */
  readonly skip?: (context: Context<RequestEnvironment>) => boolean;
}

/** Matches requests for one contract's method and path template (`/l/{token}` matches `POST /l/abc`, not `/l/abc/x`). */
export function contractRequest(contract: { readonly method: string; readonly path: string }): (context: Context<RequestEnvironment>) => boolean {
  const method = contract.method.toUpperCase();
  const pattern = new RegExp('^' + contract.path.split(/\{[^/{}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
  return (context) => context.req.method === method && pattern.test(context.req.path);
}

/**
 * A per-client budget charged only for failures, such as a token that doesn't resolve: `check` refuses a client whose
 * failures reached the limit before the route does any work, and the route calls `charge` once the work has failed.
 * Successful requests cost nothing, so a route can keep a large budget for real traffic while guesses from one
 * address stop near the flood limit. Concurrent requests may each pass `check` before they are charged.
 */
export function failureBudget(options: { limit?: number; windowMs?: number; maxBuckets?: number } = {}) {
  const limit = options.limit ?? 300, windowMs = options.windowMs ?? 60_000;
  const buckets = new RateBuckets(options.maxBuckets ?? 10_000, (bucket) => bucket.count >= limit);
  const key = (context: Context<RequestEnvironment>) => {
    const { gym, clientIp: resolved } = context.get('context');
    return `${gym?.gymId ?? 'install'}:${clientKey(resolved ?? clientIp(context))}`;
  };
  const check: MiddlewareHandler<RequestEnvironment> = async (context, next) => {
    const now = context.get('context').clock.now().getTime(), bucket = buckets.get(key(context), now);
    if (bucket && bucket.count >= limit) {
      context.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      throw new AppError('rate_limited', 'Too many requests.');
    }
    await next();
  };
  return {
    check,
    charge(context: Context<RequestEnvironment>): void {
      const now = context.get('context').clock.now().getTime(), id = key(context);
      (buckets.get(id, now) ?? buckets.add(id, { count: 0, resetAt: now + windowMs }, now)).count++;
    },
  };
}

export interface IntakeReservationBucket {
  routeKey: string; amount: number; limit: number; start: number; resetAt: number;
}
/** A refusal names the bucket that is spent, unless the counters couldn't be written (`failed`). */
export type IntakeReservationResult =
  | { allowed: true; resetAt: number }
  | { allowed: false; resetAt: number; routeKey: string; failed?: false }
  | { allowed: false; resetAt: number; failed: true };
export interface SharedRateLimitStore {
  /** Counts one request. `failed` marks a refusal because the counter couldn't be written, not because the budget is spent. */
  consume(input: { gymId: string | null; routeKey: string; clientKey: string; now: number; windowMs: number; limit: number }):
    Promise<{ allowed: boolean; resetAt: number; failed?: boolean }>;
  /** One all-or-nothing reservation across weighted counters, including calendar windows. */
  reserve(input: { gymId: string; now: number; buckets: readonly IntakeReservationBucket[] }): Promise<IntakeReservationResult>;
}

/**
 * Wraps a store so a budget it refused is refused in memory until its window ends, without asking the store again.
 * A refusal from a failed counter write is remembered for at most `failureMs`, so a broken table costs the store
 * about one call a second per client instead of one per request. Another process may still ask the store once,
 * which refuses as well. A full table drops its oldest entry, which only sends that client back to the store.
 */
export function cacheRefusals(store: SharedRateLimitStore, maxEntries = 10_000, failureMs = 1000): SharedRateLimitStore {
  const refused = new Map<string, { until: number; resetAt: number; failed: boolean }>();
  return {
    // Weighted refusals cannot be cached: a smaller reservation may still fit.
    reserve: store.reserve.bind(store),
    async consume(input) {
      const key = `${input.gymId ?? ''}\u0000${input.routeKey}\u0000${input.clientKey}\u0000${input.windowMs}\u0000${input.limit}`;
      const known = refused.get(key);
      if (known && known.until > input.now) return { allowed: false, resetAt: known.resetAt, ...(known.failed ? { failed: true } : {}) };
      if (known) refused.delete(key);
      const result = await store.consume(input);
      if (!result.allowed) {
        if (refused.size >= maxEntries) refused.delete(refused.keys().next().value!);
        const failed = result.failed === true;
        refused.set(key, { until: failed ? Math.min(result.resetAt, input.now + failureMs) : result.resetAt, resetAt: result.resetAt, failed });
      }
      return result;
    },
  };
}
let sharedStore: SharedRateLimitStore | undefined;
/** Uses runtime's shared counters; factories can supply their own store or a bounded local fallback. */
export function rateLimitStore(): SharedRateLimitStore | undefined { return sharedStore; }
/** App factories without runtime infrastructure retain their local budgets. Returns a shutdown reset. */
export function configureSharedRateLimits(store: SharedRateLimitStore): () => void {
  sharedStore = store;
  return () => { if (sharedStore === store) sharedStore = undefined; };
}

/** Flood protection; named intake budgets use the store installed at runtime startup. */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler<RequestEnvironment> {
  const limit = options.limit ?? 300, windowMs = options.windowMs ?? 60_000, maxBuckets = options.maxBuckets ?? 10_000;
  for (const value of [limit, windowMs, maxBuckets]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Rate limit settings must be positive integers');
  }
  const buckets = new RateBuckets(maxBuckets, (bucket) => bucket.count >= limit);
  const details = options.reason ? { reason: [options.reason] } : undefined;
  return async (context, next) => {
    if (options.skip?.(context)) {
      await next();
      return;
    }
    const { clock, gym, clientIp: resolved } = context.get('context');
    const store = options.sharedStore ?? sharedStore;
    if (options.sharedKey && store) {
      const result = await store.consume({ gymId: gym?.gymId || null, routeKey: options.sharedKey,
        clientKey: options.perGym ? '*' : clientKey(resolved ?? clientIp(context, options), options.ipv6Prefix),
        now: clock.now().getTime(), windowMs, limit });
      if (!result.allowed) {
        context.header('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - clock.now().getTime()) / 1000))));
        throw new AppError('rate_limited', 'Too many requests.', details);
      }
      await next();
      return;
    }
    // Route-level limiters share the app's proxy-aware address instead of the proxy's socket peer.
    const now = clock.now().getTime(), key = options.perGym ? gym?.gymId ?? 'install'
      : `${gym?.gymId ?? 'install'}:${clientKey(resolved ?? clientIp(context, options), options.ipv6Prefix)}`;
    const bucket = buckets.get(key, now) ?? buckets.add(key, { count: 0, resetAt: now + windowMs }, now);
    if (bucket.count >= limit) {
      context.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      throw new AppError('rate_limited', 'Too many requests.', details);
    }
    bucket.count++;
    await next();
  };
}
