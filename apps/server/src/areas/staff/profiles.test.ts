// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Role grant tests verify password and session removal in real PostgreSQL.
import { authAccount, authSession, staffRoles, staffProfiles, auditEvents, households, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
// eslint-disable-next-line no-restricted-imports -- Initialize real database pools for the configured route composition test.
import { closeDatabase, initializeDatabase } from '@plaingym/db/client';
import { createStaffDirectory } from '../../infra/auth/staff-directory.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles as roleNames, type StaffRole } from '@plaingym/shared';
import { staffProfileResponseSchema, staffProfileListResponseSchema, staffRoleResponseSchema } from '@plaingym/shared/contracts';
import { createStaffProfileService } from './profiles.js';
import { configureStaffProfiles, createStaffProfileRoutes } from './profiles.routes.js';
import { createStaffInvitationService } from './profiles.invitations.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createMembersService } from '../members/members.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from './auth.permissions.js';
import { assertCanResetPassword } from './auth.reset.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-22T12:00:00Z');
const service = createStaffProfileService(db.forGym), gymA = uuidv7(), gymB = uuidv7();
const directory = createStaffDirectory(() => db.system.db, 'single');
const users = new Map<StaffRole, string>();
let otherOwner: string;
beforeAll(async () => {
  await initializeDatabase(db.appUrl);
  await factory('gyms', gymA); await factory('gyms', gymB);
  for (const role of roleNames) { const user = await factory('authUser', gymA); users.set(role, user.id); await factory('staffRoles', gymA, { userId: user.id, role }); }
  const other = await factory('staffRoles', gymB, { role: 'owner' }); otherOwner = other.userId;
});
afterAll(closeDatabase);
const actor = (role: StaffRole = 'owner', gymId = gymA) => ({ gymId, actorUserId: gymId === gymA ? users.get(role)! : otherOwner, clock });
function server(role: StaffRole | 'anonymous' = 'owner', gymId = gymA, principalOverride?: Principal, runtimeDirectory = false) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'staff-test',
    principal: principalOverride ?? (role === 'anonymous' ? { kind: 'anonymous' } : { kind: 'staff', userId: actor(role, gymId).actorUserId, gymId, roles: [role] }) }); await next(); });
  app.onError(errorHandler); createServerRegistry({ routes: createStaffProfileRoutes(service, runtimeDirectory ? undefined : directory) }).mount(app, authorize, new Set()); return app;
}
const request = (app: ReturnType<typeof server>, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
it.each(roleNames)('only owner/admin can use every profile and role endpoint: %s', async (role) => {
  const app = server(role), allowed = ['owner', 'admin'].includes(role);
  const profile = (await service.createProfile(actor(), { displayName: 'Editable ' + role })).data;
  const target = await factory('staffRoles', gymA, { role: 'coach' });
  const local = await factory('householdUsers', gymA);
  const cases: [string, string, unknown?][] = [
    ['GET', '/api/staff/accounts'], ['GET', '/api/staff/profiles'], ['GET', '/api/staff/profiles/' + profile.id], ['GET', '/api/staff/roles'],
    ['POST', '/api/staff/profiles', { displayName: role }], ['PATCH', '/api/staff/profiles/' + profile.id, { revision: 1, rank: 'Level 2' }],
    ['POST', '/api/staff/roles', { userId: local.userId, role: 'coach' }], ['PATCH', '/api/staff/roles/' + target.id, { revision: 1, role: 'front_desk' }],
    ['DELETE', '/api/staff/roles/' + target.id, { revision: allowed ? 2 : 1 }],
  ];
  for (const [method, path, body] of cases) expect((await request(app, method, path, body)).status, method + ' ' + path).toBe(allowed ? 200 : 403);
});
it('denies anonymous, household members, kiosks and principals from another gym', async () => {
  const endpoints = createStaffProfileRoutes(service, directory);
  const principals: Principal[] = [{ kind: 'anonymous' }, { kind: 'member', userId: users.get('coach')!, scope: { gymId: gymA, householdId: uuidv7(), role: 'payer' } }, { kind: 'kiosk', gymId: gymA, deviceId: uuidv7() }, { kind: 'staff', gymId: gymB, userId: otherOwner, roles: ['owner'] }];
  for (const principal of principals) for (const entry of endpoints) {
    const path = entry.definition.path.replace(/\{[^}]+\}/g, uuidv7());
    expect((await request(server('owner', gymA, principal), entry.definition.method.toUpperCase(), path, entry.definition.method === 'get' ? undefined : {})).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
  }
});
it('isolates every read, write and account/member link by gym', async () => {
  const foreign = (await service.createProfile(actor('owner', gymB), { displayName: 'Private B', userId: otherOwner })).data;
  const foreignRole = (await service.listRoles(gymB, { limit: 50, offset: 0 })).data[0]!;
  const foreignMember = await factory('members', gymB), app = server();
  expect((await app.request('/api/staff/profiles')).status).toBe(200);
  expect(await (await app.request('/api/staff/profiles')).text()).not.toContain(foreign.id);
  expect(await (await app.request('/api/staff/roles')).text()).not.toContain(foreignRole.id);
  const cases: [string, string, unknown?][] = [['GET', '/api/staff/profiles/' + foreign.id], ['PATCH', '/api/staff/profiles/' + foreign.id, { revision: 1, bio: 'bad' }],
    ['POST', '/api/staff/profiles', { displayName: 'bad', memberId: foreignMember.id }], ['POST', '/api/staff/profiles', { displayName: 'bad', userId: otherOwner }],
    ['POST', '/api/staff/roles', { userId: otherOwner, role: 'admin' }], ['PATCH', '/api/staff/roles/' + foreignRole.id, { revision: 1, role: 'coach' }], ['DELETE', '/api/staff/roles/' + foreignRole.id, { revision: 1 }]];
  for (const [method, path, body] of cases) expect((await request(app, method, path, body)).status, path).toBe(404);
  expect((await service.getProfile(gymB, foreign.id)).data).toEqual(foreign);
});
it('links, resends and clears a local member link and refuses a cross-gym link on update', async () => {
  const person = await factory('members', gymA);
  const foreign = await factory('members', gymB);
  const profile = await factory('staffProfiles', gymA);
  const app = server(), path = '/api/staff/profiles/' + profile.id;
  for (const [revision, memberId] of [[1, person.id], [2, person.id], [3, null]] as const) {
    const response = await request(app, 'PATCH', path, { revision, memberId });
    expect(response.status).toBe(200);
    expect(staffProfileResponseSchema.parse(await response.json()).data).toMatchObject({ memberId, revision: revision + 1 });
  }
  expect((await request(app, 'PATCH', path, { revision: 4, memberId: foreign.id })).status).toBe(404);
  expect((await service.getProfile(gymA, profile.id)).data).toMatchObject({ memberId: null, revision: 4 });
});
it('keeps or clears an existing erased member link and refuses new erased member links', async () => {
  const erased = await factory('members', gymA, { anonymizedAt: clock.now() });
  const otherErased = await factory('members', gymA, { anonymizedAt: clock.now() });
  const profile = await factory('staffProfiles', gymA, { memberId: erased.id });
  const app = server(), path = '/api/staff/profiles/' + profile.id;

  const saved = await request(app, 'PATCH', path, { revision: profile.revision, memberId: erased.id, bio: 'New bio' });
  expect(saved.status).toBe(200);
  const updated = staffProfileResponseSchema.parse(await saved.json()).data;
  expect(updated).toMatchObject({ memberId: erased.id, bio: 'New bio', revision: profile.revision + 1 });
  expect((await service.getProfile(gymA, profile.id)).data).toEqual(updated);

  const rejected = await request(app, 'PATCH', path, { revision: updated.revision, memberId: otherErased.id, bio: 'Rejected bio' });
  expect(rejected.status).toBe(404);
  expect(await rejected.json()).toMatchObject({ error: { code: 'not_found', message: 'Member not found' } });
  expect((await service.getProfile(gymA, profile.id)).data).toEqual(updated);

  const cleared = await request(app, 'PATCH', path, { revision: updated.revision, memberId: null });
  expect(cleared.status).toBe(200);
  expect(staffProfileResponseSchema.parse(await cleared.json()).data).toMatchObject({ memberId: null, revision: updated.revision + 1 });

  const created = await request(app, 'POST', '/api/staff/profiles', { displayName: 'New profile', memberId: erased.id });
  expect(created.status).toBe(404);
  expect(await created.json()).toMatchObject({ error: { code: 'not_found', message: 'Member not found' } });
});
it.each(['erase', 'delete'] as const)('waits for member %s before locking a profile that resends its existing link', async kind => {
  const home = await factory('households', gymA);
  const person = await factory('members', gymA, { householdId: home.id });
  const profile = await factory('staffProfiles', gymA, { memberId: person.id });
  const locked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, async tx => {
    await tx.select().from(households).where(eq(households.id, home.id)).for('update');
    await tx.select().from(members).where(eq(members.id, person.id)).for('update');
    locked.resolve();
    await resume.promise;
    // The PATCH must leave the profile available while it waits for the member.
    await tx.select().from(staffProfiles).where(eq(staffProfiles.id, profile.id)).for('update', { noWait: true });
    return fn(tx);
  });
  const memberService = createMembersService({ scope, clock });
  const context = { gymId: gymA, actor: { kind: 'system' as const } };
  const cleanup = { jobs: new FakeJobs(clock), timezone: 'UTC' };
  const removing = kind === 'erase'
    ? memberService.eraseMember(context, person.id, { revision: person.revision }, cleanup)
    : memberService.deleteMember(context, person.id, person.revision, cleanup);
  const app = server(), path = '/api/staff/profiles/' + profile.id;
  await Promise.race([locked.promise, removing.then(() => { throw new Error('Member removal finished before the lock was held'); })]);
  const saving = request(app, 'PATCH', path, { revision: profile.revision, memberId: person.id, displayName: 'Concurrent edit' });
  try {
    await expect.poll(async () => {
      const [row] = await db.system.sql`select exists (select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        and query ilike '%"members"%' and query ilike '%for share%') as waiting`;
      return row!.waiting;
    }, { timeout: 5000 }).toBe(true);
  } finally {
    resume.resolve();
    await Promise.allSettled([removing, saving]);
  }
  expect(await removing).toMatchObject(kind === 'erase' ? { householdErased: true } : { householdDeleted: true });
  const response = await saving;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'conflict', message: 'The record changed; reload before saving' } });
  const revision = profile.revision + 1;
  expect((await request(app, 'PATCH', path, { revision, memberId: person.id })).status).toBe(404);
  expect((await service.getProfile(gymA, profile.id)).data).toMatchObject({ memberId: null, revision, displayName: profile.displayName });
});
it('stores profile fields, filters and paginates, and atomically rejects stale saves', async () => {
  const member = await factory('members', gymA), user = await factory('staffRoles', gymA);
  const app = server();
  const created = staffProfileResponseSchema.parse(await (await request(app, 'POST', '/api/staff/profiles', { displayName: 'Unique specialist', bio: 'Hello', memberId: member.id, userId: user.userId, rank: 'Level 3', isPublic: true })).json()).data;
  expect(created.createdAt).toBe(clock.now().toISOString());
  const found = staffProfileListResponseSchema.parse(await (await app.request('/api/staff/profiles?search=Unique&limit=1&offset=0')).json());
  expect(found.data).toEqual([created]); expect(found.pagination.total).toBe(1);
  const outcomes = await Promise.all(['First', 'Second'].map((bio) => request(app, 'PATCH', '/api/staff/profiles/' + created.id, { revision: 1, bio })));
  expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await service.getProfile(gymA, created.id)).data.revision).toBe(2);
  expect((await request(app, 'POST', '/api/staff/profiles', { displayName: 'Bad', photoKey: gymB + '/photo.jpg' })).status).toBe(400);
  expect((await request(app, 'POST', '/api/staff/profiles', { displayName: 'Bad', photoKey: gymA + '/../photo.jpg' })).status).toBe(400);
  expect((await request(app, 'POST', '/api/staff/profiles', { displayName: 'Duplicate', userId: user.userId })).status).toBe(409);
  expect((await app.request('/api/staff/profiles?limit=101')).status).toBe(400);
  const events = await db.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, created.id)));
  expect(events.map((row) => row.action).sort()).toEqual(['staff.profile_created', 'staff.profile_updated']);
});
it('forbids owner grants and owner mutations and uses revisions on role changes/revocation', async () => {
  const owner = (await service.listRoles(gymA, { limit: 100, offset: 0 })).data.find((r) => r.role === 'owner')!, app = server();
  expect((await request(app, 'POST', '/api/staff/roles', { userId: uuidv7(), role: 'owner' })).status).toBe(400);
  expect((await request(app, 'PATCH', '/api/staff/roles/' + owner.id, { role: 'admin', revision: owner.revision })).status).toBe(403);
  expect((await request(app, 'DELETE', '/api/staff/roles/' + owner.id, { revision: owner.revision })).status).toBe(403);
  const target = await factory('staffRoles', gymA);
  const changed = staffRoleResponseSchema.parse(await (await request(app, 'PATCH', '/api/staff/roles/' + target.id, { revision: 1, role: 'admin' })).json()).data;
  expect(changed.revision).toBe(2);
  expect((await request(app, 'DELETE', '/api/staff/roles/' + target.id, { revision: 1 })).status).toBe(409);
  expect((await request(app, 'DELETE', '/api/staff/roles/' + target.id, { revision: 2 })).status).toBe(200);
});
it('rechecks manager access inside mutations and rolls back a rejected change', async () => {
  const user = await factory('staffRoles', gymA, { role: 'admin' });
  const stale = { gymId: gymA, actorUserId: user.userId, clock };
  await db.forGym(gymA, (tx) => tx.delete(staffRoles).where(eq(staffRoles.id, user.id)));
  await expect(service.createProfile(stale, { displayName: 'Denied stale session' })).rejects.toMatchObject({ code: 'forbidden' });
});

