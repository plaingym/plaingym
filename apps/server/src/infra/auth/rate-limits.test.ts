// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { authRateLimit, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAuthService, type AuthServiceOptions } from './service.js';
import { clearAccountAttempts, gymAddressStorage, reserveAccountAttempt, releaseAccountAttempt, signInLimits } from './account-limit.js';
import { accountDigest } from './account-limit-key.js';
import { authConfig } from './config.js';
import { sessionMiddleware } from './middleware.js';
import { passwordAdapter } from './password.js';
import { clientIp, type ClientIpOptions } from '../../core/rate-limit.js';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { SmtpDeliveryError } from '../email/smtp.js';
// Imported rather than read, so a change to the server's manifest selects this file in verification.
import serverManifest from '../../../package.json' with { type: 'json' };
import type { RequestEnvironment } from '../../core/context.js';

const database = useTestDatabase();
const factory = createFactories(database);
const secret = 'auth-rate-limit-test-secret-at-least-32-characters';
const config = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on' }, false);
const password = 'rate-limited-password-123';
let hash: string, next = 1;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('AUTH_PASSWORD_LOGIN', 'on'); vi.stubEnv('TENANCY', 'single');
  hash = await passwordAdapter.hash(password);
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

/** A fresh address in 198.51.100.0/24 or 203.0.113.0/24, so each test's address buckets start empty. */
const address = () => { const n = next++; return n < 255 ? `198.51.100.${n}` : `203.0.113.${n - 254}`; };

