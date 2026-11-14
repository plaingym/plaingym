// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { staffRoles, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createStaffDirectory } from '../../infra/auth/staff-directory.js';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles as roleNames, type StaffRole } from '@plaingym/shared';
import { staffProfileResponseSchema, staffProfileListResponseSchema, staffRoleResponseSchema } from '@plaingym/shared/contracts';
import { createStaffProfileService } from './profiles.js';
import { createStaffProfileRoutes } from './profiles.routes.js';
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
  await factory('gyms', gymA); await factory('gyms', gymB);
  for (const role of roleNames) { const user = await factory('authUser', gymA); users.set(role, user.id); await factory('staffRoles', gymA, { userId: user.id, role }); }
  const other = await factory('staffRoles', gymB, { role: 'owner' }); otherOwner = other.userId;
});
const actor = (role: StaffRole = 'owner', gymId = gymA) => ({ gymId, actorUserId: gymId === gymA ? users.get(role)! : otherOwner, clock });
function server(role: StaffRole | 'anonymous' = 'owner', gymId = gymA, principalOverride?: Principal) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'staff-test',
    principal: principalOverride ?? (role === 'anonymous' ? { kind: 'anonymous' } : { kind: 'staff', userId: actor(role, gymId).actorUserId, gymId, roles: [role] }) }); await next(); });
  app.onError(errorHandler); createServerRegistry({ routes: createStaffProfileRoutes(service, directory) }).mount(app, authorize, new Set()); return app;
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
