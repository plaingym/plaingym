// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, inArray, like } from 'drizzle-orm';
import { authVerification, authAccount, authRateLimit, authSession, staffRoles, staffProfiles, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles as roleNames, type StaffRole } from '@plaingym/shared';
import { inviteStaffResponseSchema } from '@plaingym/shared/contracts';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createStaffInvitationService, smtpMailer } from '../../areas/staff/profiles.invitations.js';
import { authConfig } from './config.js';
import { createAccountService } from './accounts.js';
import { passwordAdapter } from './password.js';
import { reserveAccountAttempt, signInLimits } from './account-limit.js';
import { createAuthService } from './service.js';
import { accountDigest } from './account-limit-key.js';
import { DeliveryError, FakeEmail } from '../email/index.js';
import { captureSmtp } from '../email/test-smtp.js';
import { createSmtpResolver, encryptSmtpConfig } from '../../areas/settings/smtp.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { TestClock } from '../../core/clock.js';
import { createStaffInvitationRoutes } from '../../areas/staff/profiles.routes.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-22T12:00:00Z');
const config = authConfig({ AUTH_SECRET: 'staff-invitation-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false);
const key = parseEncryptionKey('ab'.repeat(32));
const smtp = createSmtpResolver({ key, scope: db.forGym, env: {} });
const service = createStaffInvitationService({ config, smtpConfigured: smtp.configured, mailer: smtpMailer(smtp), database: () => db.system.db });
const gymA = uuidv7(), gymB = uuidv7(), users = new Map<StaffRole, string>();
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  for (const role of roleNames) { const row = await factory('staffRoles', gymA, { role }); users.set(role, row.userId); }
});
const actor = (role: StaffRole = 'owner') => ({ gymId: gymA, actorUserId: users.get(role)!, clock });
function server(role: StaffRole | 'anonymous' = 'owner', gymId = gymA, inviteService = service) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { const principal: Principal = role === 'anonymous' ? { kind: 'anonymous' } : { kind: 'staff', gymId, userId: users.get(role)!, roles: [role] };
    c.set('context', { principal, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'invite-test' }); await next(); });
  app.onError(errorHandler); createServerRegistry({ routes: createStaffInvitationRoutes(inviteService, () => 'https://gym-a.example.test') }).mount(app, authorize, new Set()); return app;
}
const post = (app: ReturnType<typeof server>, path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function printed(email = uuidv7() + '@example.test') {
  const result = await service.inviteStaff(actor(), { email, role: 'coach', delivery: 'print' }, 'https://gym-a.example.test');
  if (result.data.delivery !== 'print') throw new Error('Expected printed invitation');
  return { ...result.data, token: new URL(result.data.invitationUrl).hash.slice(1) };
}
it.each(roleNames)('only owner/admin invite staff by printed link: %s', async (role) => {
  const result = await post(server(role), '/api/staff/invitations', { email: uuidv7() + '@example.test', role: 'coach', delivery: 'print' });
  expect(result.status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
});
it('prints without SMTP, stores only a token hash, consumes once, and provisions a usable password', async () => {
  const email = uuidv7() + '@example.test', invite = await printed(email), password = 'a-strong-invited-password';
  const stored = await db.system.db.select().from(authVerification);
  expect(JSON.stringify(stored)).not.toContain(invite.token);
  expect(stored.some((row) => row.expiresAt.getTime() - clock.now().getTime() === 7 * 86400000)).toBe(true);
  const app = server('anonymous');
  expect((await post(app, '/api/staff/invitations/accept', { token: invite.token, name: 'Invited coach', password })).status).toBe(200);
  expect((await post(app, '/api/staff/invitations/accept', { token: invite.token, name: 'Replay', password })).status).toBe(404);
  const [account] = await db.system.db.select().from(authAccount).where(eq(authAccount.userId, invite.staffRole.userId));
  expect(await passwordAdapter.verify({ hash: account!.password!, password })).toBe(true);
  const profile = await db.forGym(gymA, (tx) => tx.select().from(staffProfiles).where(eq(staffProfiles.userId, invite.staffRole.userId)));
  expect(profile).toMatchObject([{ displayName: 'Invited coach' }]);
  const auth = createAuthService({ config, database: () => db.system.db });
  const response = await auth.bind({ gymId: gymA, origin: 'https://gym-a.example.test', clientIp: '127.0.0.1' }).handler(new Request('https://gym-a.example.test/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://gym-a.example.test' }, body: JSON.stringify({ email, password }) }));
  expect(response.status).toBe(200);
  const audits = await db.forGym(gymA, (tx) => tx.select().from(auditEvents));
  expect(audits.some((row) => row.action === 'staff.invitation_accepted' && row.targetId === invite.staffRole.id)).toBe(true);
  expect(JSON.stringify(audits)).not.toContain(invite.token); expect(JSON.stringify(audits)).not.toContain(password);
});
it('rejects expired and foreign-gym tokens without consuming a valid token', async () => {
  const invite = await printed(), body = { token: invite.token, name: 'Coach', password: 'invitation-password-123' };
  expect((await post(server('anonymous', gymB), '/api/staff/invitations/accept', body)).status).toBe(404);
  const later = new TestClock(new Date(clock.now().getTime() + 7 * 86400000));
  await expect(service.acceptInvitation(gymA, body, later)).rejects.toMatchObject({ code: 'not_found' });
  await expect(service.acceptInvitation(gymA, body, clock)).resolves.toEqual({ data: null });
});
it('allows one concurrent acceptance and invalidates invitations after a role change/revoke', async () => {
  const invite = await printed(), body = { token: invite.token, name: 'Coach', password: 'invitation-password-123' };
  const results = await Promise.allSettled([service.acceptInvitation(gymA, body, clock), service.acceptInvitation(gymA, body, clock)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  for (const revoke of [false, true]) {
    const next = await printed();
    await db.forGym(gymA, async (tx) => {
      if (revoke) await tx.delete(staffRoles).where(eq(staffRoles.id, next.staffRole.id));
      else await tx.update(staffRoles).set({ role: 'admin', revision: 2 }).where(eq(staffRoles.id, next.staffRole.id));
    });
    await expect(service.acceptInvitation(gymA, { ...body, token: next.token }, clock)).rejects.toMatchObject({ code: 'not_found' });
  }
});
it('sends through the gym SMTP and accepts email invitations without passwords in multi mode', async () => {
  const capture = await captureSmtp({ user: 'gym-user', pass: 'gym-pass' });
  try {
    const gymId = uuidv7(), owner = await factory('staffRoles', gymA, { role: 'owner' });
    await factory('gyms', gymId, { smtpConfig: encryptSmtpConfig(key, gymId, { host: '127.0.0.1', port: capture.port, security: 'plain', from: 'gym@example.test', username: 'gym-user', password: 'gym-pass' }) });
    await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
    const multi = createStaffInvitationService({ config: { ...config, tenancy: 'multi', passwordEnabled: false, passwordMode: 'off' }, smtpConfigured: smtp.configured, mailer: smtpMailer(smtp), database: () => db.system.db, scope: db.forGym });
    const result = await multi.inviteStaff({ gymId, actorUserId: owner.userId, clock }, { email: 'email-invite@example.test', role: 'coach', delivery: 'email', sendGeneration: uuidv7() }, 'https://email-gym.example.test');
    expect(inviteStaffResponseSchema.parse(result).data.delivery).toBe('email');
    expect(JSON.stringify(result)).not.toContain('invitationUrl');
    expect(capture.messages).toHaveLength(1); expect(capture.messages[0]).toContain('gym@example.test');
    // Quoted-printable bodies wrap long lines with soft breaks.
    const token = capture.messages[0]!.replace(/=\r\n/g, '').match(/staff-invitation#([a-f0-9]{64})/)?.[1]; expect(token).toBeDefined();
    await expect(multi.acceptInvitation(gymId, { token: token!, name: 'Email coach' }, clock)).resolves.toEqual({ data: null });
    expect(await db.system.db.select().from(authAccount).where(eq(authAccount.userId, result.data.staffRole.userId))).toHaveLength(0);
  } finally { await capture.close(); }
});
it('keeps failed delivery retryable, invalidates old retry links, and never sends inside a transaction', async () => {
  const email = uuidv7() + '@example.test', first = await printed(email), fake = new FakeEmail();
  fake.respondNext(new DeliveryError('not_accepted', 'SMTP failure')); const sendGeneration = uuidv7();
  const sender = createStaffInvitationService({ config, database: () => db.system.db, scope: db.forGym, smtpConfigured: async () => true, mailer: async () => { expect(isInTransaction()).toBe(false); return fake; } });
  await expect(sender.inviteStaff(actor(), { email, role: 'coach', delivery: 'email', sendGeneration }, 'https://gym-a.example.test')).rejects.toThrow('SMTP failure');
  const retry = await sender.inviteStaff(actor(), { email, role: 'coach', delivery: 'email', sendGeneration }, 'https://gym-a.example.test');
  expect(retry.data.staffRole.id).toBe(first.staffRole.id); expect(fake.messages).toHaveLength(1);
  await expect(service.acceptInvitation(gymA, { token: first.token, name: 'Old', password: 'invitation-password-123' }, clock)).rejects.toMatchObject({ code: 'not_found' });
});
it('never resets an existing password or uses invitations to take over protected staff accounts', async () => {
  const email = uuidv7() + '@example.test', password = 'existing-account-password';
  const accounts = createAccountService(config, () => db.system.db);
  const user = await accounts.createPasswordUser(gymA, email, 'Existing member', password, clock);
  await expectExistingLoginRefused(email, user.userId);
  const [credential] = await db.system.db.select().from(authAccount).where(eq(authAccount.userId, user.userId));
  expect(await passwordAdapter.verify({ hash: credential!.password!, password })).toBe(true);
});
async function expectExistingLoginRefused(email: string, userId: string) {
  const audits = () => db.forGym(gymA, tx => tx.select().from(auditEvents).where(inArray(auditEvents.action, ['staff.role_granted', 'staff.invited'])));
  const before = (await audits()).length;
  await expect(printed(email)).rejects.toMatchObject({ code: 'conflict', message: 'This address already has a login. Use another address.', details: { reason: ['existing_login'] } });
  expect(await db.forGym(gymA, tx => tx.select().from(staffRoles).where(eq(staffRoles.userId, userId)))).toEqual([]);
  expect(await audits()).toHaveLength(before);
  const tokens = await db.system.db.select().from(authVerification).where(like(authVerification.identifier, `staff-invitation:${gymA}:%`));
  expect(tokens.filter(row => row.value.includes(userId))).toEqual([]);
}
it('in password mode refuses to invite an address whose login already has a password, leaving no role, audit or token', async () => {
  const email = uuidv7() + '@example.test';
  const user = await createAccountService(config, () => db.system.db).createPasswordUser(gymA, email, 'Portal member', 'portal-member-password', clock);
  const session = await factory('authSession', gymA, { userId: user.userId });
  await expectExistingLoginRefused(email, user.userId);
  expect(await credentials(user.userId)).toHaveLength(1);
  expect((await sessionsIn(gymA, user.userId)).map(row => row.id)).toEqual([session.id]);
});
const emailMode = createStaffInvitationService({ config: { ...config, passwordMode: 'auto' }, smtpConfigured: async () => true, mailer: smtpMailer(smtp), database: () => db.system.db });
async function printedBy(inviteService: typeof service, email: string) {
  const result = await inviteService.inviteStaff(actor(), { email, role: 'coach', delivery: 'print' }, 'https://gym-a.example.test');
  if (result.data.delivery !== 'print') throw new Error('Expected printed invitation');
  return { ...result.data, token: new URL(result.data.invitationUrl).hash.slice(1) };
}
const credentials = (userId: string) => db.system.db.select().from(authAccount).where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')));
const sessionsIn = (gymId: string, userId: string) => db.system.db.select().from(authSession).where(and(eq(authSession.gymId, gymId), eq(authSession.userId, userId)));
async function addPassword(userId: string, password: string) {
  const hash = await passwordAdapter.hash(password);
  await factory('authAccount', gymA, { userId, accountId: userId, password: hash });
  return hash;
}
it('outside password mode an invitation removes an existing login\'s password and ends its gym sessions', async () => {
  const email = uuidv7() + '@example.test', password = 'existing-account-password';
  const user = await createAccountService(config, () => db.system.db).createPasswordUser(gymA, email, 'Existing member', password, clock);
  await factory('authSession', gymA, { userId: user.userId }); const elsewhere = await factory('authSession', gymB, { userId: user.userId });
  const invite = await printedBy(emailMode, email);
  expect(invite.staffRole.userId).toBe(user.userId);
  expect(await credentials(user.userId)).toEqual([]);
  expect(await sessionsIn(gymA, user.userId)).toEqual([]);
  expect((await sessionsIn(gymB, user.userId)).map(row => row.id)).toEqual([elsewhere.id]);
  const audits = await db.forGym(gymA, tx => tx.select().from(auditEvents).where(inArray(auditEvents.targetId, [user.userId, invite.staffRole.id])));
  expect(audits.filter(row => row.action === 'auth.password_removed')).toMatchObject([{ actorKind: 'user', actorUserId: users.get('owner'), targetType: 'user', targetId: user.userId }]);
  expect(audits.map(row => row.action)).toEqual(expect.arrayContaining(['staff.role_granted', 'staff.invited']));
  expect(JSON.stringify(audits)).not.toContain(email);
  // The invitee sets a new password when the gym signs in by password; the old one no longer works.
  const next = 'new-invited-password';
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password: next }, clock)).resolves.toEqual({ data: null });
  const [credential] = await credentials(user.userId);
  expect(await passwordAdapter.verify({ hash: credential!.password!, password: next })).toBe(true);
  expect(await passwordAdapter.verify({ hash: credential!.password!, password })).toBe(false);
});
it('accepting an invitation needs a password added after it was issued and never replaces it', async () => {
  const identity = await factory('authUser', gymA), password = 'existing-account-password';
  const invite = await printedBy(emailMode, identity.email), hash = await addPassword(identity.id, password);
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password: 'replacement-password' }, clock)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password }, clock)).resolves.toEqual({ data: null });
  expect((await credentials(identity.id))[0]!.password).toBe(hash);
});
it('a resend outside password mode removes nothing', async () => {
  const identity = await factory('authUser', gymA), first = await printedBy(emailMode, identity.email);
  const hash = await addPassword(identity.id, 'added-after-the-invite');
  const again = await printedBy(emailMode, identity.email);
  expect(again.staffRole.id).toBe(first.staffRole.id);
  expect((await credentials(identity.id)).map(row => row.password)).toEqual([hash]);
});
it.each([
  ['single, auto with SMTP', { passwordMode: 'auto' }, true, true],
  ['single, off', { passwordMode: 'off', passwordEnabled: false }, true, true],
  ['single, on', { passwordMode: 'on' }, true, false],
  ['single, auto without SMTP', { passwordMode: 'auto' }, false, false],
  ['multi', { tenancy: 'multi', passwordMode: 'off', passwordEnabled: false }, true, false],
] as const)('removesLeftoverPassword: %s', async (_name, change, smtpConfigured, expected) => {
  const modes = createStaffInvitationService({ config: { ...config, ...change }, smtpConfigured: async () => smtpConfigured, mailer: smtpMailer(smtp), database: () => db.system.db });
  expect(await modes.removesLeftoverPassword(gymA)).toBe(expected);
});
/** The login's `/sign-in/email` account window count, or null when it has no window. */
async function windowCount(email: string) {
  const digest = accountDigest(email);
  const [row] = await db.system.db.select({ count: authRateLimit.count }).from(authRateLimit).where(eq(authRateLimit.key, `account|/sign-in/email|${digest}`));
  return row?.count ?? null;
}
const acceptedBy = async (userId: string) => (await db.forGym(gymA, tx => tx.select().from(staffProfiles).where(eq(staffProfiles.userId, userId)))).length > 0;
it('accepting with an existing login\'s password counts in the password sign-in account budget', async () => {
  const identity = await factory('authUser', gymA), password = 'existing-account-password';
  const invite = await printed(identity.email); await addPassword(identity.id, password);
  for (let attempt = 0; attempt < 10; attempt++)
    await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password: 'wrong-password-' + attempt }, clock)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password }, clock)).rejects.toMatchObject({ code: 'rate_limited' });
  expect(await db.system.db.select().from(authVerification).where(like(authVerification.value, `%${identity.id}%`))).toHaveLength(1);
  expect(await acceptedBy(identity.id)).toBe(false);
  expect((await reserveAccountAttempt(db.system.db, '/sign-in/email', identity.email, signInLimits.account, clock.now().getTime())).reservation).toBeNull();
  const later = new TestClock(new Date(clock.now().getTime() + 600_000));
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password }, later)).resolves.toEqual({ data: null });
  expect(await acceptedBy(identity.id)).toBe(true);
});
it('a right password gives its slot back only once the acceptance commits; a login with no password reserves nothing', async () => {
  const right = await factory('authUser', gymA), password = 'existing-account-password';
  const invite = await printed(right.email); await addPassword(right.id, password);
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Wrong', password: 'wrong-password-1' }, clock)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await windowCount(right.email)).toBe(1);
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password }, clock)).resolves.toEqual({ data: null });
  expect(await windowCount(right.email)).toBe(1);
  // The role changed after issue, so the consuming transaction throws and the slot stays counted.
  const failing = await factory('authUser', gymA), stale = await printed(failing.email); await addPassword(failing.id, password);
  await db.forGym(gymA, tx => tx.update(staffRoles).set({ role: 'admin', revision: 2 }).where(eq(staffRoles.id, stale.staffRole.id)));
  await expect(service.acceptInvitation(gymA, { token: stale.token, name: 'Coach', password }, clock)).rejects.toMatchObject({ code: 'not_found' });
  expect(await windowCount(failing.email)).toBe(1);
  const fresh = uuidv7() + '@example.test', none = await printed(fresh);
  await expect(service.acceptInvitation(gymA, { token: none.token, name: 'Coach', password: 'brand-new-password' }, clock)).resolves.toEqual({ data: null });
  expect(await windowCount(fresh)).toBeNull();
  const racing = await factory('authUser', gymA), raced = await printed(racing.email); await addPassword(racing.id, password);
  const results = await Promise.allSettled([0, 1].map(() => service.acceptInvitation(gymA, { token: raced.token, name: 'Coach', password }, clock)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});