async function fixture(options: Partial<AuthServiceOptions> = {}) {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const user = await factory('authUser', gymId, { emailVerified: true });
  await factory('authAccount', gymId, { userId: user.id, accountId: user.id, password: hash });
  const origin = `https://${gymId}.example.test`, delivered: string[] = [];
  // Starts at the real time: Better Auth prunes rows by the real clock, so a fixed past start would let it remove open windows.
  let time = Date.now();
  const service = createAuthService({ config, database: () => database.system.db, sendMagicLink: async ({ email }) => { delivered.push(email); },
    now: () => time, ...options });
  const from = (clientIp: string) => service.bind({ gymId, origin, clientIp });
  const request = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(new URL('/api/auth' + path, origin), {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const signIn = (clientIp: string, email = user.email, attempt = password) => from(clientIp).handler(request('/sign-in/email', { email, password: attempt }));
  const askLink = (clientIp: string, email = user.email) => from(clientIp).handler(request('/sign-in/magic-link', { email }));
  return { gymId, origin, user, delivered, service, from, request, signIn, askLink, advance: (seconds: number) => { time += seconds * 1000; } };
}
const statuses = (responses: Response[]) => responses.map((response) => response.status);

describe('per-account sign-in limit', () => {
  it('limits one account tried from two addresses, says when to retry, and opens again when its fixed window ends', async () => {
    const f = await fixture({ accountRateLimit: { window: 600, max: 2 } });
    const a = address(), b = address();
    expect(statuses([await f.signIn(a, f.user.email, 'wrong-password-123'), await f.signIn(b, f.user.email.toUpperCase(), 'wrong-password-123')])).toEqual([401, 401]);
    const refused = await f.signIn(b);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('600');
    expect(refused.headers.get('x-retry-after')).toBe('600');
    expect(refused.headers.get('cache-control')).toBe('no-store');
    // The refusal names no reason that would tell an account from an address limit.
    expect(await refused.json()).toEqual({ message: 'Too many requests. Please try again later.' });
    // Another account from the same addresses keeps its own budget.
    const other = await factory('authUser', f.gymId);
    expect((await f.signIn(a, other.email)).status).toBe(401);
    // A fixed window: attempts later in it don't extend it, and it ends on time.
    f.advance(599);
    const late = await f.signIn(a);
    expect(late.status).toBe(429);
    expect(late.headers.get('retry-after')).toBe('1');
    f.advance(1);
    expect((await f.signIn(a)).status).toBe(200);
  });

  it('counts login-link requests per account apart from password sign-in, with surrounding spaces and case ignored', async () => {
    const f = await fixture({ accountRateLimit: { window: 600, max: 2 } });
    expect(statuses([await f.askLink(address()), await f.askLink(address(), ` ${f.user.email.toUpperCase()} `), await f.askLink(address())]))
      .toEqual([200, 400, 429]);
    // Only the requests within the limit reached Better Auth: the padded address failed its validation, so one link went out.
    expect(f.delivered).toEqual([f.user.email.toLowerCase()]);
    expect((await f.signIn(address())).status).toBe(200);
  });

  it('keeps concurrent attempts on one account exact', async () => {
    const f = await fixture({ accountRateLimit: { window: 600, max: 3 } });
    const responses = await Promise.all(Array.from({ length: 12 }, () => f.askLink(address())));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(9);
  });

  it('allows ten attempts per account in ten minutes by default', async () => {
    const f = await fixture();
    expect(signInLimits.account).toEqual({ window: 600, max: 10 });
    for (let i = 0; i < 10; i++) expect((await f.askLink(address())).status).toBe(200);
    const refused = await f.askLink(address());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('600');
  });

  it('refunds ten successful passwords in a row, but ten failures close the password window', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) expect((await f.signIn(address())).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await f.signIn(address(), f.user.email, 'wrong-password-123')).status).toBe(401);
    expect((await f.signIn(address())).status).toBe(429);
  });

  it('reserves in-flight password slots before verification, even through one binding', async () => {
    const f = await fixture({ rateLimit: { window: 60, max: 100 } });
    const bound = f.from(address());
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const verify = vi.spyOn(passwordAdapter, 'verify').mockImplementation(async () => { await gate; return false; });
    const attempts = Promise.all(Array.from({ length: 24 }, () => bound.handler(f.request('/sign-in/email', { email: f.user.email, password: 'wrong-password-123' }))));
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(10), { timeout: 10_000 });
      finish();
      const responses = await attempts;
      expect(responses.filter(response => response.status === 401)).toHaveLength(10);
      expect(responses.filter(response => response.status === 429)).toHaveLength(14);
      expect(verify).toHaveBeenCalledTimes(10);
    } finally { finish(); await attempts.finally(() => verify.mockRestore()); }
  });

  it('refusals during successful in-flight passwords do not leave a phantom failure', async () => {
    const f = await fixture({ accountRateLimit: { window: 600, max: 2 } });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const verify = vi.spyOn(passwordAdapter, 'verify').mockImplementation(async () => { await gate; return true; });
    const attempts = Promise.all([f.signIn(address()), f.signIn(address())]);
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      expect((await f.signIn(address())).status).toBe(429);
      finish();
      expect(statuses(await attempts)).toEqual([200, 200]);
    } finally { finish(); await attempts.finally(() => verify.mockRestore()); }
    expect((await f.signIn(address(), f.user.email, 'wrong-password-123')).status).toBe(401);
    expect((await f.signIn(address(), f.user.email, 'wrong-password-123')).status).toBe(401);
    expect((await f.signIn(address())).status).toBe(429);
  });

  it('counts only the failing one of two concurrent passwords through one binding', async () => {
    const f = await fixture({ rateLimit: { window: 60, max: 100 }, accountRateLimit: { window: 600, max: 3 } });
    const bound = f.from(address());
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const verify = vi.spyOn(passwordAdapter, 'verify').mockImplementation(async ({ password: attempt }) => { await gate; return attempt === password; });
    const send = (attempt: string) => bound.handler(f.request('/sign-in/email', { email: f.user.email, password: attempt }));
    const attempts = Promise.all([send(password), send('wrong-password-123')]);
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      finish();
      expect(statuses(await attempts)).toEqual([200, 401]);
    } finally { finish(); await attempts.finally(() => verify.mockRestore()); }
    // One slot of three is held: two more failures fit, and the window then closes.
    expect(statuses([await f.signIn(address(), f.user.email, 'wrong-password-123'), await f.signIn(address(), f.user.email, 'wrong-password-123'),
      await f.signIn(address())])).toEqual([401, 401, 429]);
  });

  it('limits a request carrying its own attempt header exactly like one without it', async () => {
    const f = await fixture({ accountRateLimit: { window: 600, max: 2 } });
    const supplied = (clientIp: string, id: string, attempt = 'wrong-password-123') => f.from(clientIp)
      .handler(f.request('/sign-in/email', { email: f.user.email, password: attempt }, { 'x-plaingym-account-attempt': id }));
    expect(statuses([await supplied(address(), crypto.randomUUID()), await supplied(address(), '')])).toEqual([401, 401]);
    const refused = await supplied(address(), crypto.randomUUID(), password);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('600');
    // Login links count the same way, apart from passwords.
    const link = (id: string) => f.from(address()).handler(f.request('/sign-in/magic-link', { email: f.user.email }, { 'x-plaingym-account-attempt': id }));
    expect(statuses([await link(crypto.randomUUID()), await link(crypto.randomUUID()), await link(crypto.randomUUID())])).toEqual([200, 200, 429]);
  });

  it('never refunds a newer window when an old password finishes late', async () => {
    const f = await fixture(), rule = { window: 600, max: 1 }, now = Date.now();
    const old = await reserveAccountAttempt(database.system.db, '/sign-in/email', f.user.email, rule, now);
    const current = await reserveAccountAttempt(database.system.db, '/sign-in/email', f.user.email, rule, now + 600_000);
    expect(old.retryAfter).toBeNull(); expect(current.retryAfter).toBeNull();
    await releaseAccountAttempt(database.system.db, old.reservation!);
    expect((await reserveAccountAttempt(database.system.db, '/sign-in/email', f.user.email, rule, now + 600_000)).retryAfter).toBe(600);
  });

  it('does not refund a replacement window after recovery, even at the same clock instant', async () => {
    const f = await fixture(), rule = { window: 600, max: 1 }, now = Date.now();
    const old = await reserveAccountAttempt(database.system.db, '/sign-in/email', f.user.email, rule, now);
    await clearAccountAttempts(` ${f.user.email.toUpperCase()} `);
    expect((await reserveAccountAttempt(database.system.db, '/sign-in/email', f.user.email, rule, now)).retryAfter).toBeNull();
    await releaseAccountAttempt(database.system.db, old.reservation!);
    expect((await reserveAccountAttempt(database.system.db, '/sign-in/email', f.user.email, rule, now)).retryAfter).toBe(600);
  });
});

