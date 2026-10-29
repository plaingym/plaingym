// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { authVerification, authAccount, authSession, householdUsers, signedLinks, uuidv7 } from '@plaingym/db';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { createPortalInvitationService } from '../../areas/members/household-users.invitations.js';
import { createPortalInvitationRoutes, configurePortalAccess } from '../../areas/portal/access.routes.js';
import { createPortalAuthorization } from '../../areas/portal/auth.permissions.js';
import { createMemberHouseholdContext, createPortalPrincipalLoader } from '../../areas/members/household-users.context.js';
import { createApp } from '../../core/app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler, respondError } from '../../core/errors.js';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { FakeEmail } from '../email/index.js';
import { authConfig } from './config.js';
import { createAuthService } from './service.js';
import { sessionMiddleware } from './middleware.js';
import { passwordAdapter } from './password.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-28T12:00:00Z'), mail = new FakeEmail();
const config = authConfig({ AUTH_SECRET: 'portal-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false), password = 'member-test-password-123';
const options = { config, database: () => db.system.db, smtpConfigured: async () => false, mailer: async () => mail, scope: db.forGym, householdScope: db.forHousehold };
const invitations = createPortalInvitationService(options), householdContext = createMemberHouseholdContext(db.forGym);
beforeAll(() => initializeDatabase(db.appUrl)); afterAll(() => closeDatabase());
async function fixture(role: StaffRole = 'owner') {
  const gymId = uuidv7(), otherGymId = uuidv7(); await factory('gyms', gymId); await factory('gyms', otherGymId);
  const actor = await factory('staffRoles', gymId, { role }), home = await factory('households', gymId), other = await factory('households', gymId), foreign = await factory('households', otherGymId);
  const member = await factory('members', gymId, { householdId: home.id });
  const origin = `https://${gymId}.example.test`;
  return { gymId, otherGymId, actor, home, other, foreign, member, origin, role };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function app(f: Fixture, service = invitations, principal?: Principal, gymId = f.gymId) {
  const app = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, ctx) => { if (!result.success) return respondError(ctx, result.error); } });
  app.use('*', async (ctx, next) => { ctx.set('context', { principal: principal ?? { kind: 'staff', gymId, userId: f.actor.userId, roles: [f.role] }, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'portal-invite-test' }); await next(); });
  app.onError(errorHandler); createServerRegistry({ routes: createPortalInvitationRoutes({ service, origin: () => f.origin }) }).mount(app, createPortalAuthorization(householdContext), new Set()); return app;
}
const send = (server: ReturnType<typeof app>, path: string, body: unknown) => server.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const input = () => ({ email: uuidv7() + '@example.test', scope: 'payer' as const, delivery: 'print' as const });
async function invite(f: Fixture) {
  const request = input(), response = await send(app(f), `/api/households/${f.home.id}/portal-invitations`, request);
  expect(response.status).toBe(200);
  const result = await response.json() as { data: { invitationUrl: string; login: { id: string; userId: string } } };
  return { token: new URL(result.data.invitationUrl).hash.slice(1), login: result.data.login, request };
}
describe('portal invitations', () => {
  it.each(staffRoles)('checks invite and password-reset permissions for %s', async role => {
    const f = await fixture(role), server = app(f), allowed = role !== 'coach';
    expect((await send(server, `/api/households/${f.home.id}/portal-invitations`, input())).status).toBe(allowed ? 200 : 403);
    const login = await factory('householdUsers', f.gymId, { householdId: f.home.id });
    expect((await send(server, `/api/households/${f.home.id}/users/${login.id}/password`, { newPassword: password })).status).toBe(allowed ? 200 : 403);
  });
  it('hashes and binds tokens, accepts once, and does not leak access across gyms or households', async () => {
    const f = await fixture(), issued = await invite(f), anonymous = { kind: 'anonymous' as const };
    const [stored] = await db.system.db.select().from(authVerification).where(eq(authVerification.value, JSON.stringify({ userId: issued.login.userId, householdUserId: issued.login.id, householdId: f.home.id, scope: 'payer', memberId: null })));
    expect(stored?.identifier).toContain('portal-invitation:' + f.gymId + ':'); expect(stored?.identifier).not.toContain(issued.token);
    expect((await send(app(f, invitations, anonymous, f.otherGymId), '/api/portal/invitations/accept', { token: issued.token, password })).status).toBe(404);
    expect((await send(app(f, invitations, anonymous), '/api/portal/invitations/accept', { token: issued.token, password, householdId: f.other.id })).status).toBe(400);
    expect((await send(app(f, invitations, anonymous), '/api/portal/invitations/accept', { token: issued.token, password })).status).toBe(200);
    expect((await send(app(f, invitations, anonymous), '/api/portal/invitations/accept', { token: issued.token, password })).status).toBe(404);
    const [credential] = await db.system.db.select().from(authAccount).where(eq(authAccount.userId, issued.login.userId));
    expect(await passwordAdapter.verify({ hash: credential!.password!, password })).toBe(true);
    await expect(householdContext.resolve({ gymId: f.gymId, userId: issued.login.userId, householdId: f.other.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects changed, revoked and expired invitations and invalid member associations', async () => {
    const f = await fixture(), first = await invite(f);
    await db.forGym(f.gymId, tx => tx.update(householdUsers).set({ householdId: f.other.id }).where(eq(householdUsers.id, first.login.id)));
    await expect(invitations.accept(f.gymId, { token: first.token, password }, clock)).rejects.toMatchObject({ code: 'not_found' });
    const second = await invite(f); await db.forGym(f.gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.id, second.login.id)));
    await expect(invitations.accept(f.gymId, { token: second.token, password }, clock)).rejects.toMatchObject({ code: 'not_found' });
    const third = await invite(f);
    await expect(invitations.accept(f.gymId, { token: third.token, password }, new TestClock('2026-11-10T00:00:00Z'))).rejects.toMatchObject({ code: 'not_found' });
    expect((await send(app(f), `/api/households/${f.other.id}/portal-invitations`, { ...input(), scope: 'member', memberId: f.member.id })).status).toBe(404);
    expect((await send(app(f), `/api/households/${f.foreign.id}/portal-invitations`, input())).status).toBe(404);
  });
  it('sends email invitations through the injected gym mailer and refuses passwords in multi mode', async () => {
    const f = await fixture(), before = mail.messages.length;
    const multi = createPortalInvitationService({ ...options, config: { ...config, tenancy: 'multi', passwordEnabled: false, passwordMode: 'off' }, smtpConfigured: async () => true });
    const body = { ...input(), delivery: 'email' };
    expect((await send(app(f, multi), `/api/households/${f.home.id}/portal-invitations`, body)).status).toBe(200);
    expect(mail.messages.length).toBe(before + 1);
    const token = /#([a-f0-9]{64})/.exec(mail.messages.at(-1)!.text)![1]!;
    await expect(multi.accept(f.gymId, { token, password }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(multi.accept(f.gymId, { token }, clock)).resolves.toEqual({ data: null });
  });
  it('never replaces existing credentials on claim and protects staff accounts from front desk resets', async () => {
    const f = await fixture('front_desk'), issued = await invite(f);
    const hash = await passwordAdapter.hash(password);
    await factory('authAccount', f.gymId, { userId: issued.login.userId, accountId: issued.login.userId, password: hash });
    await expect(invitations.accept(f.gymId, { token: issued.token, password: 'different-password-123' }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    await invitations.accept(f.gymId, { token: issued.token, password }, clock);
    const [unchanged] = await db.system.db.select().from(authAccount).where(eq(authAccount.userId, issued.login.userId)); expect(unchanged!.password).toBe(hash);
    await factory('staffRoles', f.gymId, { userId: issued.login.userId, role: 'coach' });
    expect((await send(app(f), `/api/households/${f.home.id}/users/${issued.login.id}/password`, { newPassword: password })).status).toBe(403);
    expect((await send(app(f), `/api/households/${f.other.id}/users/${issued.login.id}/password`, { newPassword: password })).status).toBe(404);
    expect((await send(app(f, invitations, undefined, f.otherGymId), `/api/households/${f.home.id}/users/${issued.login.id}/password`, { newPassword: password })).status).toBe(404);
  });
  it('a reset ends existing sessions and multi mode refuses it', async () => {
    const f = await fixture(), issued = await invite(f), actor = { gymId: f.gymId, userId: f.actor.userId, clock };
    await factory('authSession', f.gymId, { userId: issued.login.userId });
    await invitations.resetPassword(actor, f.home.id, issued.login.id, password);
    expect(await db.system.db.select().from(authSession).where(eq(authSession.userId, issued.login.userId))).toEqual([]);
    const multi = createPortalInvitationService({ ...options, config: { ...config, tenancy: 'multi', passwordEnabled: false, passwordMode: 'off' } });
    await expect(multi.resetPassword(actor, f.home.id, issued.login.id, password)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('cannot use a printed member invitation to set credentials for a protected staff identity', async () => {
    const f = await fixture('front_desk'), issued = await invite(f);
    await factory('staffRoles', f.gymId, { userId: issued.login.userId, role: 'owner' });
    await expect(invitations.accept(f.gymId, { token: issued.token, password }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await db.system.db.select().from(authAccount).where(eq(authAccount.userId, issued.login.userId))).toEqual([]);
    expect((await send(app(f), `/api/households/${f.home.id}/portal-invitations`, issued.request)).status).toBe(403);
  });
  it('onboarding claims derive the household from a live link and reject other gyms, used links and injected household IDs', async () => {
    const f = await fixture(), link = await factory('signedLinks', f.gymId, { householdId: f.home.id, purpose: 'onboarding', invoiceId: null, memberId: null, expiresAt: new Date('2026-11-01T00:00:00Z') });
    const body = { email: uuidv7() + '@example.test', password };
    await expect(invitations.claimOnboarding(f.otherGymId, link.id, body, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(invitations.claimOnboarding(f.gymId, link.id, { ...body, householdId: f.other.id }, clock)).rejects.toThrow();
    await invitations.claimOnboarding(f.gymId, link.id, body, clock);
    const [login] = await db.forGym(f.gymId, tx => tx.select().from(householdUsers).where(eq(householdUsers.householdId, f.home.id)));
    expect(login?.scope).toBe('payer');
    await expect(householdContext.resolve({ gymId: f.gymId, userId: login!.userId, householdId: f.other.id })).rejects.toMatchObject({ code: 'not_found' });
    await db.forGym(f.gymId, tx => tx.update(signedLinks).set({ usedAt: clock.now() }).where(eq(signedLinks.id, link.id)));
    await expect(invitations.claimOnboarding(f.gymId, link.id, body, clock)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('signs in a claimed member through Better Auth and serves the real portal registrations with gym-bound sessions', async () => {
    const f = await fixture(), issued = await invite(f); await invitations.accept(f.gymId, { token: issued.token, password }, clock);
    const auth = createAuthService({ config, database: () => db.system.db, sendMagicLink: async () => undefined });
    const login = await auth.bind({ gymId: f.gymId, origin: f.origin, clientIp: '192.0.2.21' }).handler(new Request(f.origin + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: issued.request.email, password }) }));
    expect(login.status).toBe(200); const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    configurePortalAccess({ service: invitations, origin: () => f.origin });
    const loader = createPortalPrincipalLoader(db.forGym);
    const production = (gymId: string) => createApp({ clock, contributions: areaContributions, authorize: createPortalAuthorization(householdContext), origin: f.origin,
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: sessionMiddleware({ auth, resolve: () => ({ gymId, origin: f.origin, clientIp: '192.0.2.21' }), principal: (userId, ctx) => loader(ctx.get('context').gym.gymId, userId) }),
    });
    const server = production(f.gymId);
    expect((await server.request(f.origin + '/api/portal/context', { headers: { cookie } })).status).toBe(200);
    expect((await server.request(f.origin + '/api/members', { headers: { cookie } })).status).toBe(403);
    expect((await production(f.otherGymId).request(f.origin + '/api/portal/context', { headers: { cookie } })).status).toBe(403);
    const manifest = await server.request(f.origin + '/portal/manifest.webmanifest'); expect(manifest.status).toBe(200);
    for (const icon of (await manifest.json() as { icons: { src: string }[] }).icons) expect((await server.request(f.origin + icon.src)).headers.get('content-type')).toBe('image/png');
    expect(await (await server.request(f.origin + '/portal/sw.js')).text()).not.toContain('caches.');
  });
});

