// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { authAccount, authSession, authVerification, authRateLimit, staffRoles, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles as roleNames } from '@plaingym/shared';
import { runInTransaction } from '@plaingym/shared/transaction';
import { createAuthService, authEndpoints } from './service.js';
import { authConfig } from './config.js';
import { createAccountService } from './accounts.js';
import { sessionMiddleware } from './middleware.js';
import { passwordAdapter } from './password.js';
import { authContract } from '../../core/registry-infra-contracts.js';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { assertCanResetPassword, resetStaffPassword } from '../../areas/staff/auth.reset.js';
import { routes } from '../../areas/staff/auth.routes.js';
import { createAuthCommands } from '../../cli/auth.js';

const database = useTestDatabase();
const factory = createFactories(database);
const secret = 'auth-integration-test-secret-at-least-32-characters';
const config = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on' }, false);
const testClock = new TestClock('2026-10-22T16:00:00Z');
const password = 'original-password-123';
let ip = 1;
let initialHash: string;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('AUTH_PASSWORD_LOGIN', 'on'); vi.stubEnv('TENANCY', 'single');
  initialHash = await passwordAdapter.hash(password);
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

async function fixture() {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGymId);
  const user = await factory('authUser', gymId, { emailVerified: true });
  await factory('authAccount', gymId, { userId: user.id, accountId: user.id, password: initialHash });
  const origin = `https://${gymId}.example.test`, otherOrigin = `https://${otherGymId}.example.test`;
  const clientIp = `192.0.2.${ip++}`;
  const delivered: { email: string; url: string; gymId: string }[] = [];
  const service = createAuthService({ config, database: () => database.system.db, sendMagicLink: async (data) => { delivered.push(data); } });
  const a = service.bind({ gymId, origin, clientIp }), b = service.bind({ gymId: otherGymId, origin: otherOrigin, clientIp });
  const request = (path: string, body?: unknown, cookie?: string, targetOrigin = origin) => new Request(new URL('/api/auth' + path, targetOrigin), {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: targetOrigin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const signIn = async (target = a, targetOrigin = origin) => target.handler(request('/sign-in/email', { email: user.email.toUpperCase(), password }, undefined, targetOrigin));
  return { gymId, otherGymId, user, origin, otherOrigin, delivered, service, a, b, request, signIn, clientIp };
}
function cookies(response: Response) { return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; '); }

authContract('Postgres Better Auth', async () => {
  const f = await fixture();
  const a = await f.signIn(), b = await f.signIn(f.b, f.otherOrigin);
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  return { auth: f.a, userId: f.user.id, authenticated: f.request('/get-session', undefined, cookies(a)), otherGym: f.request('/get-session', undefined, cookies(b)) };
});

describe('Better Auth HTTP containment', () => {
  it('uses the resolved HTTPS origin behind an HTTP proxy and keeps POST origin checks', async () => {
    const f = await fixture();
    const request = (origin: string, site = 'same-origin') => new Request('http://internal.invalid/api/auth/sign-in/email', {
      method: 'POST', headers: { origin, 'sec-fetch-site': site, 'content-type': 'application/json',
        host: 'untrusted.invalid', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'untrusted.invalid' },
      body: JSON.stringify({ email: f.user.email, password }),
    });
    const response = await f.a.handler(request(f.origin));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(await f.a.getSession(f.request('/get-session', undefined, cookies(response)))).toEqual({ userId: f.user.id });
    expect((await f.a.handler(request('https://foreign.invalid'))).status).toBe(403);
    expect((await f.a.handler(request(f.origin, 'cross-site'))).status).toBe(403);
  });
  it('signs in by lowercase email using UUIDs and secure host-only cookies', async () => {
    const f = await fixture(), response = await f.signIn();
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie')!;
    expect(header).toContain('HttpOnly'); expect(header).toContain('Secure'); expect(header).toContain('SameSite=Lax'); expect(header).not.toMatch(/domain=/i);
    const payload = await response.json(); expect(payload).not.toHaveProperty('token');
    expect(await f.a.getSession(f.request('/get-session', undefined, cookies(response)))).toEqual({ userId: f.user.id });
    const [session] = await database.system.db.select().from(authSession).where(eq(authSession.userId, f.user.id));
    expect(session?.gymId).toBe(f.gymId); expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('rejects foreign sessions before any auth handler can revoke or read them', async () => {
    const f = await fixture(), login = await f.signIn(), cookie = cookies(login);
    expect(await f.b.getSession(f.request('/get-session', undefined, cookie, f.otherOrigin))).toBeNull();
    for (const [path, body] of [['/get-session', undefined], ['/sign-out', {}]] as const) expect((await f.b.handler(f.request(path, body, cookie, f.otherOrigin))).status).toBe(403);
    expect(await f.a.getSession(f.request('/get-session', undefined, cookie))).toEqual({ userId: f.user.id });
  });
  it('blocks every non-allowlisted endpoint in the installed library inventory', async () => {
    const f = await fixture();
    const raw = betterAuth({ secret, baseURL: f.origin, plugins: [magicLink({ sendMagicLink: async () => {} })] });
    let blocked = 0;
    for (const endpoint of Object.values(raw.api)) {
      const route = endpoint as unknown as { path?: string; options?: { method?: string | string[] } };
      if (!route.path) continue;
      const methods = [route.options?.method ?? 'GET'].flat();
      for (const method of methods) {
        const path = route.path.replace(':id', uuidv7()).replace(':provider', 'google');
        if (authEndpoints.some((key) => key === `${method} ${path}`)) continue;
        const response = await f.a.handler(new Request(new URL('/api/auth' + path, f.origin), { method, headers: { origin: f.origin, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) }));
        expect(response.status, `${method} ${path}`).toBe(404); blocked++;
      }
    }
    expect(blocked).toBeGreaterThan(20);
    for (const path of ['/list-sessions', '/revoke-other-sessions', '/revoke-session', '/revoke-sessions', '/sign-up/email', '/request-password-reset', '/callback/google']) expect((await f.a.handler(f.request(path, {}))).status).toBe(404);
  });
  it('cannot use a valid A session on A to read or end B sessions', async () => {
    const f = await fixture(), a = await f.signIn(), b = await f.signIn(f.b, f.otherOrigin);
    for (const path of ['/list-sessions', '/revoke-other-sessions', '/revoke-sessions']) expect((await f.a.handler(f.request(path, {}, cookies(a)))).status).toBe(404);
    expect(await f.b.getSession(f.request('/get-session', undefined, cookies(b), f.otherOrigin))).toEqual({ userId: f.user.id });
  });
  it('pins callbacks to the canonical gym and stores only hashed gym-prefixed magic tokens', async () => {
    const f = await fixture();
    expect((await f.a.handler(f.request('/sign-in/magic-link', { email: f.user.email.toUpperCase(), callbackURL: f.otherOrigin, newUserCallbackURL: 'https://evil.test', errorCallbackURL: 'https://evil.test', gymId: f.otherGymId }))).status).toBe(200);
    const url = new URL(f.delivered[0]!.url), token = url.searchParams.get('token')!;
    expect(url.origin).toBe(f.origin); expect(token).toMatch(new RegExp('^' + f.gymId + '[.]'));
    expect(url.searchParams.get('callbackURL')).toBe(f.origin + '/admin');
    const rows = await database.system.db.select().from(authVerification);
    expect(rows.some((row) => row.identifier.includes(token) || row.value.includes(token))).toBe(false);
    expect((await f.b.handler(new Request(f.delivered[0]!.url.replace(f.origin, f.otherOrigin)))).status).toBe(403);
    url.searchParams.set('callbackURL', f.otherOrigin);
    const response = await f.a.handler(new Request(url));
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe(f.origin + '/admin');
    expect(await f.a.getSession(f.request('/get-session', undefined, cookies(response)))).toEqual({ userId: f.user.id });
    const replay = await f.a.handler(new Request(url));
    expect(replay.headers.get('location')).toContain('INVALID_TOKEN'); expect(cookies(replay)).toBe('');
  });
  it('isolates concurrent A/B issuances and redemption, with exactly one session per token', async () => {
    const f = await fixture();
    await Promise.all([f.a.handler(f.request('/sign-in/magic-link', { email: f.user.email })), f.b.handler(f.request('/sign-in/magic-link', { email: f.user.email }, undefined, f.otherOrigin))]);
    const linkA = f.delivered.find((value) => value.gymId === f.gymId)!.url;
    const linkB = f.delivered.find((value) => value.gymId === f.otherGymId)!.url;
    const wrong = await Promise.all([f.a.handler(new Request(linkB.replace(f.otherOrigin, f.origin))), f.b.handler(new Request(linkA.replace(f.origin, f.otherOrigin)))]);
    expect(wrong.map((res) => res.status)).toEqual([403, 403]);
    const responses = await Promise.all([f.a.handler(new Request(linkA)), f.a.handler(new Request(linkA)), f.b.handler(new Request(linkB)), f.b.handler(new Request(linkB))]);
    expect(responses.filter((res) => cookies(res)).length).toBe(2);
    const rows = await database.system.db.select().from(authSession).where(eq(authSession.userId, f.user.id));
    expect(rows.map((row) => row.gymId).sort()).toEqual([f.gymId, f.otherGymId].sort());
  });
  it('rejects an expired magic link without issuing a session', async () => {
    const f = await fixture();
    await f.a.handler(f.request('/sign-in/magic-link', { email: f.user.email }));
    await database.system.db.update(authVerification).set({ expiresAt: new Date('2000-01-01') });
    const response = await f.a.handler(new Request(f.delivered[0]!.url));
    expect(response.headers.get('location')).toContain('INVALID_TOKEN'); expect(cookies(response)).toBe('');
  });
  it('enforces origin and password/magic availability, never trusting forwarded origin or IP', async () => {
    const f = await fixture();
    const request = f.request('/sign-in/email', { email: f.user.email, password });
    request.headers.set('origin', 'https://evil.test'); request.headers.set('x-forwarded-host', new URL(f.origin).host);
    expect((await f.a.handler(request)).status).toBe(403);
    const missingOrigin = f.request('/sign-out', {}); missingOrigin.headers.delete('origin'); expect((await f.a.handler(missingOrigin)).status).toBe(403);
    const noPassword = createAuthService({ config: { ...config, passwordEnabled: false }, database: () => database.system.db }).bind({ gymId: f.gymId, origin: f.origin, clientIp: f.clientIp });
    expect((await noPassword.handler(f.request('/sign-in/email', { email: f.user.email, password }))).status).toBe(404);
    expect((await noPassword.handler(f.request('/sign-in/magic-link', { email: f.user.email }))).status).toBe(404);
    expect(() => f.service.bind({ gymId: f.gymId, origin: 'https://evil.test/path', clientIp: f.clientIp })).toThrow('canonical');
  });
  it('decides password and magic-link login per gym under AUTH_PASSWORD_LOGIN=auto', async () => {
    const f = await fixture();
    const auto = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'auto' }, false);
    const service = createAuthService({ config: auto, database: () => database.system.db, sendMagicLink: async (data) => { f.delivered.push(data); } });
    const withEmail = service.bind({ gymId: f.gymId, origin: f.origin, clientIp: f.clientIp, smtpConfigured: true });
    expect((await withEmail.handler(f.request('/sign-in/email', { email: f.user.email, password }))).status).toBe(404);
    expect((await withEmail.handler(f.request('/sign-in/magic-link', { email: f.user.email }))).status).toBe(200);
    expect(f.delivered.at(-1)).toMatchObject({ email: f.user.email.toLowerCase(), gymId: f.gymId });
    const withoutEmail = service.bind({ gymId: f.gymId, origin: f.origin, clientIp: `198.51.100.${ip++}`, smtpConfigured: false });
    expect((await withoutEmail.handler(f.request('/sign-in/magic-link', { email: f.user.email }))).status).toBe(404);
    expect((await withoutEmail.handler(f.request('/sign-in/email', { email: f.user.email, password }))).status).toBe(200);
    const off = createAuthService({ config: authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'off' }, false),
      database: () => database.system.db }).bind({ gymId: f.gymId, origin: f.origin, clientIp: f.clientIp, smtpConfigured: false });
    expect((await off.handler(f.request('/sign-in/email', { email: f.user.email, password }))).status).toBe(404);
  });
  it('persists IP+path limits across instances and cannot bypass them with spoofed headers', async () => {
    const f = await fixture();
    const make = () => createAuthService({ config, database: () => database.system.db, rateLimit: { window: 60, max: 2 } }).bind({ gymId: f.gymId, origin: f.origin, clientIp: f.clientIp });
    for (let i = 0; i < 2; i++) {
      const request = f.request('/sign-in/email', { email: f.user.email, password });
      request.headers.set('x-forwarded-for', `198.51.100.${i}`); request.headers.set('x-plaingym-client-ip', `198.51.100.${i}`);
      expect((await make().handler(request)).status).toBe(200);
    }
    expect((await make().handler(f.request('/sign-in/email', { email: f.user.email, password }))).status).toBe(429);
    const limits = await database.system.db.select().from(authRateLimit);
    expect(limits.some((row) => row.key.includes(f.clientIp) && row.key.includes('/sign-in/email'))).toBe(true);
  });
  it('rejects auth calls inside a transaction', async () => {
    const f = await fixture();
    await expect(runInTransaction(() => f.a.getSession(f.request('/get-session')))).rejects.toThrow();
    await expect(runInTransaction(() => f.a.handler(f.request('/get-session')))).rejects.toThrow();
  });
});

