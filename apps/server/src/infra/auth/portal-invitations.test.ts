// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { auditEvents, authVerification, authAccount, authSession, authUser, householdUsers, signedLinks, uuidv7 } from '@plaingym/db';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { createPortalInvitationService, type PortalLoginLinkSender } from '../../areas/members/household-users.invitations.js';
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
import { createPortalClaimCodes } from './portal-invitations.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-28T12:00:00Z'), mail = new FakeEmail();
const config = authConfig({ AUTH_SECRET: 'portal-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false), password = 'member-test-password-123';
const passwordless = { ...config, tenancy: 'multi' as const, passwordEnabled: false, passwordMode: 'off' as const, smtpConfigured: true };
const sent: Parameters<PortalLoginLinkSender>[0][] = [];
const loginLink: PortalLoginLinkSender = async input => { sent.push(input); };
const options = { config, database: () => db.system.db, smtpConfigured: async () => false, mailer: async () => mail, scope: db.forGym, householdScope: db.forHousehold, loginLink };
const invitations = createPortalInvitationService(options), householdContext = createMemberHouseholdContext(db.forGym);
const emailOnly = createPortalInvitationService({ ...options, config: passwordless, smtpConfigured: async () => true });
const loader = createPortalPrincipalLoader(db.forGym);
let ip = 1;
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
const input = (email = uuidv7() + '@example.test') => ({ email, scope: 'payer' as const, delivery: 'print' as const });
async function invite(f: Fixture, service = invitations, request = input()) {
  const response = await send(app(f, service), `/api/households/${f.home.id}/portal-invitations`, request);
  expect(response.status).toBe(200);
  const result = await response.json() as { data: { invitationUrl: string; invitation: { userId: string; expiresAt: string } } };
  return { token: new URL(result.data.invitationUrl).hash.slice(1), userId: result.data.invitation.userId, request };
}
const links = (gymId: string, userId: string) => db.forGym(gymId, tx => tx.select().from(householdUsers).where(eq(householdUsers.userId, userId)));
const lastClaim = () => sent.at(-1)!.claim;
const onboardingLink = (f: Fixture, overrides: Record<string, unknown> = {}) => factory('signedLinks', f.gymId, { householdId: f.home.id, purpose: 'onboarding', invoiceId: null, memberId: null, expiresAt: new Date('2026-11-01T00:00:00Z'), ...overrides });

describe('portal invitations', () => {
  it.each(staffRoles)('checks invite and password-reset permissions for %s', async role => {
    const f = await fixture(role), server = app(f), allowed = role !== 'coach';
    expect((await send(server, `/api/households/${f.home.id}/portal-invitations`, input())).status).toBe(allowed ? 200 : 403);
    const login = await factory('householdUsers', f.gymId, { householdId: f.home.id });
    expect((await send(server, `/api/households/${f.home.id}/users/${login.id}/password`, { newPassword: password })).status).toBe(allowed ? 200 : 403);
  });
  it('an invitation grants nothing until it is accepted, even for an existing account', async () => {
    const f = await fixture(), existing = await factory('authUser', f.gymId);
    await factory('householdUsers', f.gymId, { householdId: f.other.id, userId: existing.id, scope: 'payer', memberId: null });
    const issued = await invite(f, invitations, input(existing.email));
    expect(issued.userId).toBe(existing.id);
    expect((await links(f.gymId, existing.id)).map(row => row.householdId)).toEqual([f.other.id]);
    expect(await loader(f.gymId, existing.id)).toMatchObject({ kind: 'member', scope: { householdId: f.other.id } });
    await expect(householdContext.resolve({ gymId: f.gymId, userId: existing.id, householdId: f.home.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(db.forHousehold({ kind: 'user', gymId: f.gymId, userId: existing.id, householdId: f.home.id }, q => q.members())).rejects.toThrow('Household access denied');
    const fresh = await invite(f);
    expect(await links(f.gymId, fresh.userId)).toEqual([]);
    expect(await loader(f.gymId, fresh.userId)).toEqual({ kind: 'staff', gymId: f.gymId, userId: fresh.userId, roles: [] });
  });
  it('hashes and binds tokens, accepts once, and does not leak access across gyms or households', async () => {
    const f = await fixture(), issued = await invite(f), anonymous = { kind: 'anonymous' as const };
    const [stored] = await db.system.db.select().from(authVerification).where(eq(authVerification.value, JSON.stringify({ userId: issued.userId, householdId: f.home.id, scope: 'payer', memberId: null })));
    expect(stored?.identifier).toContain('portal-invitation:' + f.gymId + ':'); expect(stored?.identifier).not.toContain(issued.token);
    expect((await send(app(f, invitations, anonymous, f.otherGymId), '/api/portal/invitations/accept', { token: issued.token, password })).status).toBe(404);
    expect((await send(app(f, invitations, anonymous), '/api/portal/invitations/accept', { token: issued.token, password, householdId: f.other.id })).status).toBe(400);
    const accepted = await send(app(f, invitations, anonymous), '/api/portal/invitations/accept', { token: issued.token, password });
    expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ data: { status: 'claimed' } });
    expect((await send(app(f, invitations, anonymous), '/api/portal/invitations/accept', { token: issued.token, password })).status).toBe(404);
    expect((await links(f.gymId, issued.userId)).map(row => [row.householdId, row.scope])).toEqual([[f.home.id, 'payer']]);
    const [credential] = await db.system.db.select().from(authAccount).where(eq(authAccount.userId, issued.userId));
    expect(await passwordAdapter.verify({ hash: credential!.password!, password })).toBe(true);
    await expect(householdContext.resolve({ gymId: f.gymId, userId: issued.userId, householdId: f.other.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects resent, expired and already-linked invitations and invalid member associations', async () => {
    const f = await fixture(), first = await invite(f), resent = await invite(f, invitations, first.request);
    await expect(invitations.accept(f.gymId, { token: first.token, password }, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(invitations.accept(f.gymId, { token: resent.token, password }, new TestClock('2026-11-10T00:00:00Z'))).rejects.toMatchObject({ code: 'not_found' });
    await invitations.accept(f.gymId, { token: resent.token, password }, clock);
    expect((await send(app(f), `/api/households/${f.home.id}/portal-invitations`, first.request)).status).toBe(409);
    expect((await send(app(f), `/api/households/${f.other.id}/portal-invitations`, { ...input(), scope: 'member', memberId: f.member.id })).status).toBe(404);
    expect((await send(app(f), `/api/households/${f.foreign.id}/portal-invitations`, input())).status).toBe(404);
  });
  it('sends email invitations through the injected gym mailer and refuses passwords in passwordless mode', async () => {
    const f = await fixture(), before = mail.messages.length;
    const body = { ...input(), delivery: 'email' };
    expect((await send(app(f, emailOnly), `/api/households/${f.home.id}/portal-invitations`, body)).status).toBe(200);
    expect(mail.messages.length).toBe(before + 1);
    const token = /#([a-f0-9]{64})/.exec(mail.messages.at(-1)!.text)![1]!;
    await expect(emailOnly.accept(f.gymId, { token, password }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(emailOnly.accept(f.gymId, { token }, clock)).resolves.toEqual({ data: { status: 'email_sent' } });
  });
  it('passwordless: email and printed invitations prove the address through a login link before linking', async () => {
    const f = await fixture(), existing = await factory('authUser', f.gymId);
    await factory('householdUsers', f.gymId, { householdId: f.other.id, userId: existing.id, scope: 'payer', memberId: null });
    const issued = await invite(f, emailOnly, input(existing.email.toUpperCase()));
    expect(issued.userId).toBe(existing.id);
    // Holding the printed token is not proof: accepting only emails the invited address.
    expect(await emailOnly.accept(f.gymId, { token: issued.token }, clock)).toEqual({ data: { status: 'email_sent' } });
    expect(sent.at(-1)).toMatchObject({ gymId: f.gymId, email: existing.email });
    const claim = lastClaim();
    expect((await links(f.gymId, existing.id)).map(row => row.householdId)).toEqual([f.other.id]);
    // Only the invited user's own signed-in session completes it, in its own gym.
    const stranger = await factory('authUser', f.gymId);
    await expect(emailOnly.completeClaim(f.gymId, stranger.id, { claim }, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(emailOnly.completeClaim(f.otherGymId, existing.id, { claim }, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(emailOnly.completeClaim(f.gymId, existing.id, { claim: claim.slice(0, -2) + 'AA' }, clock)).rejects.toThrow();
    expect(await emailOnly.completeClaim(f.gymId, existing.id, { claim }, clock)).toBe(f.home.id);
    expect((await links(f.gymId, existing.id)).map(row => row.householdId).sort()).toEqual([f.home.id, f.other.id].sort());
    await expect(emailOnly.completeClaim(f.gymId, existing.id, { claim }, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(emailOnly.accept(f.gymId, { token: issued.token }, clock)).rejects.toMatchObject({ code: 'not_found' });
    // A claim code expires, and a staff identity is refused before and after the email.
    const late = await invite(f, emailOnly); await emailOnly.accept(f.gymId, { token: late.token }, clock);
    await expect(emailOnly.completeClaim(f.gymId, late.userId, { claim: lastClaim() }, new TestClock('2026-10-28T13:00:01Z'))).rejects.toMatchObject({ code: 'not_found' });
    const protectedUser = await invite(f, emailOnly); await emailOnly.accept(f.gymId, { token: protectedUser.token }, clock);
    await factory('staffRoles', f.gymId, { userId: protectedUser.userId, role: 'coach' });
    await expect(emailOnly.completeClaim(f.gymId, protectedUser.userId, { claim: lastClaim() }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(emailOnly.accept(f.gymId, { token: protectedUser.token }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await links(f.gymId, protectedUser.userId)).toEqual([]);
  });
  it('claim codes are signed, expiring and bound to one gym, user and grant', () => {
    const codes = createPortalClaimCodes(config.secret), other = createPortalClaimCodes('another-secret-of-at-least-32-characters');
    const claim = { kind: 'onboarding' as const, gymId: uuidv7(), userId: uuidv7(), linkId: uuidv7(), expiresAt: new Date('2026-10-28T13:00:00Z') };
    const code = codes.seal(claim);
    expect(codes.open(code, clock.now())).toEqual(claim);
    expect(other.open(code, clock.now())).toBeNull();
    expect(codes.open(code, new Date('2026-10-28T13:00:00Z'))).toBeNull();
    const [payload, signature] = code.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), r: uuidv7() })).toString('base64url');
    expect(codes.open(forged + '.' + signature, clock.now())).toBeNull();
    expect(codes.open(code + '.x', clock.now())).toBeNull();
  });
  it('never replaces existing credentials on claim and protects staff accounts from front desk resets', async () => {
    const f = await fixture('front_desk'), issued = await invite(f);
    const hash = await passwordAdapter.hash(password);
    await factory('authAccount', f.gymId, { userId: issued.userId, accountId: issued.userId, password: hash });
    await expect(invitations.accept(f.gymId, { token: issued.token, password: 'different-password-123' }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await links(f.gymId, issued.userId)).toEqual([]);
    await invitations.accept(f.gymId, { token: issued.token, password }, clock);
    const [unchanged] = await db.system.db.select().from(authAccount).where(eq(authAccount.userId, issued.userId)); expect(unchanged!.password).toBe(hash);
    const [login] = await links(f.gymId, issued.userId);
    await factory('staffRoles', f.gymId, { userId: issued.userId, role: 'coach' });
    expect((await send(app(f), `/api/households/${f.home.id}/users/${login!.id}/password`, { newPassword: password })).status).toBe(403);
    expect((await send(app(f), `/api/households/${f.other.id}/users/${login!.id}/password`, { newPassword: password })).status).toBe(404);
    expect((await send(app(f, invitations, undefined, f.otherGymId), `/api/households/${f.home.id}/users/${login!.id}/password`, { newPassword: password })).status).toBe(404);
  });
  it('a reset ends existing sessions and passwordless mode refuses it', async () => {
    const f = await fixture(), issued = await invite(f), actor = { gymId: f.gymId, userId: f.actor.userId, clock };
    await invitations.accept(f.gymId, { token: issued.token, password }, clock);
    const [login] = await links(f.gymId, issued.userId);
    await factory('authSession', f.gymId, { userId: issued.userId });
    await invitations.resetPassword(actor, f.home.id, login!.id, password);
    expect(await db.system.db.select().from(authSession).where(eq(authSession.userId, issued.userId))).toEqual([]);
    await expect(emailOnly.resetPassword(actor, f.home.id, login!.id, password)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('cannot use a printed member invitation to set credentials for a protected staff identity', async () => {
    const f = await fixture('front_desk'), issued = await invite(f);
    await factory('staffRoles', f.gymId, { userId: issued.userId, role: 'owner' });
    await expect(invitations.accept(f.gymId, { token: issued.token, password }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await db.system.db.select().from(authAccount).where(eq(authAccount.userId, issued.userId))).toEqual([]);
    expect((await send(app(f), `/api/households/${f.home.id}/portal-invitations`, issued.request)).status).toBe(403);
  });
  it('password onboarding claims derive the household from a live link and reject other gyms, used links and injected household IDs', async () => {
    const f = await fixture(), link = await onboardingLink(f);
    const body = { email: uuidv7() + '@example.test', password };
    await expect(invitations.claimOnboarding(f.otherGymId, link.id, body, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(invitations.claimOnboarding(f.gymId, link.id, { ...body, householdId: f.other.id }, clock)).rejects.toThrow();
    expect(await invitations.claimOnboarding(f.gymId, link.id, body, clock)).toEqual({ data: { status: 'claimed' } });
    const [login] = await db.forGym(f.gymId, tx => tx.select().from(householdUsers).where(eq(householdUsers.householdId, f.home.id)));
    expect(login?.scope).toBe('payer');
    await expect(householdContext.resolve({ gymId: f.gymId, userId: login!.userId, householdId: f.other.id })).rejects.toMatchObject({ code: 'not_found' });
    await db.forGym(f.gymId, tx => tx.update(signedLinks).set({ usedAt: clock.now() }).where(eq(signedLinks.id, link.id)));
    await expect(invitations.claimOnboarding(f.gymId, link.id, body, clock)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('password onboarding claims of an existing account need its current password', async () => {
    const f = await fixture(), link = await onboardingLink(f), user = await factory('authUser', f.gymId);
    await factory('authAccount', f.gymId, { userId: user.id, accountId: user.id, password: await passwordAdapter.hash(password) });
    await expect(invitations.claimOnboarding(f.gymId, link.id, { email: user.email, password: 'not-the-password-123' }, clock)).rejects.toMatchObject({ code: 'conflict' });
    expect(await links(f.gymId, user.id)).toEqual([]);
    await invitations.claimOnboarding(f.gymId, link.id, { email: user.email, password }, clock);
    expect((await links(f.gymId, user.id)).map(row => row.householdId)).toEqual([f.home.id]);
  });
  it.each(['existing', 'new'] as const)('passwordless onboarding claims link a %s account only on its own login-link callback', async kind => {
    const f = await fixture(), link = await onboardingLink(f);
    const existing = kind === 'existing' ? await factory('authUser', f.gymId) : undefined;
    if (existing) await factory('householdUsers', f.gymId, { householdId: f.other.id, userId: existing.id, scope: 'payer', memberId: null });
    const email = existing?.email ?? uuidv7() + '@example.test';
    await expect(emailOnly.claimOnboarding(f.gymId, link.id, { email, password }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await emailOnly.claimOnboarding(f.gymId, link.id, { email: email.toUpperCase() }, clock)).toEqual({ data: { status: 'email_sent' } });
    expect(sent.at(-1)).toMatchObject({ gymId: f.gymId, email });
    const [user] = await db.system.db.select().from(authUser).where(eq(authUser.email, email));
    expect(await db.forGym(f.gymId, tx => tx.select().from(householdUsers).where(eq(householdUsers.householdId, f.home.id)))).toEqual([]);
    const claim = lastClaim(), stranger = await factory('authUser', f.gymId);
    await expect(emailOnly.completeClaim(f.gymId, stranger.id, { claim }, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(emailOnly.completeClaim(f.otherGymId, user!.id, { claim }, clock)).rejects.toMatchObject({ code: 'not_found' });
    expect(await emailOnly.completeClaim(f.gymId, user!.id, { claim }, clock)).toBe(f.home.id);
    expect((await links(f.gymId, user!.id)).filter(row => row.householdId === f.home.id).map(row => row.scope)).toEqual(['payer']);
    if (existing) expect((await links(f.gymId, existing.id)).map(row => row.householdId).sort()).toEqual([f.home.id, f.other.id].sort());
    // The onboarding link must still be live when the callback arrives.
    const second = await onboardingLink(f, { householdId: f.other.id });
    await emailOnly.claimOnboarding(f.gymId, second.id, { email }, clock);
    await db.forGym(f.gymId, tx => tx.update(signedLinks).set({ usedAt: clock.now() }).where(eq(signedLinks.id, second.id)));
    await expect(emailOnly.completeClaim(f.gymId, user!.id, { claim: lastClaim() }, clock)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('passwordless onboarding claims refuse staff accounts, other gyms\' links and revoked links', async () => {
    const f = await fixture(), link = await onboardingLink(f);
    const staffUser = await db.system.db.select().from(authUser).where(eq(authUser.id, f.actor.userId));
    const count = sent.length;
    await expect(emailOnly.claimOnboarding(f.gymId, link.id, { email: staffUser[0]!.email }, clock)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(emailOnly.claimOnboarding(f.otherGymId, link.id, { email: uuidv7() + '@example.test' }, clock)).rejects.toMatchObject({ code: 'not_found' });
    expect(sent.length).toBe(count);
    const email = uuidv7() + '@example.test';
    await emailOnly.claimOnboarding(f.gymId, link.id, { email }, clock);
    const [user] = await db.system.db.select().from(authUser).where(eq(authUser.email, email));
    await db.forGym(f.gymId, tx => tx.update(signedLinks).set({ revokedAt: clock.now() }).where(eq(signedLinks.id, link.id)));
    await expect(emailOnly.completeClaim(f.gymId, user!.id, { claim: lastClaim() }, clock)).rejects.toMatchObject({ code: 'not_found' });
    expect(await links(f.gymId, user!.id)).toEqual([]);
  });
  it('signs in a claimed member through Better Auth and serves the real portal registrations with gym-bound sessions', async () => {
    const f = await fixture(), issued = await invite(f); await invitations.accept(f.gymId, { token: issued.token, password }, clock);
    const auth = createAuthService({ config, database: () => db.system.db, sendMagicLink: async () => undefined }), clientIp = `192.0.2.${ip++}`;
    const login = await auth.bind({ gymId: f.gymId, origin: f.origin, clientIp }).handler(new Request(f.origin + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: issued.request.email, password }) }));
    expect(login.status).toBe(200); const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    configurePortalAccess({ service: invitations, origin: () => f.origin });
    const production = (gymId: string) => createApp({ clock, contributions: areaContributions, authorize: createPortalAuthorization(householdContext), origin: f.origin,
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: sessionMiddleware({ auth, resolve: () => ({ gymId, origin: f.origin, clientIp }), principal: (userId, ctx, session) => loader(ctx.get('context').gym.gymId, userId, session) }),
    });
    const server = production(f.gymId);
    expect((await server.request(f.origin + '/api/portal/context', { headers: { cookie } })).status).toBe(200);
    expect((await server.request(f.origin + '/api/members', { headers: { cookie } })).status).toBe(403);
    expect((await production(f.otherGymId).request(f.origin + '/api/portal/context', { headers: { cookie } })).status).toBe(403);
    const manifest = await server.request(f.origin + '/portal/manifest.webmanifest'); expect(manifest.status).toBe(200);
    for (const icon of (await manifest.json() as { icons: { src: string }[] }).icons) expect((await server.request(f.origin + icon.src)).headers.get('content-type')).toBe('image/png');
    expect(await (await server.request(f.origin + '/portal/sw.js')).text()).not.toContain('caches.');
  });
  it('completes a passwordless claim from the real magic-link callback and opens the claimed household', async () => {
    const f = await fixture(), clientIp = `192.0.2.${ip++}`, delivered: { email: string; url: string }[] = [];
    const auth = createAuthService({ config: passwordless, database: () => db.system.db, sendMagicLink: async data => { delivered.push(data); } });
    const bound = auth.bind({ gymId: f.gymId, origin: f.origin, clientIp, smtpConfigured: true });
    const service = createPortalInvitationService({ ...options, config: passwordless, smtpConfigured: async () => true,
      loginLink: input => bound.sendLoginLink(input.email, input.claim) });
    configurePortalAccess({ service, origin: () => f.origin });
    const server = createApp({ clock, contributions: areaContributions, authorize: createPortalAuthorization(householdContext), origin: f.origin,
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: sessionMiddleware({ auth, smtpConfigured: async () => true, resolve: () => ({ gymId: f.gymId, origin: f.origin, clientIp }), principal: (userId, ctx, session) => loader(ctx.get('context').gym.gymId, userId, session) }),
    });
    // The user already belongs to another household, so the claimed one must be opened for this session.
    const existing = await factory('authUser', f.gymId);
    await factory('householdUsers', f.gymId, { householdId: f.other.id, userId: existing.id, scope: 'payer', memberId: null });
    const link = await onboardingLink(f);
    await service.claimOnboarding(f.gymId, link.id, { email: existing.email }, clock);
    const emailed = new URL(delivered.at(-1)!.url), callback = new URL(emailed.searchParams.get('callbackURL')!);
    expect(callback.origin + callback.pathname).toBe(f.origin + '/portal/claim');
    // A tampered callback is replaced by the admin, never followed.
    const tampered = new URL(emailed); tampered.searchParams.set('callbackURL', 'https://evil.test/portal/claim?claim=' + callback.searchParams.get('claim'));
    const verify = await server.request(emailed.toString(), { headers: {} });
    expect(verify.status).toBe(302); expect(verify.headers.get('location')).toBe(callback.href);
    const cookie = verify.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect((await server.request(f.origin + '/api/portal/context', { headers: { cookie } })).status).toBe(200);
    const post = (body: unknown, headers: Record<string, string> = { cookie }) => server.request(f.origin + '/api/portal/claims/complete', { method: 'POST', headers: { ...headers, origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ claim: callback.searchParams.get('claim') }, {})).status).toBe(401);
    expect((await post({ claim: callback.searchParams.get('claim') })).status).toBe(200);
    expect(await (await server.request(f.origin + '/api/portal/context', { headers: { cookie } })).json()).toEqual({ data: { role: 'payer', householdId: f.home.id, memberId: null } });
    const [stored] = await db.system.db.select({ householdId: authSession.householdId }).from(authSession).where(and(eq(authSession.userId, existing.id), eq(authSession.gymId, f.gymId)));
    expect(stored?.householdId).toBe(f.home.id);
    await service.claimOnboarding(f.gymId, (await onboardingLink(f)).id, { email: existing.email }, clock);
    const second = new URL(delivered.at(-1)!.url); second.searchParams.set('callbackURL', tampered.searchParams.get('callbackURL')!);
    expect((await server.request(second.toString())).headers.get('location')).toBe(f.origin + '/admin');
  });
});

describe('outstanding invitations', () => {
  type Listed = { id: string; scope: string; memberId: string | null; memberName: string | null; email: string; expiresAt: string };
  const get = (server: ReturnType<typeof app>, path: string) => server.request(path);
  const remove = (server: ReturnType<typeof app>, path: string) => server.request(path, { method: 'DELETE' });
  const listPath = (householdId: string) => `/api/households/${householdId}/portal-invitations`;
  const listed = async (f: Fixture, householdId = f.home.id, server = app(f)) => {
    const response = await get(server, listPath(householdId));
    expect(response.status).toBe(200);
    return (await response.json() as { data: Listed[] }).data;
  };
  const stored = (gymId: string) => db.system.db.select().from(authVerification).then(rows => rows.filter(row => row.identifier.startsWith('portal-invitation:' + gymId + ':')));
  const revocations = (gymId: string) => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'household_user.invitation_revoked')));

  it.each(staffRoles)('checks list and revoke permissions for %s', async role => {
    const f = await fixture(role), allowed = role !== 'coach', boss = await factory('staffRoles', f.gymId, { role: 'owner' });
    const asOwner = app(f, invitations, { kind: 'staff', gymId: f.gymId, userId: boss.userId, roles: ['owner'] }), server = app(f);
    expect((await send(asOwner, listPath(f.home.id), input())).status).toBe(200);
    const [row] = await listed(f, f.home.id, asOwner);
    expect((await get(server, listPath(f.home.id))).status).toBe(allowed ? 200 : 403);
    expect((await remove(server, `${listPath(f.home.id)}/${row!.id}`)).status).toBe(allowed ? 200 : 403);
    expect(await listed(f, f.home.id, asOwner)).toHaveLength(allowed ? 0 : 1);
  });

  it("lists the household's unexpired invitations for staff, with address, scope, member and expiry, and never a token", async () => {
    const f = await fixture(), adult = await factory('members', f.gymId, { householdId: f.home.id, dateOfBirth: '1990-01-01' });
    expect(await listed(f)).toEqual([]);
    const payer = await invite(f, invitations, input('payer@example.test'));
    expect((await send(app(f), listPath(f.home.id), { email: 'adult@example.test', scope: 'member', memberId: adult.id, delivery: 'print' })).status).toBe(200);
    const response = await get(app(f), listPath(f.home.id)), text = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(payer.token); expect(text).not.toContain('portal-invitation:');
    const rows = JSON.parse(text).data as Listed[];
    expect(rows.map(row => [row.scope, row.email, row.memberId, row.memberName]).sort()).toEqual([
      ['member', 'adult@example.test', adult.id, `${adult.firstName} ${adult.lastName}`], ['payer', 'payer@example.test', null, null]].sort());
    expect(rows.every(row => row.expiresAt === '2026-11-04T12:00:00.000Z')).toBe(true);
    // Printing again replaces the outstanding invitation instead of adding another.
    await invite(f, invitations, input('payer@example.test'));
    expect((await listed(f)).filter(row => row.email === 'payer@example.test')).toHaveLength(1);
  });

  it("hides expired and accepted invitations, other households' and gyms' invitations, and other verification rows", async () => {
    const f = await fixture(), other = await fixture(), first = await invite(f);
    await invite(f);
    expect((await send(app(f), listPath(f.other.id), input('neighbour@example.test'))).status).toBe(200);
    await invite(other);
    await db.system.db.insert(authVerification).values({ identifier: 'magic-link-token', value: JSON.stringify({ email: 'x@example.test', householdId: f.home.id }), expiresAt: new Date('2026-11-01T00:00:00Z') });
    expect(await listed(f)).toHaveLength(2);
    expect((await listed(f, f.other.id)).map(row => row.email)).toEqual(['neighbour@example.test']);
    // The other gym's actor reads its own gym only; this gym's household is unknown there.
    expect((await get(app(f, invitations, undefined, f.otherGymId), listPath(f.home.id))).status).toBe(404);
    expect((await get(app(f), listPath(f.foreign.id))).status).toBe(404);
    await invitations.accept(f.gymId, { token: first.token, password }, clock);
    expect(await listed(f)).toHaveLength(1);
    const later = new TestClock('2026-11-05T00:00:00Z');
    expect(await invitations.outstanding({ gymId: f.gymId, userId: f.actor.userId, clock: later }, f.home.id)).toEqual({ data: [] });
  });

  it('revokes an invitation with an audit row, and accepting it then fails in password mode', async () => {
    const f = await fixture(), issued = await invite(f), [row] = await listed(f);
    const response = await remove(app(f), `${listPath(f.home.id)}/${row!.id}`);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await listed(f)).toEqual([]); expect(await stored(f.gymId)).toEqual([]);
    const audit = await revocations(f.gymId);
    expect(audit).toEqual([expect.objectContaining({ actorKind: 'user', actorUserId: f.actor.userId, targetType: 'household', targetId: f.home.id,
      before: { userId: issued.userId, scope: 'payer', memberId: null }, after: null })]);
    expect(JSON.stringify(audit)).not.toContain(issued.token);
    const anonymous = { kind: 'anonymous' as const };
    expect((await send(app(f, invitations, anonymous), '/api/portal/invitations/accept', { token: issued.token, password })).status).toBe(404);
    expect(await links(f.gymId, issued.userId)).toEqual([]);
    expect((await remove(app(f), `${listPath(f.home.id)}/${row!.id}`)).status).toBe(404);
  });

  it('passwordless: a revoked invitation can be neither claimed nor completed with a claim code already sent', async () => {
    const f = await fixture(), issued = await invite(f, emailOnly);
    expect(await emailOnly.accept(f.gymId, { token: issued.token }, clock)).toEqual({ data: { status: 'email_sent' } });
    const claim = lastClaim(), [row] = await listed(f);
    expect((await remove(app(f, emailOnly), `${listPath(f.home.id)}/${row!.id}`)).status).toBe(200);
    await expect(emailOnly.completeClaim(f.gymId, issued.userId, { claim }, clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(emailOnly.accept(f.gymId, { token: issued.token }, clock)).rejects.toMatchObject({ code: 'not_found' });
    expect(await links(f.gymId, issued.userId)).toEqual([]);
  });

  it('refuses to revoke across households and gyms, expired invitations, and rows that are not invitations', async () => {
    const f = await fixture(), other = await fixture();
    await invite(f); await invite(other);
    const [row] = await listed(f), [theirs] = await listed(other, other.home.id, app(other));
    // Household B's route can't revoke household A's invitation, and the other gym's route can't either.
    expect((await remove(app(f), `${listPath(f.other.id)}/${row!.id}`)).status).toBe(404);
    expect((await remove(app(f, invitations, undefined, f.otherGymId), `${listPath(f.home.id)}/${row!.id}`)).status).toBe(404);
    expect((await remove(app(f), `${listPath(f.home.id)}/${theirs!.id}`)).status).toBe(404);
    expect((await remove(app(f), `${listPath(f.foreign.id)}/${theirs!.id}`)).status).toBe(404);
    expect((await remove(app(other), `${listPath(f.home.id)}/${row!.id}`)).status).toBe(404);
    expect((await remove(app(f), `${listPath(f.home.id)}/${uuidv7()}`)).status).toBe(404);
    const [magic] = await db.system.db.insert(authVerification).values({ identifier: 'magic-link-token', value: JSON.stringify({ email: 'x@example.test' }), expiresAt: new Date('2026-11-01T00:00:00Z') }).returning();
    expect((await remove(app(f), `${listPath(f.home.id)}/${magic!.id}`)).status).toBe(404);
    expect(await db.system.db.select().from(authVerification).where(eq(authVerification.id, magic!.id))).toHaveLength(1);
    const later = new TestClock('2026-11-05T00:00:00Z');
    await expect(invitations.revokeInvitation({ gymId: f.gymId, userId: f.actor.userId, clock: later }, f.home.id, row!.id)).rejects.toMatchObject({ code: 'not_found' });
    // Everything above left both invitations in place and wrote no audit row.
    expect(await listed(f)).toHaveLength(1); expect(await listed(other, other.home.id, app(other))).toHaveLength(1);
    expect(await revocations(f.gymId)).toEqual([]); expect(await revocations(other.gymId)).toEqual([]);
  });
});
