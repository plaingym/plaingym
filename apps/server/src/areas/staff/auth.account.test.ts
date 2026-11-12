// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The route test checks the login's address and the gym's audit in real PostgreSQL.
import { authUser, auditEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the real database pools for this isolated composition test.
import { closeDatabase, initializeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, createTranslator, errorResponse } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { accountContracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { createAuthService } from '../../infra/auth/service.js';
import { authConfig } from '../../infra/auth/config.js';
import { sessionMiddleware } from '../../infra/auth/middleware.js';
import { passwordAdapter } from '../../infra/auth/password.js';
import { createEmailChangeService, type EmailChangeMail } from '../../infra/auth/email-change.js';
import { FakeEmail } from '../../infra/email/index.js';
import { createPortalPrincipalLoader } from '../members/household-users.context.js';
import { authorize } from './auth.permissions.js';
import { createAccountRoutes } from './auth.account.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-11-12T10:00:00Z');
const secret = 'account-route-test-secret-at-least-32-characters';
const config = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on' }, false);
const password = 'account-password-123', t = createTranslator(locales.en ?? {});
let hash: string, address = 1;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('AUTH_PASSWORD_LOGIN', 'on'); vi.stubEnv('TENANCY', 'single');
  hash = await passwordAdapter.hash(password);
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

/** Two gyms on their own origins; logins with passwords sign in to either. */
async function fixture() {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGymId);
  const origins: Record<string, string> = { [gymId]: `https://${gymId}.example.test`, [otherGymId]: `https://${otherGymId}.example.test` };
  const clientIp = `192.0.4.${address++}`, auth = createAuthService({ config, database: () => database.system.db, sendMagicLink: async () => undefined });
  const withPassword = async (userId: string) => {
    await database.system.db.update(authUser).set({ emailVerified: true }).where(eq(authUser.id, userId));
    await factory('authAccount', gymId, { userId, accountId: userId, password: hash });
    return (await database.system.db.select().from(authUser).where(eq(authUser.id, userId)))[0]!;
  };
  const signIn = async (gym: string, email: string) => {
    const response = await auth.bind({ gymId: gym, origin: origins[gym]!, clientIp }).handler(new Request(new URL('/api/auth/sign-in/email', origins[gym]), {
      method: 'POST', headers: { origin: origins[gym]!, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
    expect(response.status).toBe(200);
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  };
  const owner = await withPassword((await factory('staffRoles', gymId, { role: 'owner' })).userId);
  const householdA = await factory('householdUsers', gymId, { scope: 'payer' }), householdB = await factory('householdUsers', gymId, { scope: 'payer' });
  const payerA = await withPassword(householdA.userId), payerB = await withPassword(householdB.userId);
  const email = new FakeEmail();
  const mail: EmailChangeMail = async (id) => ({ origin: origins[id]!, email, gymName: 'Test Gym', t });
  return { gymId, otherGymId, origins, auth, signIn, owner, payerA, payerB, householdA, email, mail };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function routeApp(f: Fixture, options: { tenancy?: 'single' | 'multi'; smtp?: boolean } = {}) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.onError((error, context) => context.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  const gymOf = (url: string) => Object.entries(f.origins).find(([, origin]) => new URL(url).origin === origin)![0];
  app.use('*', async (context, next) => {
    context.set('context', { requestId: 'test', gym: { gymId: gymOf(context.req.url), timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, clock });
    await next();
  });
  app.use('*', sessionMiddleware({ auth: f.auth, resolve: context => ({ gymId: gymOf(context.req.url), origin: f.origins[gymOf(context.req.url)]!, clientIp: '192.0.2.1' }),
    principal: (userId, context, bound) => createPortalPrincipalLoader()(context.get('context').gym.gymId, userId, bound) }));
  const service = createEmailChangeService({ config: { tenancy: options.tenancy ?? 'single' }, database: () => database.system.db });
  for (const route of createAccountRoutes({ service, mail: f.mail, smtpConfigured: async () => options.smtp ?? true })) route.mount(app, authorize);
  return app;
}
const request = (app: ReturnType<typeof routeApp>, f: Fixture, gymId: string, path: string, cookie = '', body?: unknown) =>
  app.request(f.origins[gymId] + path, body === undefined ? { headers: cookie ? { cookie } : {} } : {
    method: 'POST', headers: { origin: f.origins[gymId]!, 'content-type': 'application/json', ...cookie ? { cookie } : {} }, body: JSON.stringify(body) });
const summary = async (app: ReturnType<typeof routeApp>, f: Fixture, cookie: string, gymId = f.gymId) => {
  const response = await request(app, f, gymId, '/api/account', cookie);
  return { status: response.status, body: response.status === 200 ? accountContracts.get.response.parse(await response.json()).data : await response.json() };
};
const tokenOf = (message: { text: string }) => new URL(/https?:\/\/\S+/.exec(message.text)![0]).hash.slice(1);
const emailOf = async (userId: string) => (await database.system.db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, userId)))[0]!.email;

describe('your account routes', () => {
  it('refuses requests without a staff or portal session', async () => {
    const f = await fixture(), app = routeApp(f);
    expect((await request(app, f, f.gymId, '/api/account')).status).toBe(401);
    expect((await request(app, f, f.gymId, '/api/account/email', '', { newEmail: 'anyone@example.test' })).status).toBe(401);
    expect(f.email.messages).toEqual([]);
  });

  it('shows the login and changes its email only when the link sent to the new address is opened', async () => {
    const f = await fixture(), app = routeApp(f);
    const current = await f.signIn(f.gymId, f.owner.email), other = await f.signIn(f.gymId, f.owner.email);
    expect(await summary(app, f, current)).toEqual({ status: 200, body: { email: f.owner.email, password: true, googleLinked: false,
      roles: ['owner'], households: [], pendingEmail: null, emailChange: 'available' } });

    const asked = await request(app, f, f.gymId, '/api/account/email', current, { newEmail: 'owner.moved@example.test' });
    expect(asked.status).toBe(200);
    expect(f.email.messages.map(message => message.to)).toEqual(['owner.moved@example.test']);
    // Asking changes nothing yet: both sessions still work, and the old address still signs in.
    expect(await emailOf(f.owner.id)).toBe(f.owner.email);
    expect((await summary(app, f, other)).body).toMatchObject({ email: f.owner.email, pendingEmail: { email: 'owner.moved@example.test' } });

    const confirmed = await request(app, f, f.gymId, '/api/account/email/confirm', current, { token: tokenOf(f.email.messages[0]!) });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ data: { email: 'owner.moved@example.test' } });
    // The session that asked stays signed in; the other one ended. The old address got the notice.
    expect((await summary(app, f, current)).body).toMatchObject({ email: 'owner.moved@example.test', pendingEmail: null });
    expect((await summary(app, f, other)).status).toBe(401);
    expect(f.email.messages[1]).toMatchObject({ to: f.owner.email });
    const audit = await database.forGym(f.gymId, tx => tx.select().from(auditEvents));
    expect(audit.filter(row => row.action.startsWith('auth.email_change')).sort((a, b) => a.action < b.action ? -1 : 1).map(row => [row.action, row.actorUserId, row.targetId]))
      .toEqual([['auth.email_change_requested', f.owner.id, f.owner.id], ['auth.email_changed', f.owner.id, f.owner.id]]);
    // A second open is refused.
    expect((await request(app, f, f.gymId, '/api/account/email/confirm', '', { token: tokenOf(f.email.messages[0]!) })).status).toBe(404);
  });

  it('refuses an address another login in the gym uses, and a body that names another login', async () => {
    const f = await fixture(), app = routeApp(f), cookie = await f.signIn(f.gymId, f.payerA.email);
    const taken = await request(app, f, f.gymId, '/api/account/email', cookie, { newEmail: f.payerB.email });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: 'conflict', details: { newEmail: ['email_in_use'] } } });
    expect((await request(app, f, f.gymId, '/api/account/email', cookie, { newEmail: 'x@example.test', userId: f.payerB.id })).status).toBe(400);
    expect(f.email.messages).toEqual([]);
    expect(await emailOf(f.payerB.id)).toBe(f.payerB.email);
  });

  it('refuses cross-household requests: one household\'s login can\'t complete another\'s change', async () => {
    const f = await fixture(), app = routeApp(f);
    const a = await f.signIn(f.gymId, f.payerA.email), b = await f.signIn(f.gymId, f.payerB.email);
    expect((await summary(app, f, a)).body).toMatchObject({ email: f.payerA.email, roles: [], households: [{ name: 'Test Household', scope: 'payer' }] });
    expect((await request(app, f, f.gymId, '/api/account/email', a, { newEmail: 'household.a@example.test' })).status).toBe(200);
    const token = tokenOf(f.email.messages[0]!);
    expect((await request(app, f, f.gymId, '/api/account/email/confirm', b, { token })).status).toBe(403);
    expect(await emailOf(f.payerA.id)).toBe(f.payerA.email);
    expect(await emailOf(f.payerB.id)).toBe(f.payerB.email);
    // B's own account is untouched and shows no pending change.
    expect((await summary(app, f, b)).body).toMatchObject({ email: f.payerB.email, pendingEmail: null });
    // Without a session the link still applies, to A only. A's session that asked stays; B's is untouched.
    expect((await request(app, f, f.gymId, '/api/account/email/confirm', '', { token })).status).toBe(200);
    expect(await emailOf(f.payerA.id)).toBe('household.a@example.test');
    expect((await summary(app, f, a)).body).toMatchObject({ email: 'household.a@example.test' });
    expect((await summary(app, f, b)).body).toMatchObject({ email: f.payerB.email });
  });

  it('refuses cross-gym requests: another gym never finds the link, and a session never crosses gyms', async () => {
    const f = await fixture(), app = routeApp(f), cookie = await f.signIn(f.gymId, f.owner.email);
    // The same login is also staff at gym B, as one identity may be.
    await factory('staffRoles', f.otherGymId, { userId: f.owner.id, role: 'owner' });
    expect((await request(app, f, f.gymId, '/api/account/email', cookie, { newEmail: 'cross.gym@example.test' })).status).toBe(200);
    const token = tokenOf(f.email.messages[0]!);
    expect((await request(app, f, f.otherGymId, '/api/account/email/confirm', '', { token })).status).toBe(404);
    const otherCookie = await f.signIn(f.otherGymId, f.owner.email);
    expect((await request(app, f, f.otherGymId, '/api/account/email/confirm', otherCookie, { token })).status).toBe(404);
    // Gym A's session at gym B's origin is refused before any route runs.
    expect((await request(app, f, f.otherGymId, '/api/account', cookie)).status).toBe(403);
    expect((await request(app, f, f.otherGymId, '/api/account/email', cookie, { newEmail: 'other@example.test' })).status).toBe(403);
    expect(await emailOf(f.owner.id)).toBe(f.owner.email);
    // Gym B's view lists only gym B's roles and no change pending there.
    expect((await summary(app, f, otherCookie, f.otherGymId)).body).toMatchObject({ roles: ['owner'], households: [], pendingEmail: null });
  });

  it('says when the change is unavailable: no email for the gym, or several gyms on the install', async () => {
    const f = await fixture(), cookie = await f.signIn(f.gymId, f.owner.email);
    const noEmail = routeApp(f, { smtp: false });
    expect((await summary(noEmail, f, cookie)).body).toMatchObject({ emailChange: 'no_email' });
    expect((await request(noEmail, f, f.gymId, '/api/account/email', cookie, { newEmail: 'nomail@example.test' })).status).toBe(503);
    const multi = routeApp(f, { tenancy: 'multi' });
    expect((await summary(multi, f, cookie)).body).toMatchObject({ emailChange: 'several_gyms' });
    expect((await request(multi, f, f.gymId, '/api/account/email', cookie, { newEmail: 'multi@example.test' })).status).toBe(403);
    expect(f.email.messages).toEqual([]);
  });

  it('serves the confirmation page without the token in its markup', async () => {
    const f = await fixture(), app = routeApp(f);
    const response = await app.request(f.origins[f.gymId] + '/account-email');
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    expect(html).toContain('/api/account/email/confirm');
    expect(html).toContain('location.hash');
  });
});