it.each(['admin', 'coach', 'front_desk', 'revoke'] as const)('only an owner can change an admin role: %s', async change => {
  const target = await factory('staffRoles', gymA, { role: 'admin' });
  const method = change === 'revoke' ? 'DELETE' : 'PATCH', path = '/api/staff/roles/' + target.id;
  const body = { revision: target.revision, ...(change === 'revoke' ? {} : { role: change }) };
  // Refuse both a peer and the caller's own admin role before a reset could target a demoted login.
  for (const id of [target.id, (await service.listRoles(gymA, { limit: 100, offset: 0 })).data.find(row => row.userId === users.get('admin'))!.id])
    expect((await request(server('admin'), method, '/api/staff/roles/' + id, body)).status).toBe(403);
  expect((await service.listRoles(gymA, { limit: 100, offset: 0 })).data.find(row => row.id === target.id)).toMatchObject({ role: 'admin', revision: target.revision });
  await expect(db.forGym(gymA, tx => assertCanResetPassword(tx, { gymId: gymA, actorUserId: users.get('admin')!, targetUserId: target.userId })))
    .rejects.toMatchObject({ code: 'forbidden' });
  expect(await db.forGym(gymA, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, target.id)))).toEqual([]);
  expect((await request(server('owner'), method, path, body)).status).toBe(200);
  const events = await db.forGym(gymA, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, target.id)));
  expect(events.map(row => row.action)).toEqual([change === 'revoke' ? 'staff.role_revoked' : 'staff.role_changed']);
});

