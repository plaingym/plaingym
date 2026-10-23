// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { authVerification, authAccount, staffRoles, staffProfiles, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles as roleNames, type StaffRole } from '@plaingym/shared';
import { inviteStaffResponseSchema } from '@plaingym/shared/contracts';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createStaffInvitationService, smtpMailer } from '../../areas/staff/profiles.invitations.js';
import { authConfig } from './config.js';
import { createAccountService } from './accounts.js';
import { passwordAdapter } from './password.js';
import { createAuthService } from './service.js';
import { FakeEmail } from '../email/index.js';
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
    await factory('gyms', gymId, { smtpConfig: encryptSmtpConfig(key, { host: '127.0.0.1', port: capture.port, security: 'plain', from: 'gym@example.test', username: 'gym-user', password: 'gym-pass' }) });
    await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
    const multi = createStaffInvitationService({ config: { ...config, tenancy: 'multi', passwordEnabled: false, passwordMode: 'off' }, smtpConfigured: smtp.configured, mailer: smtpMailer(smtp), database: () => db.system.db });
    const result = await multi.inviteStaff({ gymId, actorUserId: owner.userId, clock }, { email: 'email-invite@example.test', role: 'coach', delivery: 'email' }, 'https://email-gym.example.test');
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
  fake.respondNext(new Error('SMTP failure'));
  const sender = createStaffInvitationService({ config, database: () => db.system.db, smtpConfigured: async () => true, mailer: async () => { expect(isInTransaction()).toBe(false); return fake; } });
  await expect(sender.inviteStaff(actor(), { email, role: 'coach', delivery: 'email' }, 'https://gym-a.example.test')).rejects.toThrow('SMTP failure');
  const retry = await sender.inviteStaff(actor(), { email, role: 'coach', delivery: 'email' }, 'https://gym-a.example.test');
  expect(retry.data.staffRole.id).toBe(first.staffRole.id); expect(fake.messages).toHaveLength(1);
  await expect(service.acceptInvitation(gymA, { token: first.token, name: 'Old', password: 'invitation-password-123' }, clock)).rejects.toMatchObject({ code: 'not_found' });
});
it('never resets an existing password or uses invitations to take over protected staff accounts', async () => {
  const email = uuidv7() + '@example.test', password = 'existing-account-password';
  const accounts = createAccountService(config, () => db.system.db);
  const user = await accounts.createPasswordUser(gymA, email, 'Existing member', password, clock);
  const invite = await printed(email);
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password: 'replacement-password' }, clock)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach', password }, clock)).resolves.toEqual({ data: null });
  const [credential] = await db.system.db.select().from(authAccount).where(eq(authAccount.userId, user.userId));
  expect(await passwordAdapter.verify({ hash: credential!.password!, password })).toBe(true);
  await expect(printed(email)).rejects.toMatchObject({ code: 'conflict' });
});
it('renders a public, translated acceptance page with a source link and hides password in email mode', async () => {
  const page = await server('anonymous').request('/staff-invitation');
  expect(page.status).toBe(200); expect(page.headers.get('cache-control')).toBe('no-store');
  const html = await page.text(); expect(html).toContain('name="password"'); expect(html).toContain('href="/source"'); expect(html).toContain('location.hash');
  const multi = createStaffInvitationService({ config: { ...config, tenancy: 'multi', passwordEnabled: false }, smtpConfigured: smtp.configured, mailer: smtpMailer(smtp), database: () => db.system.db });
  expect(await (await server('anonymous', gymA, multi).request('/staff-invitation')).text()).not.toContain('name="password"');
});
it('rejects missing password, owner invites, unauthenticated invites and email delivery without SMTP', async () => {
  const invite = await printed();
  await expect(service.acceptInvitation(gymA, { token: invite.token, name: 'Coach' }, clock)).rejects.toMatchObject({ code: 'invalid_request' });
  expect((await post(server(), '/api/staff/invitations', { email: 'bad@example.test', role: 'owner', delivery: 'print' })).status).toBe(400);
  expect((await post(server('anonymous'), '/api/staff/invitations', { email: 'bad@example.test', role: 'coach', delivery: 'print' })).status).toBe(401);
  await expect(service.inviteStaff(actor(), { email: 'no-smtp@example.test', role: 'coach', delivery: 'email' }, 'https://gym-a.example.test')).rejects.toMatchObject({ code: 'unavailable' });
});