function routeApp(f: Awaited<ReturnType<typeof fixture>>) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.onError((error, context) => context.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  app.use('*', async (context, next) => {
    const other = new URL(context.req.url).origin === f.otherOrigin;
    context.set('context', { requestId: 'test', gym: { gymId: other ? f.otherGymId : f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, clock: testClock });
    await next();
  });
  app.use('*', sessionMiddleware({ auth: f.service, resolve: (context) => ({ gymId: context.get('context').gym.gymId, origin: new URL(context.req.url).origin === f.otherOrigin ? f.otherOrigin : f.origin, clientIp: f.clientIp }) }));
  for (const route of routes) route.mount(app, authorize);
  app.get('/me', authorize({ kind: 'staff', capability: 'members.read' }), (context) => context.json(context.get('context').principal));
  return app;
}
describe('session middleware and atomic protected-account resets', () => {
  it('lets the registered bootstrap route run after session resolution and isolates its projection', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'coach' });
    await factory('staffRoles', f.otherGymId, { userId: f.user.id, role: 'owner' });
    await factory('householdUsers', f.gymId, { userId: f.user.id });
    const app = routeApp(f), cookie = cookies(await f.signIn());
    const response = await app.request(f.origin + '/api/auth/bootstrap', { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ data: { gym: { id: f.gymId, name: 'Test Gym' }, session: { userId: f.user.id, roles: ['coach'], member: true }, login: { password: true, magicLink: false } } });
    const anonymous = await app.request(f.otherOrigin + '/api/auth/bootstrap');
    expect(await anonymous.json()).toMatchObject({ data: { gym: { id: f.otherGymId }, session: null } });
    expect((await app.request(f.otherOrigin + '/api/auth/bootstrap', { headers: { cookie } })).status).toBe(403);
  });
  it('sets staff roles from the resolved gym and rejects foreign cookies before handlers', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'owner' });
    const cookie = cookies(await f.signIn()), app = routeApp(f);
    const response = await app.request(f.origin + '/me', { headers: { cookie } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ userId: f.user.id, roles: ['owner'] });
    expect((await app.request(f.otherOrigin + '/me', { headers: { cookie } })).status).toBe(403);
    expect((await app.request(f.origin + '/me')).status).toBe(401);
  });
  it('rejects missing or mismatched trusted gym context', async () => {
    const f = await fixture();
    const app = new OpenAPIHono<RequestEnvironment>();
    app.onError((error, context) => context.json({ error: error.message }, error instanceof AppError ? error.status : 500));
    app.use('*', sessionMiddleware({ auth: f.service, resolve: () => ({ gymId: f.gymId, origin: f.origin, clientIp: f.clientIp }) }));
    app.get('/', (context) => context.text('never'));
    expect((await app.request('/')).status).toBe(404);
  });
  it('reloads every resetter/target role pairing, including a member who is also staff', async () => {
    const f = await fixture();
    for (const actorRole of roleNames) {
      const actor = await factory('authUser', f.gymId);
      await factory('staffRoles', f.gymId, { userId: actor.id, role: actorRole });
      for (const targetRole of [...roleNames, null]) {
        const target = await factory('authUser', f.gymId);
        if (targetRole) await factory('staffRoles', f.gymId, { userId: target.id, role: targetRole });
        await factory('householdUsers', f.gymId, { userId: target.id });
        const allowed = actorRole === 'owner' && targetRole !== 'owner' || actorRole === 'admin' && targetRole !== 'owner' && targetRole !== 'admin' || actorRole === 'front_desk' && targetRole === null;
        const check = database.forGym(f.gymId, (tx) => assertCanResetPassword(tx, { gymId: f.gymId, actorUserId: actor.id, targetUserId: target.id }));
        if (allowed) await expect(check).resolves.toBeUndefined(); else await expect(check).rejects.toMatchObject({ code: 'forbidden' });
      }
    }
  });
  it('resets a lower-role password, ends all sessions, and audits without secret data', async () => {
    const f = await fixture(), actor = await factory('authUser', f.gymId);
    await factory('staffRoles', f.gymId, { userId: actor.id, role: 'admin' });
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'coach' });
    const a = await f.signIn(), b = await f.signIn(f.b, f.otherOrigin);
    await resetStaffPassword({ gymId: f.gymId, actorUserId: actor.id, targetUserId: f.user.id, newPassword: 'replacement-password', clock: testClock });
    expect(await f.a.getSession(f.request('/get-session', undefined, cookies(a)))).toBeNull();
    expect(await f.b.getSession(f.request('/get-session', undefined, cookies(b), f.otherOrigin))).toBeNull();
    expect((await f.signIn()).status).toBe(401);
    expect((await f.a.handler(f.request('/sign-in/email', { email: f.user.email, password: 'replacement-password' }))).status).toBe(200);
    const audits = await database.forGym(f.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.user.id)));
    expect(audits).toHaveLength(1); expect(audits[0]).toMatchObject({ action: 'auth.password_reset', occurredAt: testClock.now(), actorUserId: actor.id });
    expect(JSON.stringify(audits)).not.toMatch(/replacement-password|argon2id/);
  });
  it('rolls back password, sessions, and audit when authorization fails', async () => {
    const f = await fixture(), actor = await factory('authUser', f.gymId);
    await factory('staffRoles', f.gymId, { userId: actor.id, role: 'admin' });
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'owner' });
    const cookie = cookies(await f.signIn());
    await expect(resetStaffPassword({ gymId: f.gymId, actorUserId: actor.id, targetUserId: f.user.id, newPassword: 'replacement-password', clock: testClock })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await f.a.getSession(f.request('/get-session', undefined, cookie))).toEqual({ userId: f.user.id });
    const [account] = await database.system.db.select().from(authAccount).where(eq(authAccount.userId, f.user.id)); expect(account?.password).toBe(initialHash);
  });
  it('requires allow/deny route permission, and returns 404 for a foreign target', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'admin' });
    const target = await factory('authUser', f.otherGymId); await factory('staffRoles', f.otherGymId, { userId: target.id, role: 'coach' });
    const cookie = cookies(await f.signIn()), app = routeApp(f);
    const request = (targetId: string, authCookie?: string) => app.request(f.origin + `/api/staff/users/${targetId}/reset-password`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) }, body: JSON.stringify({ newPassword: 'replacement-password' }) });
    expect((await request(target.id, cookie)).status).toBe(404);
    expect((await request(target.id)).status).toBe(401);
    await database.forGym(f.gymId, (tx) => tx.update(staffRoles).set({ role: 'coach' }).where(eq(staffRoles.userId, f.user.id)));
    expect((await request(target.id, cookie)).status).toBe(403);
    const local = await factory('authUser', f.gymId); await factory('staffRoles', f.gymId, { userId: local.id, role: 'front_desk' });
    await database.forGym(f.gymId, (tx) => tx.update(staffRoles).set({ role: 'admin' }).where(eq(staffRoles.userId, f.user.id)));
    expect((await request(local.id, cookie)).status).toBe(200);
  });
  it('refuses resets in multi mode and resets only a current owner through the CLI', async () => {
    const f = await fixture(); await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'owner' });
    const cookie = cookies(await f.signIn());
    const accounts = createAccountService(config, () => database.system.db);
    const errors: string[] = [], messages: string[] = [];
    const commands = createAuthCommands(() => ({ accounts, resolveGymId: async () => f.gymId, readPassword: async () => 'owner-new-password' }));
    expect(await commands[0]!.run(['reset-password', f.user.email.toUpperCase()], { stdout: (message) => messages.push(message), stderr: (message) => errors.push(message) })).toBe(0);
    expect(errors).toEqual([]); expect(messages.join(' ')).not.toContain('owner-new-password');
    expect(await f.a.getSession(f.request('/get-session', undefined, cookie))).toBeNull();
    const disabled = createAccountService({ ...config, tenancy: 'multi', passwordEnabled: false }, () => database.system.db);
    await expect(disabled.resetPassword({ gymId: f.gymId, userId: f.user.id, newPassword: 'new-password-123', clock: testClock, authorize: async () => {} })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('account provisioning and reset durability', () => {
  it('provisions one lowercase install-wide identity without granting gym access', async () => {
    const f = await fixture(), accounts = createAccountService(config, () => database.system.db);
    const email = uuidv7() + '@example.test';
    const a = await accounts.provisionUser(f.gymId, email.toUpperCase(), 'Invitee', testClock);
    const b = await accounts.provisionUser(f.otherGymId, email, 'Invitee', testClock);
    expect(b.id).toBe(a.id); expect(await accounts.findUserByEmail(email.toUpperCase())).toEqual(a);
    expect(await accounts.hasPassword(a.id)).toBe(false);
    expect(await database.forGym(f.gymId, (tx) => tx.select().from(staffRoles).where(eq(staffRoles.userId, a.id)))).toEqual([]);
  });
  it('creates a local password account with the portable adapter and enforces password policy', async () => {
    const f = await fixture(), accounts = createAccountService(config, () => database.system.db);
    const email = uuidv7() + '@example.test';
    const user = await accounts.createPasswordUser(f.gymId, email.toUpperCase(), 'Owner', password, testClock);
    expect(await accounts.findUserByEmail(email)).toEqual({ id: user.userId });
    expect(await accounts.hasPassword(user.userId)).toBe(true);
    const response = await f.a.handler(f.request('/sign-in/email', { email, password }));
    expect(response.status).toBe(200);
    await expect(accounts.createPasswordUser(f.gymId, 'short@example.test', 'Owner', 'short', testClock)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('rolls back a credential change and session deletion if the final audit insert fails', async () => {
    const f = await fixture(), cookie = cookies(await f.signIn());
    const accounts = createAccountService(config, () => database.system.db);
    await expect(accounts.resetPassword({ gymId: f.gymId, userId: f.user.id, actorUserId: uuidv7(), newPassword: 'rolled-back-password', clock: testClock, authorize: async () => {} })).rejects.toThrow();
    expect(await f.a.getSession(f.request('/get-session', undefined, cookie))).toEqual({ userId: f.user.id });
    const [account] = await database.system.db.select().from(authAccount).where(eq(authAccount.userId, f.user.id));
    expect(account?.password).toBe(initialHash);
  });
  it('keeps concurrent IP limits atomic', async () => {
    const f = await fixture();
    const limited = createAuthService({ config, database: () => database.system.db, rateLimit: { window: 60, max: 3 } }).bind({ gymId: f.gymId, origin: f.origin, clientIp: f.clientIp });
    const responses = await Promise.all(Array.from({ length: 12 }, () => limited.handler(f.request('/sign-in/email', { email: f.user.email, password }))));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(9);
  });
});
