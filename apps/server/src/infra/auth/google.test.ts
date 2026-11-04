// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { authAccount, authSession, authUser, authVerification, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse } from '@plaingym/shared';
import { shellBootstrapResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { authorize as permissionMiddleware } from '../../areas/staff/auth.permissions.js';
import { createAuthBootstrapRoutes } from '../../areas/staff/auth.bootstrap.js';
import { authConfig } from './config.js';
import { createAuthService, type GoogleAuthExtension } from './service.js';
import { sessionMiddleware } from './middleware.js';
import { createGoogleAuthExtension, googleCallbackPath, googleFromEnvironment, googleStateGymKey, type GoogleCredentials } from './google.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-11-03T16:00:00Z');
const secret = 'google-login-test-secret-at-least-32-characters';
const single = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on' }, false);
const multi = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' }, true);
const credentials: GoogleCredentials = { clientId: 'install-client.apps.googleusercontent.com', clientSecret: 'install-client-secret' };
let address = 1;
beforeAll(async () => { await initializeDatabase(database.appUrl); vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('TENANCY', 'single'); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

interface Profile { sub: string; email: string; email_verified: boolean; name?: string }
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** Answers Google's token endpoint with an ID token for `profile`; Better Auth reads it from that TLS response. */
function googleAnswers(profile: Profile) {
  const exchanges: URLSearchParams[] = [];
  const passthrough = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://oauth2.googleapis.com/token')) return passthrough(input, init);
    exchanges.push(new URLSearchParams(String(init?.body ?? '')));
    const idToken = [encode({ alg: 'RS256', typ: 'JWT' }), encode({ iss: 'https://accounts.google.com', aud: credentials.clientId, iat: 1, exp: 4102444800, name: 'Google Name', ...profile }), 'signature'].join('.');
    return Response.json({ access_token: 'google-access-token', refresh_token: 'google-refresh-token', id_token: idToken, token_type: 'Bearer', expires_in: 3599, scope: 'openid email profile' });
  });
  return exchanges;
}
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');