it('names the owner without a profile and searches only linked gym accounts, with literal words and pagination', async () => {
  const owner = await factory('authUser', gymA, { name: 'Morgan Owner', email: 'site.owner@example.test' });
  await factory('staffRoles', gymA, { userId: owner.id, role: 'owner' });
  const memberLogin = await factory('authUser', gymA, { name: 'Casey Phone', email: 'casey_phone@example.test' });
  await factory('householdUsers', gymA, { userId: memberLogin.id });
  const foreign = await factory('authUser', gymB, { name: 'Casey Foreign', email: 'casey.foreign@example.test' });
  await factory('staffRoles', gymB, { userId: foreign.id });
  const unlinked = await factory('authUser', gymA, { name: 'Casey Unlinked' });
  const app = server();
  const accounts = async (query: string) => (await (await app.request('/api/staff/accounts?' + query)).json()) as { data: { id: string; displayName: string }[]; pagination: { total: number } };
  expect((await accounts('search=Phone%20Casey')).data.map(row => row.id)).toEqual([memberLogin.id]);
  expect((await accounts('search=casey_')).data.map(row => row.id)).toEqual([memberLogin.id]);
  expect((await accounts('search=Casey&limit=1&offset=1')).pagination.total).toBe(1);
  expect((await accounts('search=Casey&limit=1&offset=1')).data).toEqual([]);
  expect((await accounts('userId=' + foreign.id)).data).toEqual([]);
  expect((await accounts('userId=' + unlinked.id)).data).toEqual([]);
  expect((await accounts('userId=' + memberLogin.id + '&staffOnly=true')).data).toEqual([]);
  expect((await accounts('userId=' + owner.id)).data[0]?.displayName).toBe('Morgan Owner');
  expect(await (await app.request('/api/staff/roles?limit=100')).text()).toContain('Morgan Owner');
  expect((await app.request('/api/staff/accounts')).headers.get('cache-control')).toBe('no-store');
  const multi = createStaffDirectory(() => db.system.db, 'multi');
  expect((await multi.list(gymA, { limit: 25, offset: 0, userId: owner.id })).data[0]?.displayName).toBe(owner.email);
  expect((await multi.list(gymA, { limit: 25, offset: 0, search: 'Morgan' })).data).toEqual([]);
  await service.createProfile(actor(), { displayName: 'Local Gym Owner', userId: owner.id });
  expect((await multi.list(gymA, { limit: 25, offset: 0, search: 'Local Owner' })).data[0]?.displayName).toBe('Local Gym Owner');
});
it('reads tenancy when a prebuilt directory is called, for account search and owner names', async () => {
  vi.stubEnv('TENANCY', 'single'); onTestFinished(() => { vi.unstubAllEnvs(); });
  const lazy = createStaffDirectory(() => db.system.db);
  const owner = await factory('authUser', gymA, { name: 'GlobalIdentityOnly', email: 'lazy.owner@example.test' });
  await factory('staffRoles', gymA, { userId: owner.id, role: 'owner' });
  expect((await lazy.names(gymA, [owner.id]))[0]?.displayName).toBe(owner.name);
  vi.stubEnv('TENANCY', 'multi');
  expect((await lazy.list(gymA, { limit: 25, offset: 0, search: owner.name })).data).toEqual([]);
  expect((await lazy.names(gymA, [owner.id]))[0]?.displayName).toBe(owner.email);
  expect(await lazy.names(gymB, [owner.id])).toEqual([]);
  await service.createProfile(actor(), { displayName: 'Local Identity', userId: owner.id });
  expect((await lazy.names(gymA, [owner.id]))[0]?.displayName).toBe('Local Identity');
});
it('uses the configured tenancy for routes built before configuration, including the owner role name', async () => {
  vi.stubEnv('TENANCY', 'single'); onTestFinished(() => { vi.unstubAllEnvs(); });
  const app = server('owner', gymA, undefined, true);
  const owner = await factory('authUser', gymA, { name: 'PrivateInstallIdentity', email: 'configured.owner@example.test' });
  await factory('staffRoles', gymA, { userId: owner.id, role: 'owner' });
  configureStaffProfiles({ tenancy: 'multi', origin: () => 'https://gym.test', uploadsFor: async (gymId) => new FakeUploads(gymId, clock),
    invitations: createStaffInvitationService({ config: { tenancy: 'multi', secret: 's'.repeat(32), production: false,
      passwordEnabled: false, smtpConfigured: true }, smtpConfigured: async () => true, mailer: async () => null }) });
  const account = await app.request('/api/staff/accounts?userId=' + owner.id);
  expect(account.status).toBe(200);
  expect(await account.json()).toMatchObject({ data: [{ id: owner.id, displayName: owner.email }] });
  const search = await app.request('/api/staff/accounts?search=' + owner.name);
  expect(await search.json()).toMatchObject({ data: [] });
  const roles = await app.request('/api/staff/roles?limit=100');
  expect(roles.status).toBe(200);
  expect(await roles.json()).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ userId: owner.id, displayName: owner.email })]) });
});
const credentialScope = createAccountService(authConfig({ AUTH_SECRET: 's'.repeat(32) }, false), () => db.system.db).forGym;
const credentials = (userId: string) => db.system.db.select().from(authAccount).where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')));
const sessions = (userId: string) => db.system.db.select().from(authSession).where(and(eq(authSession.gymId, gymA), eq(authSession.userId, userId)));
const removals = (userId: string) => db.forGym(gymA, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'auth.password_removed'), eq(auditEvents.targetId, userId))));
/** A household login of gym A with a password and a session there. */
async function householdLogin(password = true) {
  const login = await factory('householdUsers', gymA);
  if (password) await factory('authAccount', gymA, { userId: login.userId, accountId: login.userId, password: 'hash-of-a-leftover-password' });
  await factory('authSession', gymA, { userId: login.userId });
  return login.userId;
}
it('outside password mode a role grant removes a leftover password and ends the login\'s gym sessions', async () => {
  const removing = createStaffProfileService(db.forGym, { removesLeftoverPassword: async () => true, credentialScope });
  const userId = await householdLogin();
  expect((await removing.grantRole(actor(), { userId, role: 'coach' })).data).toMatchObject({ userId, role: 'coach' });
  expect(await credentials(userId)).toEqual([]);
  expect(await sessions(userId)).toEqual([]);
  expect(await removals(userId)).toMatchObject([{ actorKind: 'user', actorUserId: users.get('owner'), targetType: 'user', before: null, after: null }]);
  const passwordless = await householdLogin(false);
  await removing.grantRole(actor(), { userId: passwordless, role: 'front_desk' });
  expect(await removals(passwordless)).toEqual([]);
  expect(await sessions(passwordless)).toHaveLength(1);
  // Already staff: refused, and the password stays.
  const staff = await factory('staffRoles', gymA, { role: 'coach' });
  await factory('authAccount', gymA, { userId: staff.userId, accountId: staff.userId, password: 'hash-of-a-staff-password' });
  await expect(removing.grantRole(actor(), { userId: staff.userId, role: 'coach' })).rejects.toMatchObject({ code: 'conflict' });
  expect(await credentials(staff.userId)).toHaveLength(1);
});
it.each([
  ['in password mode', createStaffProfileService(db.forGym, { removesLeftoverPassword: async () => false, credentialScope })],
  ['with no option', createStaffProfileService(db.forGym)],
])('a role grant %s keeps the login\'s password and sessions', async (_name, keeping) => {
  const userId = await householdLogin();
  await keeping.grantRole(actor(), { userId, role: 'coach' });
  expect(await db.forGym(gymA, tx => tx.select().from(staffRoles).where(eq(staffRoles.userId, userId)))).toHaveLength(1);
  expect(await credentials(userId)).toHaveLength(1);
  expect(await sessions(userId)).toHaveLength(1);
  expect(await removals(userId)).toEqual([]);
});
it('the configured grant route removes a leftover password when the gym signs in by login link', async () => {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { gym: { gymId: gymA, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'staff-test',
    principal: { kind: 'staff', userId: users.get('owner')!, gymId: gymA, roles: ['owner'] } }); await next(); });
  // No service passed: the routes use the composition configureStaffProfiles builds.
  app.onError(errorHandler); createServerRegistry({ routes: createStaffProfileRoutes(undefined, directory) }).mount(app, authorize, new Set());
  configureStaffProfiles({ tenancy: 'single', origin: () => 'https://gym.test', uploadsFor: async (gymId) => new FakeUploads(gymId, clock),
    invitations: createStaffInvitationService({ config: { tenancy: 'single', secret: 's'.repeat(32), production: false, passwordEnabled: true,
      passwordMode: 'auto', smtpConfigured: true }, smtpConfigured: async () => true, mailer: async () => null, database: () => db.system.db }) });
  const userId = await householdLogin();
  expect((await request(app, 'POST', '/api/staff/roles', { userId, role: 'coach' })).status).toBe(200);
  expect(await credentials(userId)).toEqual([]);
  expect(await sessions(userId)).toEqual([]);
  expect(await removals(userId)).toHaveLength(1);
});
