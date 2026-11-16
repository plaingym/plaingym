// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
// eslint-disable-next-line database/system-tables -- Isolated atomic rate-limit reservations, releases and rolling address counters.
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { authRateLimit, uuidv7 } from '@plaingym/db';
import { systemDatabase, type Database } from '@plaingym/db/client';
import { normalizeAddress } from '../email/deliveries.js';

/** At most `max` attempts in `window` seconds. Account windows are fixed; address windows roll. */
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

function accountKey(path: string, email: string, gymId?: string) {
  const digest = createHash('sha256').update(normalizeAddress(email)).digest('base64url');
  return `account|${gymId ? gymId + '|' : ''}${path}|${digest}`;
}
export interface AccountReservation { readonly id: string; readonly key: string; readonly resetAt: number }

/**
 * Reserves one slot atomically, including in-flight password checks. Refusals never increment the count. The row's
 * last_request holds the window's end so Better Auth's pruning cannot remove an open window. A fresh row ID on reset
 * prevents a late successful password from releasing a slot in a newer window, including after CLI recovery.
 */
export async function reserveAccountAttempt(database: Database, path: string, email: string, rule: SignInRule, now: number, gymId?: string)
  : Promise<{ retryAfter: null; reservation: AccountReservation } | { retryAfter: number; reservation: null }> {
  const key = accountKey(path, email, gymId), resetAt = now + rule.window * 1000, id = uuidv7();
  const ended = sql`${authRateLimit.lastRequest} <= ${now}`;
  const [row] = await database.insert(authRateLimit).values({ id, key, count: 1, lastRequest: resetAt })
    .onConflictDoUpdate({ target: authRateLimit.key, set: {
      id: sql`case when ${ended} then ${id}::uuid else ${authRateLimit.id} end`,
      count: sql`case when ${ended} then 1 else ${authRateLimit.count} + 1 end`,
      lastRequest: sql`case when ${ended} then ${resetAt}::bigint else ${authRateLimit.lastRequest} end`,
    }, setWhere: sql`${ended} or ${authRateLimit.count} < ${rule.max}` })
    .returning({ id: authRateLimit.id, key: authRateLimit.key, resetAt: authRateLimit.lastRequest });
  if (row) return { retryAfter: null, reservation: row };
  const [current] = await database.select({ resetAt: authRateLimit.lastRequest }).from(authRateLimit).where(eq(authRateLimit.key, key));
  // A concurrent CLI reset may have removed the full window between the upsert and the read. Refuse conservatively.
  return { retryAfter: Math.max(1, Math.ceil(((current?.resetAt ?? resetAt) - now) / 1000)), reservation: null };
}

/** Non-refundable, install-wide account operations (email-change requests). Sign-in paths reserve with the gym scope. */
export async function consumeAccountAttempt(database: Database, path: string, email: string, rule: SignInRule, now: number): Promise<number | null> {
  return (await reserveAccountAttempt(database, path, email, rule, now)).retryAfter;
}

/** Gives back only this window's successful password reservation; failures and interrupted requests keep their slot. */
export async function releaseAccountAttempt(database: Database, reservation: AccountReservation): Promise<void> {
  await database.update(authRateLimit).set({ count: sql`${authRateLimit.count} - 1` }).where(and(
    eq(authRateLimit.id, reservation.id), eq(authRateLimit.key, reservation.key), eq(authRateLimit.lastRequest, reservation.resetAt), gt(authRateLimit.count, 0),
  ));
}

/** Owner CLI recovery clears both single-gym account windows, without changing address budgets or other accounts. */
export async function clearAccountAttempts(email: string): Promise<void> {
  await systemDatabase().delete(authRateLimit).where(inArray(authRateLimit.key, accountLimitedPaths.map(path => accountKey(path, email))));
}

/**
 * Better Auth's custom storage keeps its normalized address/path key under the bound gym. Its rolling window semantics
 * stay the same: allowed requests advance last_request, refusals do not. Single-gym installs use its built-in storage.
 */
export function gymAddressStorage(database: () => Database, gymId: string) {
  let longestWindow = 600;
  return { async consume(addressKey: string, rule: SignInRule) {
    longestWindow = Math.max(longestWindow, rule.window);
    const db = database(), now = Date.now(), key = `address|${gymId}|${addressKey}`;
    const ended = sql`${authRateLimit.lastRequest} <= ${now - rule.window * 1000}`;
    const [row] = await db.insert(authRateLimit).values({ id: uuidv7(), key, count: 1, lastRequest: now })
      .onConflictDoUpdate({ target: authRateLimit.key, set: {
        count: sql`case when ${ended} then 1 else ${authRateLimit.count} + 1 end`, lastRequest: now,
      }, setWhere: sql`${ended} or ${authRateLimit.count} < ${rule.max}` })
      .returning({ count: authRateLimit.count });
    if (row) {
      // As in Better Auth, prune on a new window only, and never fail the admitted request over it. Account rows hold
      // their future window end and remain safe.
      if (row.count === 1) await db.delete(authRateLimit).where(lt(authRateLimit.lastRequest, now - longestWindow * 1000)).catch(() => undefined);
      return { allowed: true, retryAfter: null };
    }
    const [current] = await db.select({ lastRequest: authRateLimit.lastRequest }).from(authRateLimit).where(eq(authRateLimit.key, key));
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(((current?.lastRequest ?? now) + rule.window * 1000 - now) / 1000)) };
  } };
}