async function fixture(config = single, google: GoogleAuthExtension | null = createGoogleAuthExtension({ credentials, database: () => database.system.db })) {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGymId);
  const origins: Record<string, string> = { [gymId]: `https://${gymId}.example.test`, [otherGymId]: `https://${otherGymId}.example.test` };
  const clientIp = `192.0.4.${address++}`;
  const service = createAuthService({ config, database: () => database.system.db, sendMagicLink: async () => undefined, ...(google ? { google } : {}) });
  const bound = (gym: string) => service.bind({ gymId: gym, origin: origins[gym]!, clientIp });
  const start = async (gym = gymId, body: unknown = { provider: 'google' }) => bound(gym).handler(new Request(new URL('/api/auth/sign-in/social', origins[gym]), {
    method: 'POST', headers: { origin: origins[gym]!, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  /** Starts at `from` and returns the provider URL's state with the state cookie the browser holds. */
  const authorize = async (from = gymId) => {
    const response = await start(from);
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    return { url, state: url.searchParams.get('state')!, cookie: cookies(response) };
  };
  const callback = async (gym: string, query: string, cookie: string) => bound(gym).handler(new Request(new URL(googleCallbackPath + query, origins[gym]), { headers: { cookie } }));
  /** The whole browser round trip: sign-in at `gym`, consent at Google, callback at `gym`. */
  const signIn = async (profile: Profile, gym = gymId) => {
    const exchanges = googleAnswers(profile);
    const { state, cookie } = await authorize(gym);
    const response = await callback(gym, `?code=consent-code&state=${state}`, cookie);
    return { response, exchanges, location: new URL(response.headers.get('location') ?? '/', origins[gym]), cookie: cookies(response) };
  };
  const app = new OpenAPIHono<RequestEnvironment>();
  app.onError((error, context) => context.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  const gymOf = (url: string) => Object.keys(origins).find((gym) => new URL(url).origin === origins[gym])!;
  app.use('*', async (context, next) => {
    context.set('context', { requestId: 'test', gym: { gymId: gymOf(context.req.url), timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, clock });
    await next();
  });
  app.use('*', sessionMiddleware({ auth: service, resolve: (context) => ({ gymId: gymOf(context.req.url), origin: origins[gymOf(context.req.url)]!, clientIp }) }));
  for (const route of createAuthBootstrapRoutes({ login: () => ({ password: false, magicLink: true, google: true }) })) route.mount(app, permissionMiddleware);
  const bootstrap = async (cookie: string, gym = gymId) => {
    const response = await app.request(origins[gym] + '/api/auth/bootstrap', { headers: { cookie } });
    expect(response.status).toBe(200);
    return shellBootstrapResponseSchema.parse(await response.json()).data.session;
  };
  return { gymId, otherGymId, origins, start, authorize, callback, signIn, bootstrap };
}
async function user(gymId: string, emailVerified: boolean) {
  return factory('authUser', gymId, { emailVerified, email: `${uuidv7()}@example.test` });
}
const googleAccounts = (userId: string) => database.system.db.select().from(authAccount).where(eq(authAccount.userId, userId));
const sessions = (userId: string) => database.system.db.select().from(authSession).where(eq(authSession.userId, userId));

describe('Google credentials', () => {
  it('come from the instance configuration, both or neither, and never in demo mode', () => {
    expect(googleFromEnvironment({})).toBeNull();
    expect(googleFromEnvironment({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })).toBeNull(); // Compose passes unset values as empty
    expect(googleFromEnvironment({ GOOGLE_CLIENT_ID: ' id ', GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(() => googleFromEnvironment({ GOOGLE_CLIENT_ID: 'id' })).toThrow(/both/);
    expect(() => googleFromEnvironment({ GOOGLE_CLIENT_SECRET: 'secret' })).toThrow(/both/);
    expect(() => googleFromEnvironment({ GOOGLE_CLIENT_ID: 'an id', GOOGLE_CLIENT_SECRET: 'secret' })).toThrow(/Invalid/);
    expect(googleFromEnvironment({ DEMO_MODE: 'true', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).toBeNull();
  });
  it('without them, neither Google endpoint exists', async () => {
    const f = await fixture(single, null);
    expect((await f.start()).status).toBe(404);
    expect((await f.callback(f.gymId, '?code=x&state=' + 'a'.repeat(32), '')).status).toBe(404);
  });
});

describe('Google sign-in', () => {
  it('signs a staff login in with a gym-bound session and stores no Google tokens', async () => {
    const f = await fixture(), staff = await user(f.gymId, true);
    await factory('staffRoles', f.gymId, { userId: staff.id, role: 'coach' });
    const { url } = await f.authorize();
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(credentials.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(f.origins[f.gymId] + googleCallbackPath);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    const result = await f.signIn({ sub: 'google-staff', email: staff.email.toUpperCase(), email_verified: true });
    expect(result.response.status).toBe(302);
    expect(result.location.href).toBe(f.origins[f.gymId] + '/admin');
    expect(result.exchanges[0]?.get('redirect_uri')).toBe(f.origins[f.gymId] + googleCallbackPath);
    expect(await f.bootstrap(result.cookie)).toMatchObject({ userId: staff.id, roles: ['coach'], member: false });
    expect((await sessions(staff.id)).map((session) => session.gymId)).toEqual([f.gymId]);
    const accounts = (await googleAccounts(staff.id)).filter((account) => account.providerId === 'google');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ accountId: 'google-staff', accessToken: null, refreshToken: null, idToken: null });
    // A second sign-in uses the linked account and still stores no tokens.
    const again = await f.signIn({ sub: 'google-staff', email: staff.email, email_verified: true });
    expect(again.location.pathname).toBe('/admin');
    expect((await googleAccounts(staff.id)).filter((account) => account.providerId === 'google')).toMatchObject([{ accessToken: null, refreshToken: null, idToken: null }]);
  });
  it('signs a member login in, which the shell sends on to the portal', async () => {
    const f = await fixture(), login = await user(f.gymId, true);
    const household = await factory('households', f.gymId);
    const member = await factory('members', f.gymId, { householdId: household.id, firstName: 'Ana', lastName: 'Member' });
    await factory('householdUsers', f.gymId, { userId: login.id, householdId: household.id, memberId: member.id, scope: 'member' });
    const result = await f.signIn({ sub: 'google-member', email: login.email, email_verified: true });
    expect(result.location.pathname).toBe('/admin');
    expect(await f.bootstrap(result.cookie)).toMatchObject({ userId: login.id, roles: [], member: true });
  });
  it('links to an existing login only when both its address and the Google address are verified', async () => {
    const f = await fixture();
    // A password login set up without email has an unverified address: Google never takes it over.
    const unverified = await user(f.gymId, false);
    const refused = await f.signIn({ sub: 'google-unverified-local', email: unverified.email, email_verified: true });
    expect(refused.location.href).toBe(f.origins[f.gymId] + '/login?error=account_not_linked');
    expect(refused.cookie).not.toContain('session_token');
    expect(await googleAccounts(unverified.id)).toEqual([]);
    expect(await sessions(unverified.id)).toEqual([]);
    // Nor does a Google account whose own address Google hasn't verified.
    const verified = await user(f.gymId, true);
    const unconfirmed = await f.signIn({ sub: 'google-unverified-remote', email: verified.email, email_verified: false });
    expect(unconfirmed.location.searchParams.get('error')).toBe('account_not_linked');
    expect(await googleAccounts(verified.id)).toEqual([]);
    expect(await sessions(verified.id)).toEqual([]);
  });
  it('never creates a login for an address the gym has not provisioned', async () => {
    const f = await fixture(), email = `${uuidv7()}@example.test`;
    const result = await f.signIn({ sub: 'google-stranger', email, email_verified: true });
    expect(result.location.pathname).toBe('/login');
    expect(result.location.searchParams.get('error')).toBe('signup_disabled');
    expect(await database.system.db.select().from(authUser).where(eq(authUser.email, email))).toEqual([]);
  });
  it('accepts only a plain Google sign-in request', async () => {
    const f = await fixture();
    for (const body of [{ provider: 'google', idToken: { token: 'forged' } }, { provider: 'google', scopes: ['drive'] }, { provider: 'google', additionalData: { gym: 'x' } },
      { provider: 'google', requestSignUp: true }, { provider: 'github' }, ['google']]) expect((await f.start(f.gymId, body)).status).toBe(403);
  });
});

describe('Google state is bound to the gym that issued it', () => {
  for (const [mode, config] of [['single', single], ['multi', multi]] as const) {
    it(`refuses gym A's state at gym B's callback (${mode})`, async () => {
      const f = await fixture(config), login = await user(f.gymId, true);
      const exchanges = googleAnswers({ sub: `google-cross-${mode}`, email: login.email, email_verified: true });
      const { state, cookie } = await f.authorize(f.gymId);
      const [row] = await database.system.db.select().from(authVerification).where(eq(authVerification.identifier, `auth-state:${state}`));
      expect((JSON.parse(row!.value) as { serverContext: Record<string, string> }).serverContext[googleStateGymKey]).toBe(f.gymId);
      // Replayed at B, with A's state cookie as an attacker would send it: refused before any code exchange or session.
      expect((await f.callback(f.otherGymId, `?code=stolen-code&state=${state}`, cookie)).status).toBe(403);
      expect(exchanges).toEqual([]);
      expect(await sessions(login.id)).toEqual([]);
      // The state is untouched, so the sign-in still completes where it started.
      const completed = await f.callback(f.gymId, `?code=consent-code&state=${state}`, cookie);
      expect(completed.headers.get('location')).toBe(f.origins[f.gymId] + '/admin');
      expect((await sessions(login.id)).map((session) => session.gymId)).toEqual([f.gymId]);
    });
  }
  it('refuses unknown, malformed, repeated and expired states, and states without a gym', async () => {
    const f = await fixture(), exchanges = googleAnswers({ sub: 'google-x', email: 'x@example.test', email_verified: true });
    const { state, cookie } = await f.authorize();
    for (const query of ['?code=x', `?code=x&state=${'b'.repeat(32)}`, '?code=x&state=%27or%201=1', `?code=x&state=${state}&state=${state}`])
      expect((await f.callback(f.gymId, query, cookie)).status).toBe(403);
    // A state row another flow wrote, without this gym in its server context.
    const foreign = 'c'.repeat(32);
    await database.system.db.insert(authVerification).values({ identifier: `auth-state:${foreign}`, value: JSON.stringify({ callbackURL: '/admin', codeVerifier: 'v', expiresAt: Date.now() + 60_000 }), expiresAt: new Date(Date.now() + 60_000) });
    expect((await f.callback(f.gymId, `?code=x&state=${foreign}`, cookie)).status).toBe(403);
    // Expired: the extension's clock is past the row's expiry.
    const later = await fixture(single, createGoogleAuthExtension({ credentials, database: () => database.system.db, now: () => new Date(Date.now() + 11 * 60_000) }));
    const pending = await later.authorize();
    expect((await later.callback(later.gymId, `?code=x&state=${pending.state}`, pending.cookie)).status).toBe(403);
    expect(exchanges).toEqual([]);
  });
});

describe('Google in multi mode', () => {
  it('uses the instance client for every gym, each with its own redirect URI and gym-bound sessions', async () => {
    const f = await fixture(multi), login = await user(f.gymId, true);
    await factory('staffRoles', f.gymId, { userId: login.id, role: 'owner' });
    const household = await factory('households', f.otherGymId);
    await factory('householdUsers', f.otherGymId, { userId: login.id, householdId: household.id, scope: 'payer' });
    for (const gym of [f.gymId, f.otherGymId]) {
      const { url } = await f.authorize(gym);
      expect(url.searchParams.get('client_id')).toBe(credentials.clientId);
      expect(url.searchParams.get('redirect_uri')).toBe(f.origins[gym] + googleCallbackPath);
    }
    const atA = await f.signIn({ sub: 'google-multi', email: login.email, email_verified: true }, f.gymId);
    const atB = await f.signIn({ sub: 'google-multi', email: login.email, email_verified: true }, f.otherGymId);
    expect(atA.exchanges[0]?.get('client_id')).toBe(credentials.clientId);
    expect(await f.bootstrap(atA.cookie, f.gymId)).toMatchObject({ roles: ['owner'], member: false });
    expect(await f.bootstrap(atB.cookie, f.otherGymId)).toMatchObject({ roles: [], member: true });
    // Each session belongs to its own gym only.
    const response = await f.bootstrap(atA.cookie, f.otherGymId).catch((error: unknown) => error);
    expect(response).toBeInstanceOf(Error);
    expect((await sessions(login.id)).map((session) => session.gymId).sort()).toEqual([f.gymId, f.otherGymId].sort());
  });
});