describe('per-address sign-in limit', () => {
  it('limits many accounts tried from one address and says when to retry, while another address goes on', async () => {
    const f = await fixture({ rateLimit: { window: 60, max: 3 } });
    const shared = address(), emails = ['one', 'two', 'three', 'four'].map((name) => `${name}-${f.gymId}@example.test`);
    const responses = [];
    for (const email of emails) responses.push(await f.signIn(shared, email, 'wrong-password-123'));
    expect(statuses(responses)).toEqual([401, 401, 401, 429]);
    const retry = Number(responses[3]!.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(responses[3]!.headers.get('x-retry-after')).toBe(String(retry));
    expect((await f.signIn(address())).status).toBe(200);
  });

  it('allows twenty attempts per address each minute by default', async () => {
    const f = await fixture(), shared = address();
    expect(signInLimits.address).toEqual({ window: 60, max: 20 });
    for (let i = 0; i < 20; i++) expect((await f.askLink(shared, `visitor-${i}-${f.gymId}@example.test`)).status).toBe(200);
    expect((await f.askLink(shared, `visitor-20-${f.gymId}@example.test`)).status).toBe(429);
  });

  it.each(['password', 'login link'])('an address refusal does not consume the account budget for a %s', async kind => {
    const f = await fixture({ rateLimit: { window: 60, max: 1 }, accountRateLimit: { window: 600, max: 1 } }), shared = address();
    const attempt = kind === 'password' ? (ip: string, email: string) => f.signIn(ip, email, 'wrong-password-123') : f.askLink;
    expect((await attempt(shared, `other-${f.gymId}@example.test`)).status).toBe(kind === 'password' ? 401 : 200);
    expect((await attempt(shared, f.user.email)).status).toBe(429);
    expect((await attempt(address(), f.user.email)).status).toBe(kind === 'password' ? 401 : 200);
    expect((await attempt(address(), f.user.email)).status).toBe(429);
  });
});

describe('gym isolation of sign-in limits', () => {
  const multi = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' }, true);

  it('keeps one identity\'s login-link windows apart at two gyms in multi mode', async () => {
    const options = { config: multi, accountRateLimit: { window: 600, max: 2 } };
    const a = await fixture(options), b = await fixture(options);
    expect(statuses([await a.askLink(address()), await a.askLink(address()), await a.askLink(address())])).toEqual([200, 200, 429]);
    expect(statuses([await b.askLink(address(), a.user.email), await b.askLink(address(), a.user.email), await b.askLink(address(), a.user.email)])).toEqual([200, 200, 429]);
    expect(b.delivered).toEqual([a.user.email, a.user.email]);
  });

  it('keeps the same address apart at two gyms in multi mode, including concurrent requests', async () => {
    const options = { config: multi, rateLimit: { window: 60, max: 2 }, accountRateLimit: { window: 600, max: 100 } };
    const a = await fixture(options), b = await fixture(options), shared = address();
    const responses = await Promise.all(Array.from({ length: 8 }, () => a.askLink(shared)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(2);
    expect(responses.filter(response => response.status === 429)).toHaveLength(6);
    expect(statuses([await b.askLink(shared), await b.askLink(shared), await b.askLink(shared)])).toEqual([200, 200, 429]);
    expect(Number(responses.find(response => response.status === 429)!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('retains the existing single-mode account and address keys', async () => {
    const f = await fixture(), shared = address();
    expect((await f.askLink(shared)).status).toBe(200);
    const rows = await database.system.db.select({ key: authRateLimit.key }).from(authRateLimit).where(eq(authRateLimit.key, `${shared}|/sign-in/magic-link`));
    expect(rows).toHaveLength(1);
    // No gym scope is passed in single mode: the existing account bucket was the one consumed by the HTTP request.
    expect((await reserveAccountAttempt(database.system.db, '/sign-in/magic-link', f.user.email, { window: 600, max: 1 }, Date.now())).retryAfter).not.toBeNull();
  });

  it('keeps Better Auth\'s address normalization and endpoint separation in multi mode', async () => {
    const f = await fixture({ config: multi, rateLimit: { window: 60, max: 1 } });
    expect((await f.askLink('2001:db8:1234:5678::1')).status).toBe(200);
    // Better Auth normalizes equivalent IPv6 spellings and groups a /64 before passing the storage key.
    expect((await f.askLink('2001:0DB8:1234:5678:0000:0000:0000:0002')).status).toBe(429);
    expect((await f.askLink('2001:db8:1234:5679::1')).status).toBe(200);
    const verify = f.from('2001:db8:1234:5678::1');
    const url = new URL('/api/auth/magic-link/verify', f.origin);
    url.searchParams.set('token', `${f.gymId}.invalid`);
    expect((await verify.handler(new Request(url))).status).not.toBe(429);
    expect((await verify.handler(new Request(url))).status).toBe(429);
  });

  it('retains rolling address windows and prunes expired rows without removing open account windows', async () => {
    const gymId = uuidv7(), key = `${address()}|/sign-in/magic-link`, now = Date.now();
    const store = gymAddressStorage(() => database.system.db, gymId), rule = { window: 60, max: 2 };
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await reserveAccountAttempt(database.system.db, '/sign-in/magic-link', `${gymId}@example.test`, { window: 600, max: 1 }, now);
      expect((await store.consume(key, rule)).allowed).toBe(true);
      time.mockReturnValue(now + 30_000);
      expect((await store.consume(key, rule)).allowed).toBe(true);
      time.mockReturnValue(now + 60_000);
      expect(await store.consume(key, rule)).toEqual({ allowed: false, retryAfter: 30 });
      time.mockReturnValue(now + 90_000);
      expect((await store.consume(key, rule)).allowed).toBe(true);
      await database.system.db.insert(authRateLimit).values({ key: `expired|${gymId}`, count: 1, lastRequest: now - 601_000 });
      expect((await store.consume(`${address()}|/sign-in/magic-link`, rule)).allowed).toBe(true);
      expect(await database.system.db.select().from(authRateLimit).where(eq(authRateLimit.key, `expired|${gymId}`))).toEqual([]);
      expect((await reserveAccountAttempt(database.system.db, '/sign-in/magic-link', `${gymId}@example.test`, { window: 600, max: 1 }, now + 90_000)).retryAfter).toBe(510);
    } finally { time.mockRestore(); }
  });

  it('admits a request whose prune fails in multi mode and logs the failure with the gym and no address', async () => {
    let failures = 1;
    const db = database.system.db;
    // The system handle, except that its first delete from auth_rate_limit (the address storage's prune) rejects.
    const failing = new Proxy(db, { get(target, property) {
      if (property === 'delete') return (table: unknown) => {
        if (table !== authRateLimit || failures === 0) return target.delete(table as typeof authRateLimit);
        failures--;
        // Shaped like Drizzle's query error: the driver's error, with its SQLSTATE, is the cause.
        return { where: () => Promise.reject(new Error('Failed query: prune for 198.51.100.1', { cause: Object.assign(new Error('canceling statement'), { code: '57014' }) })) };
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    const f = await fixture({ config: multi, database: () => failing });
    const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
    const shared = address();
    try {
      expect((await f.askLink(shared)).status).toBe(200);
    } finally { setLogSink(previous); }
    expect(failures).toBe(0);
    expect(f.delivered).toEqual([f.user.email.toLowerCase()]);
    const logged = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'auth.rate_limit_prune_failed');
    expect(logged).toEqual([expect.objectContaining({ level: 'warn', gymId: f.gymId, error: 'Error', code: '57014' })]);
    const line = lines.find(entry => entry.includes('auth.rate_limit_prune_failed'))!;
    expect(line).not.toContain(shared);
    expect(line).not.toContain('198.51.100.1');
    expect(line).not.toContain(f.user.email);
  });
});

describe('stored account window keys', () => {
  const multi = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' }, true);
  const plainKey = (email: string) => `account|/sign-in/email|${createHash('sha256').update(email.trim().toLowerCase()).digest('base64url')}`;
  const keyCount = async (key: string) => (await database.system.db.select({ count: authRateLimit.count }).from(authRateLimit)
    .where(eq(authRateLimit.key, key)))[0]?.count ?? null;

  it('keys a password attempt\'s window by the keyed digest of the address, never a plain hash of it', async () => {
    const f = await fixture();
    expect((await f.signIn(address(), f.user.email, 'wrong-password-123')).status).toBe(401);
    expect(await keyCount(`account|/sign-in/email|${accountDigest(f.user.email)}`)).toBe(1);
    expect(await keyCount(plainKey(f.user.email))).toBeNull();
  });

  it('puts the gym in front of the path in multi mode and keeps two gyms\' windows apart', async () => {
    const a = await fixture({ config: multi }), b = await fixture({ config: multi }), email = a.user.email, now = Date.now();
    for (const gymId of [a.gymId, a.gymId, b.gymId])
      expect((await reserveAccountAttempt(database.system.db, '/sign-in/email', email, signInLimits.account, now, gymId)).retryAfter).toBeNull();
    expect(await keyCount(`account|${a.gymId}|/sign-in/email|${accountDigest(email)}`)).toBe(2);
    expect(await keyCount(`account|${b.gymId}|/sign-in/email|${accountDigest(email)}`)).toBe(1);
    expect(await keyCount(`account|${a.gymId}|/sign-in/email|${createHash('sha256').update(email.toLowerCase()).digest('base64url')}`)).toBeNull();
    expect((await a.askLink(address())).status).toBe(200);
    expect(await keyCount(`account|${a.gymId}|/sign-in/magic-link|${accountDigest(email)}`)).toBe(1);
  });

  it('starts a window open under the old plain key again once, and leaves the old row to end', async () => {
    const f = await fixture(), old = plainKey(f.user.email);
    await database.system.db.insert(authRateLimit).values({ key: old, count: 10, lastRequest: Date.now() + 300_000 });
    expect((await f.signIn(address(), f.user.email, 'wrong-password-123')).status).toBe(401);
    expect(await keyCount(old)).toBe(10);
  });

  it('clears a locked account from the owner CLI with a differently spelled address', async () => {
    const f = await fixture(), shared = address();
    for (let i = 0; i < 10; i++) expect((await f.signIn(shared, f.user.email, 'wrong-password-123')).status).toBe(401);
    expect((await f.signIn(shared)).status).toBe(429);
    await clearAccountAttempts(` ${f.user.email.toUpperCase()} `);
    expect((await f.signIn(shared)).status).toBe(200);
  });
});

describe('per-gym login-link ceiling', () => {
  const ceiling = (max = 3) => fixture({ loginLinkCeiling: { window: 3600, max }, accountRateLimit: { window: 600, max: 1000 }, rateLimit: { window: 60, max: 1000 } });
  let stranger = 0;
  const unlinked = (gymId: string) => `stranger-${stranger++}-${gymId}@example.test`;
  const bodies = async (responses: Response[]) => Promise.all(responses.map(async (response) => JSON.stringify(await response.json())));

  it('sends at most its ceiling of links an hour to unlinked addresses, with the same answer for the dropped ones', async () => {
    const f = await ceiling();
    const emails = Array.from({ length: 4 }, () => unlinked(f.gymId));
    const responses: Response[] = [];
    for (const email of emails) responses.push(await f.askLink(address(), email));
    expect(statuses(responses)).toEqual([200, 200, 200, 200]);
    expect(new Set(await bodies(responses)).size).toBe(1);
    expect(f.delivered).toEqual(emails.slice(0, 3));
  });

  it('never counts or drops a link to an address with a staff role or household login in the gym', async () => {
    const f = await ceiling();
    for (let i = 0; i < 3; i++) await f.askLink(address(), unlinked(f.gymId));
    await factory('staffRoles', f.gymId, { userId: f.user.id });
    const household = await factory('households', f.gymId);
    const member = await factory('authUser', f.gymId, { emailVerified: true });
    await factory('householdUsers', f.gymId, { householdId: household.id, userId: member.id, scope: 'payer' });
    const fifth = unlinked(f.gymId);
    expect(statuses([await f.askLink(address(), f.user.email), await f.askLink(address(), member.email), await f.askLink(address(), fifth)]))
      .toEqual([200, 200, 200]);
    expect(f.delivered.slice(3)).toEqual([f.user.email.toLowerCase(), member.email.toLowerCase()]);
  });

  it('counts an identity without a staff role or household login in the gym as unlinked', async () => {
    const f = await ceiling(1);
    const other = unlinked(f.gymId);
    expect(statuses([await f.askLink(address()), await f.askLink(address(), other)])).toEqual([200, 200]);
    expect(f.delivered).toEqual([f.user.email.toLowerCase()]);
  });

  it('opens again when its fixed window ends, and dropped sends never extend the window', async () => {
    const f = await ceiling();
    for (let i = 0; i < 3; i++) await f.askLink(address(), unlinked(f.gymId));
    f.advance(1800);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(200);
    expect(f.delivered).toHaveLength(3);
    f.advance(1800);
    const again = unlinked(f.gymId);
    expect((await f.askLink(address(), again)).status).toBe(200);
    expect(f.delivered.at(-1)).toBe(again);
  });

  it('keeps the ceiling exact for concurrent requests', async () => {
    const f = await ceiling();
    const responses = await Promise.all(Array.from({ length: 6 }, () => f.askLink(address(), unlinked(f.gymId))));
    expect(statuses(responses)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(new Set(await bodies(responses)).size).toBe(1);
    expect(f.delivered).toHaveLength(3);
  });

  it('counts each gym apart', async () => {
    const a = await ceiling(), b = await ceiling();
    for (let i = 0; i < 4; i++) await a.askLink(address(), unlinked(a.gymId));
    expect(a.delivered).toHaveLength(3);
    for (let i = 0; i < 3; i++) await b.askLink(address(), unlinked(b.gymId));
    expect(b.delivered).toHaveLength(3);
    await a.askLink(address(), unlinked(a.gymId));
    expect(a.delivered).toHaveLength(3);
  });

  it('never counts or drops the links the app sends itself', async () => {
    const f = await ceiling();
    for (let i = 0; i < 3; i++) await f.askLink(address(), unlinked(f.gymId));
    await f.from(address()).sendLoginLink('stranger@example.test');
    expect(f.delivered.at(-1)).toBe('stranger@example.test');
    f.advance(3600);
    await f.from(address()).sendLoginLink('stranger@example.test');
    const asked = Array.from({ length: 3 }, () => unlinked(f.gymId));
    for (const email of asked) expect((await f.askLink(address(), email)).status).toBe(200);
    expect(f.delivered.slice(-3)).toEqual(asked);
  });

  it('logs the dropped sends once per window, with the gym and no address', async () => {
    const f = await ceiling(1);
    const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
    const dropped = Array.from({ length: 3 }, () => unlinked(f.gymId));
    try {
      await f.askLink(address(), unlinked(f.gymId));
      for (const email of dropped) expect((await f.askLink(address(), email)).status).toBe(200);
    } finally { setLogSink(previous); }
    expect(f.delivered).toHaveLength(1);
    const logged = lines.filter(line => line.includes('auth.login_link_ceiling'));
    expect(logged.map(line => JSON.parse(line) as Record<string, unknown>))
      .toEqual([expect.objectContaining({ level: 'warn', event: 'auth.login_link_ceiling', gymId: f.gymId, limit: 1 })]);
    for (const email of dropped) expect(logged[0]).not.toContain(email);
  });

  /** A sender whose next sends take `took` milliseconds on a fake reading and then throw `error`, if set; `pause` resolves at once. */
  function scripted() {
    let reading = 0, took = 0, error: unknown = null;
    const sent: string[] = [], pauses: number[] = [];
    const options = {
      sendMagicLink: async ({ email }: { email: string }) => { sent.push(email); reading += took; if (error !== null) throw error; },
      pause: async (milliseconds: number) => { pauses.push(milliseconds); },
      elapsed: () => reading,
    };
    return { sent, pauses, options, next(milliseconds: number, failure: unknown = null) { took = milliseconds; error = failure; } };
  }
  const limits = { loginLinkCeiling: { window: 3600, max: 1 }, accountRateLimit: { window: 600, max: 1000 }, rateLimit: { window: 60, max: 1000 } };
  const scriptedCeiling = async () => {
    const sender = scripted();
    return { sender, f: await fixture({ ...limits, ...sender.options }) };
  };
  const serviceDown = () => new SmtpDeliveryError('not_accepted', 'SMTP authentication failed', { cause: { code: 'EAUTH', responseCode: 535 } });
  const recipientRefused = () => new SmtpDeliveryError('not_accepted', 'SMTP server refused the message envelope',
    { cause: { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 } });
  const linkUser = async (f: Awaited<ReturnType<typeof fixture>>) => { await factory('staffRoles', f.gymId, { userId: f.user.id }); return f.user.email; };

  it('makes a dropped link wait about as long as the gym\'s recent sends and answer like a sent one', async () => {
    const { sender, f } = await scriptedCeiling();
    sender.next(120);
    const first = unlinked(f.gymId), second = unlinked(f.gymId);
    const responses = [await f.askLink(address(), first), await f.askLink(address(), second)];
    expect(statuses(responses)).toEqual([200, 200]);
    expect(new Set(await bodies(responses)).size).toBe(1);
    expect(sender.sent).toEqual([first]);
    expect(sender.pauses).toEqual([120]);
  });

  it('answers a dropped link 503 like a linked address while the gym\'s sending service fails', async () => {
    const { sender, f } = await scriptedCeiling();
    const email = await linkUser(f);
    sender.next(200, serviceDown());
    const first = unlinked(f.gymId);
    const sent = await f.askLink(address(), first), dropped = await f.askLink(address(), unlinked(f.gymId)), linked = await f.askLink(address(), email);
    expect(statuses([sent, dropped, linked])).toEqual([503, 503, 503]);
    const [droppedBody, linkedBody] = [await dropped.text(), await linked.text()];
    expect(droppedBody).toBe(linkedBody);
    expect(JSON.parse(droppedBody)).toEqual(expect.objectContaining({ code: 'EMAIL_UNAVAILABLE' }));
    expect(sender.sent).toEqual([first, email.toLowerCase()]);
  });

  it('waits the median of the gym\'s newest five sends', async () => {
    const { sender, f } = await scriptedCeiling();
    const email = await linkUser(f);
    sender.next(1);
    await f.askLink(address(), unlinked(f.gymId));
    for (const took of [5000, 5000, 10, 40, 20, 50, 30]) { sender.next(took); expect((await f.askLink(address(), email)).status).toBe(200); }
    expect(sender.pauses).toEqual([]);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(200);
    expect(sender.pauses).toEqual([30]);
  });

  it('waits at most two seconds', async () => {
    const { sender, f } = await scriptedCeiling();
    sender.next(10_000);
    await f.askLink(address(), unlinked(f.gymId));
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(200);
    expect(sender.pauses).toEqual([2000]);
  });

  it('answers at once with 200 in a process that has sent nothing for the gym', async () => {
    const { sender, f } = await scriptedCeiling();
    sender.next(120);
    await f.askLink(address(), unlinked(f.gymId));
    const other = scripted();
    const second = createAuthService({ config, database: () => database.system.db, ...limits, ...other.options });
    const response = await second.bind({ gymId: f.gymId, origin: f.origin, clientIp: address() })
      .handler(f.request('/sign-in/magic-link', { email: unlinked(f.gymId) }));
    expect(response.status).toBe(200);
    expect(other.sent).toEqual([]);
    expect(other.pauses).toEqual([]);
  });

  it('imitates a failed send for five minutes', async () => {
    const { sender, f } = await scriptedCeiling();
    sender.next(50, serviceDown());
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(503);
    f.advance(299);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(503);
    f.advance(1);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(200);
    expect(sender.pauses).toEqual([50, 50]);
  });

  it('answers 200 once a later send succeeds', async () => {
    const { sender, f } = await scriptedCeiling();
    const email = await linkUser(f);
    sender.next(50, serviceDown());
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(503);
    sender.next(60);
    expect((await f.askLink(address(), email)).status).toBe(200);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(200);
  });

  it('records nothing for a failure that is not the sending service\'s', async () => {
    const { sender, f } = await scriptedCeiling();
    const email = await linkUser(f);
    sender.next(80);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(200);
    sender.next(900, recipientRefused());
    expect((await f.askLink(address(), email)).status).toBe(500);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(200);
    expect(sender.pauses).toEqual([80]);
  });

  it('counts the links the app sends itself as the gym\'s sends', async () => {
    const { sender, f } = await scriptedCeiling();
    sender.next(40);
    await f.askLink(address(), unlinked(f.gymId));
    const failure = serviceDown();
    sender.next(70, failure);
    await expect(f.from(address()).sendLoginLink('stranger@example.test')).rejects.toBe(failure);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(503);
  });

  it('keeps each gym\'s sends apart in one service', async () => {
    const { sender, f } = await scriptedCeiling();
    const otherGym = uuidv7();
    await factory('gyms', otherGym);
    const otherOrigin = `https://${otherGym}.example.test`;
    const askOther = (email: string) => f.service.bind({ gymId: otherGym, origin: otherOrigin, clientIp: address() })
      .handler(new Request(new URL('/api/auth/sign-in/magic-link', otherOrigin), {
        method: 'POST', headers: { origin: otherOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ email }) }));
    sender.next(50, serviceDown());
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(503);
    sender.next(50);
    expect((await askOther(unlinked(otherGym))).status).toBe(200);
    expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(503);
    expect((await askOther(unlinked(otherGym))).status).toBe(200);
    expect(sender.sent).toHaveLength(2);
  });

  it('never waits on a link to a linked address', async () => {
    const { sender, f } = await scriptedCeiling();
    const email = await linkUser(f);
    sender.next(30);
    await f.askLink(address(), unlinked(f.gymId));
    for (const failure of [null, serviceDown(), recipientRefused(), null]) { sender.next(30, failure); await f.askLink(address(), email); }
    expect(sender.sent.slice(1)).toEqual(Array.from({ length: 4 }, () => email.toLowerCase()));
    expect(sender.pauses).toEqual([]);
  });

  it('logs no email failure for a dropped 503, and the ceiling once per window without an address', async () => {
    const { sender, f } = await scriptedCeiling();
    const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
    const dropped = Array.from({ length: 2 }, () => unlinked(f.gymId));
    try {
      sender.next(20, serviceDown());
      expect((await f.askLink(address(), unlinked(f.gymId))).status).toBe(503);
      for (const email of dropped) expect((await f.askLink(address(), email)).status).toBe(503);
    } finally { setLogSink(previous); }
    expect(lines.filter(line => line.includes('auth.magic_link_email_unavailable'))).toHaveLength(1);
    const logged = lines.filter(line => line.includes('auth.login_link_ceiling'));
    expect(logged.map(line => JSON.parse(line) as Record<string, unknown>))
      .toEqual([expect.objectContaining({ level: 'warn', event: 'auth.login_link_ceiling', gymId: f.gymId, limit: 1 })]);
    for (const email of dropped) expect(logged[0]).not.toContain(email);
  });
});

describe('the Better Auth pin', () => {
  it('stays at the version the gym address storage was checked against', () => {
    const dependencies: Readonly<Record<string, string>> = serverManifest.dependencies;
    expect(dependencies['better-auth'], 'Better Auth changed: recheck gymAddressStorage against createDatabaseStorageWrapper in '
      + 'better-auth/dist/api/rate-limiter, then update this pin').toBe('1.7.12');
  });
});

describe('the client address behind the session middleware', () => {
  /** The app's wiring: the session middleware binds sign-in to the address the request resolves to. */
  async function app(addressOptions: ClientIpOptions) {
    const f = await fixture({ rateLimit: { window: 60, max: 2 }, accountRateLimit: { window: 600, max: 100 } });
    const clock = new TestClock('2026-11-04T12:00:00Z'), server = new OpenAPIHono<RequestEnvironment>();
    server.use('*', async (context, next) => {
      context.set('context', { requestId: 'test', gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, clock });
      await next();
    });
    server.use('*', sessionMiddleware({ auth: f.service, resolve: (context) => ({ gymId: f.gymId, origin: f.origin, clientIp: clientIp(context, addressOptions) }) }));
    const signIn = (forwarded: string) => server.request(f.request('/sign-in/email', { email: f.user.email, password }, { 'x-forwarded-for': forwarded }));
    return { signIn };
  }

  it('keeps one bucket for a peer that is not a trusted proxy, whatever forwarded headers it sends', async () => {
    const peer = address(), { signIn } = await app({ peerAddress: () => peer });
    expect(statuses([await signIn(address()), await signIn(address()), await signIn(address())])).toEqual([200, 200, 429]);
  });

  it('gives each forwarded client its own bucket behind a trusted proxy, using only the entry the proxy appended', async () => {
    const proxy = address(), { signIn } = await app({ peerAddress: () => proxy, trustedProxy: (peer) => peer === proxy });
    const first = address(), second = address();
    expect(statuses([await signIn(first), await signIn(first), await signIn(first)])).toEqual([200, 200, 429]);
    // A client can't pick its bucket by sending its own entry ahead of the proxy's.
    expect((await signIn(`${second}, ${first}`)).status).toBe(429);
    expect(statuses([await signIn(second), await signIn(`${first}, ${second}`)])).toEqual([200, 200]);
  });
});