it('still invites a new address, an identity with no password, and an invited address again before it accepts', async () => {
  expect((await printed()).token).toMatch(/^[a-f0-9]{64}$/);
  const identity = await factory('authUser', gymA), first = await printed(identity.email);
  expect(first.staffRole.userId).toBe(identity.id);
  const again = await printed(identity.email);
  expect(again.staffRole.id).toBe(first.staffRole.id); expect(again.token).not.toBe(first.token);
});
it('a gym with password sign-in off invites an identity that has a password as before', async () => {
  const gymId = uuidv7(), owner = await factory('staffRoles', gymA, { role: 'owner' });
  await factory('gyms', gymId); await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
  const identity = await factory('authUser', gymId);
  await factory('authAccount', gymId, { userId: identity.id, accountId: identity.id, password: await passwordAdapter.hash('identity-password-123') });
  const multi = createStaffInvitationService({ config: { ...config, tenancy: 'multi', passwordEnabled: false, passwordMode: 'off' }, smtpConfigured: smtp.configured, mailer: smtpMailer(smtp), database: () => db.system.db, scope: db.forGym });
  const result = await multi.inviteStaff({ gymId, actorUserId: owner.userId, clock }, { email: identity.email, role: 'coach', delivery: 'print' }, 'https://gym-c.example.test');
  expect(result.data.staffRole.userId).toBe(identity.id);
  expect(result.data.delivery).toBe('print');
  expect(await credentials(identity.id)).toHaveLength(1);
});
it('renders a public, translated acceptance page with a source link and hides password in email mode', async () => {
  const page = await server('anonymous').request('/staff-invitation');
  expect(page.status).toBe(200); expect(page.headers.get('cache-control')).toBe('no-store');
  const html = await page.text(); expect(html).toContain('name="password"'); expect(html).toContain('href="/source"'); expect(html).toContain('location.hash');
  expect(html).toContain('<span class="sr-only">Version </span>');
  expect(html).not.toContain('aria-label="Version');
  // The inline script carries a fresh per-response nonce for the Content-Security-Policy.
  expect(html).toMatch(/<script nonce="[A-Za-z0-9+/]{22}==">/);
  const multi = createStaffInvitationService({ config: { ...config, tenancy: 'multi', passwordEnabled: false }, smtpConfigured: smtp.configured, mailer: smtpMailer(smtp), database: () => db.system.db });
  expect(await (await server('anonymous', gymA, multi).request('/staff-invitation')).text()).not.toContain('name="password"');
});
it('rejects missing password, owner invites, unauthenticated invites and email delivery without SMTP', async () => {
  const invite = await printed();
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach' }, clock)).rejects.toMatchObject({ code: 'invalid_request' });
  expect((await post(server(), '/api/staff/invitations', { email: 'bad@example.test', role: 'owner', delivery: 'print' })).status).toBe(400);
  expect((await post(server('anonymous'), '/api/staff/invitations', { email: 'bad@example.test', role: 'coach', delivery: 'print' })).status).toBe(401);
  await expect(service.inviteStaff(actor(), { email: 'no-smtp@example.test', role: 'coach', delivery: 'email', sendGeneration: uuidv7() }, 'https://gym-a.example.test')).rejects.toMatchObject({ code: 'unavailable' });
});
