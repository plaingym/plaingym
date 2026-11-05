// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
// eslint-disable-next-line database/system-tables -- One isolated upsert decides each account's window atomically: reset an ended window, else count, capped.
import { sql } from 'drizzle-orm';
import { authRateLimit, uuidv7 } from '@plaingym/db';
import type { Database } from '@plaingym/db/client';

/** A fixed window: at most `max` attempts in each `window` seconds. */
export interface SignInRule { readonly window: number; readonly max: number }

/**
 * Sign-in limits. Better Auth counts each client address per endpoint; the app counts each account (its normalized
 * email) per endpoint, so many visitors behind one shared address don't lock each other out while one account still
 * can't be tried, or sent links, from many addresses at once.
 */
export const signInLimits = {
  address: { window: 60, max: 20 },
  account: { window: 600, max: 10 },
} as const satisfies Record<string, SignInRule>;

/** The endpoints that take an account's email, and so count per account. */
export const accountLimitedPaths: readonly string[] = ['/sign-in/email', '/sign-in/magic-link'];

/**
 * Counts one attempt for the account and returns the seconds until its window ends when the attempt is refused, else
 * null. The count lives in `auth_rate_limit` beside the address buckets, under a key no address bucket can take, with
 * `last_request` holding the window's end, so Better Auth's pruning of rows older than its own windows never removes an
 * open one. One upsert decides, so concurrent attempts and several app processes share the count exactly.
 */
export async function consumeAccountAttempt(database: Database, path: string, email: string, rule: SignInRule, now: number): Promise<number | null> {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('base64url');
  const key = `account|${path}|${digest}`, resetAt = now + rule.window * 1000;
  const ended = sql`${authRateLimit.lastRequest} <= ${now}`;
  const [row] = await database.insert(authRateLimit).values({ id: uuidv7(), key, count: 1, lastRequest: resetAt })
    .onConflictDoUpdate({ target: authRateLimit.key, set: {
      // A refused attempt still counts, capped one past the limit so the stored count stays bounded.
      count: sql`case when ${ended} then 1 else least(${authRateLimit.count} + 1, ${rule.max + 1}) end`,
      lastRequest: sql`case when ${ended} then ${resetAt}::bigint else ${authRateLimit.lastRequest} end`,
    } })
    .returning({ count: authRateLimit.count, resetAt: authRateLimit.lastRequest });
  if (!row || row.count <= rule.max) return null;
  return Math.max(1, Math.ceil((row.resetAt - now) / 1000));
}
