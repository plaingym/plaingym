// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAuthService, type AuthServiceOptions } from './service.js';
import { signInLimits } from './account-limit.js';
import { authConfig } from './config.js';
import { sessionMiddleware } from './middleware.js';
import { passwordAdapter } from './password.js';
import { clientIp, type ClientIpOptions } from '../../core/rate-limit.js';
import { TestClock } from '../../core/clock.js';
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
  return { gymId, origin, user, delivered, service, request, signIn, askLink, advance: (seconds: number) => { time += seconds * 1000; } };
}
const statuses = (responses: Response[]) => responses.map((response) => response.status);

describe('per-account sign-in limit', () => {
  it('limits one account tried from two addresses, says when to retry, and opens again when its fixed window ends', async () => {
    const f = await fixture({ accountRateLimit: { window: 600, max: 2 } });
    const a = address(), b = address();
    expect(statuses([await f.signIn(a), await f.signIn(b, f.user.email.toUpperCase(), 'wrong-password-123')])).toEqual([200, 401]);
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
