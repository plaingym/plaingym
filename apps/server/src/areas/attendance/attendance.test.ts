// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { attendances, auditEvents, classSessions, householdUsers, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { attendanceContracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeAttendanceQueries, type AttendanceFixture } from '../../core/interfaces/attendance.js';
import { FakeMemberHouseholdContext } from '../../core/interfaces/member-household.js';
import { createServerRegistry } from '../../core/registry.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { authorize } from '../staff/auth.permissions.js';
import { createAttendanceService } from './attendance.js';
import { createAttendanceRoutes } from './attendance.routes.js';
import { createSettingsService } from '../settings/settings.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
const service = createAttendanceService({ scope: database.forGym, householdScope: database.forHousehold, clock });
const since = '2026-10-20T00:00:00.000Z';
const page = { limit: 50, offset: 0 };
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const member = await factory('members', gymId);
  const sibling = await factory('members', gymId, { householdId: member.householdId });
  const outsider = await factory('members', gymId);
  const program = await factory('programs', gymId), otherProgram = await factory('programs', gymId);
  const tag = await factory('classTags', gymId), otherTag = await factory('classTags', gymId);
  const template = await factory('classTemplates', gymId);
  const session = await factory('classSessions', gymId, { templateId: template.id });
  for (const programId of [program.id, otherProgram.id])
    await factory('classSessionPrograms', gymId, { sessionId: session.id, programId });
  for (const tagId of [tag.id, otherTag.id])
    await factory('classSessionTags', gymId, { sessionId: session.id, tagId });
  // Template links deliberately differ: queries must use the materialized snapshot.
  await factory('classTemplateTags', gymId, { templateId: template.id, tagId: otherTag.id });
  const user = await factory('authUser', gymId);
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const input = { memberId: member.id, sessionId: session.id, programId: program.id };
  return { gymId, member, sibling, outsider, program, otherProgram, tag, otherTag, session, user, context, input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function app(f: Fixture, principal: Principal = { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: ['coach'] }) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (c, next) => {
    c.set('context', { gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'attendance-test' });
    await next();
  });
  server.onError((error, c) => c.json(errorResponse(error, 'attendance-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createAttendanceRoutes(service) }).mount(server, authorize, new Set());
  return server;
}
const post = (server: ReturnType<typeof app>, input: unknown) => server.request('/api/attendance', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
});
async function snapshot(gymId: string) {
  return database.forGym(gymId, async (tx) => ({ rows: await tx.select().from(attendances), audits: await tx.select().from(auditEvents) }));
}

describe('attendance service with PostgreSQL', () => {
  it('serializes concurrent check-ins, returns the original, and audits exactly one mutation', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.record(f.context, f.input)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({ occurredAt: clock.now().toISOString(), createdAt: clock.now().toISOString(), source: 'coach' });
    const data = await snapshot(f.gymId);
    expect(data.rows).toHaveLength(1); expect(data.audits).toHaveLength(1);
    expect(data.audits[0]).toMatchObject({ actorKind: 'user', actorUserId: f.user.id, action: 'attendance.recorded',
      targetId: results[0]!.id, after: results[0], occurredAt: clock.now(), createdAt: clock.now() });
    expect(results[0]!.id).toMatch(/^[0-9a-f-]{14}7[0-9a-f]{3}-[89ab]/);
    expect(results[0]).not.toHaveProperty('sourceKey'); expect(results[0]).not.toHaveProperty('gymId');
  });
  it('allows distinct open-mat visits and deduplicates imported visits by source key', async () => {
    const f = await fixture();
    const input = { ...f.input, sessionId: null };
    const first = await service.record(f.context, input), second = await service.record(f.context, input);
    expect(first.id).not.toBe(second.id);
    const imported = await Promise.all(Array.from({ length: 5 }, () => service.record(f.context,
      { ...input, occurredAt: since }, { source: 'import', sourceKey: 'legacy:visit:1' })));
    expect(new Set(imported.map((row) => row.id)).size).toBe(1);
    expect(imported[0]).toMatchObject({ source: 'import', occurredAt: since });
    await expect(service.record(f.context, { ...input, memberId: f.sibling.id }, { source: 'import', sourceKey: 'legacy:visit:1' }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await snapshot(f.gymId)).rows).toHaveLength(3);
    expect((await snapshot(f.gymId)).audits).toHaveLength(3);
  });
  it('records open mat as visits that count as classes only when the gym opts in', async () => {
    const f = await fixture();
    const openMat = await factory('classSessions', f.gymId, { kind: 'open_mat' });
    const visit = { ...f.input, occurredAt: since };
    const recorded = [
      await service.record(f.context, visit),
      await service.record(f.context, { ...visit, sessionId: null }),
      await service.record(f.context, { ...visit, sessionId: openMat.id }),
      await service.record(f.context, { ...visit, sessionId: null }, { source: 'import', sourceKey: 'legacy:1' }),
      await service.record(f.context, { ...visit, sessionId: null }, { source: 'import', sourceKey: 'legacy:2', kind: 'open_mat' }),
    ];
    expect(recorded.map((row) => row.kind)).toEqual(['class', 'open_mat', 'open_mat', 'class', 'open_mat']);
    await expect(service.record(f.context, visit, { source: 'coach', kind: 'class' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.record(f.context, visit, { source: 'import', sourceKey: 'legacy:3', kind: 'class' })).rejects.toMatchObject({ code: 'invalid_request' });
    const payer = await factory('authUser', f.gymId);
    await factory('householdUsers', f.gymId, { householdId: f.member.householdId, userId: payer.id, scope: 'payer' });
    const scopes = [{ kind: 'gym' as const, gymId: f.gymId },
      { kind: 'household' as const, identity: { gymId: f.gymId, householdId: f.member.householdId, userId: payer.id } }];
    const counts = async (classesOnly: boolean) => Promise.all(scopes.map((scope) =>
      service.queries.countSince(scope, { memberId: f.member.id, since, classesOnly })));
    expect(await counts(false)).toEqual([5, 5]);
    expect(await counts(true)).toEqual([2, 2]);
    expect((await service.queries.history(scopes[1]!, { classesOnly: true }, page)).data.map((row) => row.kind)).toEqual(['class', 'class']);
    expect(await service.totals(f.gymId, { memberId: f.member.id })).toMatchObject({ total: 5, classes: 2, openMat: 3 });
    expect((await service.list(f.gymId, { ...page, kind: 'open_mat' })).pagination.total).toBe(3);
    const settings = createSettingsService({ scope: database.forGym, clock });
    await settings.update(f.context, 'booking', { revision: (await settings.get(f.gymId)).revision, openMatCountsAsClass: true });
    expect(await counts(true)).toEqual([5, 5]);
    expect(await service.totals(f.gymId, { memberId: f.member.id })).toMatchObject({ total: 5, classes: 5, openMat: 3 });
    // A later change to the session never reclassifies recorded attendance.
    await database.forGym(f.gymId, (tx) => tx.update(classSessions).set({ kind: 'class' }).where(eq(classSessions.id, openMat.id)));
    expect((await service.list(f.gymId, { ...page, kind: 'open_mat' })).pagination.total).toBe(3);
  });
  it('rejects fresh check-ins to cancelled sessions, but still returns an existing check-in', async () => {
    const f = await fixture();
    const attendance = await service.record(f.context, f.input);
    const cancelled = await factory('classSessions', f.gymId, { status: 'cancelled' });
    await expect(service.record(f.context, { ...f.input, sessionId: cancelled.id })).rejects.toMatchObject({ code: 'conflict' });
    // Cancellation is fixture setup; schedule owns the runtime operation.
    await database.forGym(f.gymId, (tx) => tx.update(classSessions).set({ status: 'cancelled' }).where(eq(classSessions.id, f.session.id)));
    expect(await service.record(f.context, f.input)).toEqual(attendance);
  });
  it('rolls back attendance when its audit cannot be written', async () => {
    const f = await fixture();
    await expect(service.record({ ...f.context, actor: { kind: 'user', userId: uuidv7() } }, f.input)).rejects.toThrow();
    expect(await snapshot(f.gymId)).toEqual({ rows: [], audits: [] });
  });
  it('refuses erased members for session, open-mat and imported check-ins without writing data', async () => {
    const f = await fixture(), erased = await factory('members', f.gymId, { anonymizedAt: clock.now() });
    const foreign = await fixture(), foreignErased = await factory('members', foreign.gymId, { anonymizedAt: clock.now() });
    const server = app(f);
    for (const sessionId of [f.session.id, null]) {
      expect((await post(server, { ...f.input, memberId: erased.id, sessionId })).status).toBe(409);
      expect((await post(server, { ...f.input, memberId: foreignErased.id, sessionId })).status).toBe(404);
    }
    await expect(service.record(f.context, { ...f.input, memberId: erased.id, sessionId: null }, { source: 'import', sourceKey: 'erased:1' }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await snapshot(f.gymId)).toEqual({ rows: [], audits: [] });
  });
  it('audits trusted kiosk check-ins as the device, with no staff identity', async () => {
    const f = await fixture(), device = await factory('kioskDevices', f.gymId);
    await service.record({ gymId: f.gymId, actor: { kind: 'device', deviceId: device.id } }, f.input, { source: 'kiosk' });
    expect((await snapshot(f.gymId)).audits[0]).toMatchObject({ actorKind: 'device', actorDeviceId: device.id, actorUserId: null });
  });
  it('counts program/tag snapshots once, includes direct imported programs, and uses [since, until)', async () => {
    const f = await fixture();
    await service.record(f.context, { ...f.input, occurredAt: since });
    await service.record(f.context, { ...f.input, sessionId: null, occurredAt: '2026-10-21T00:00:00Z' }, { source: 'import', sourceKey: 'old:2' });
    await service.record(f.context, { ...f.input, sessionId: null, programId: null, occurredAt: '2026-10-22T00:00:00Z' });
    const totals = await service.totals(f.gymId, { memberId: f.member.id });
    expect(totals.total).toBe(3);
    expect(totals.byProgram).toEqual(expect.arrayContaining([{ programId: f.program.id, count: 2 }, { programId: f.otherProgram.id, count: 1 }]));
    expect(totals.byTag).toEqual(expect.arrayContaining([{ tagId: f.tag.id, count: 1 }, { tagId: f.otherTag.id, count: 1 }]));
    expect((await service.totals(f.gymId, { memberId: f.member.id, since, until: '2026-10-21T00:00:00Z' })).total).toBe(1);
    expect((await service.list(f.gymId, { ...page, programId: f.otherProgram.id })).pagination.total).toBe(1);
    expect((await service.list(f.gymId, { ...page, source: 'import', tagId: f.tag.id })).data).toEqual([]);
    expect((await service.list(f.gymId, { ...page, source: 'import' })).pagination.total).toBe(1);
  });
});

describe('real AttendanceQueries conformance', () => {
  async function queriesFixture() {
    const f = await fixture();
    const first = await service.record(f.context, { ...f.input, occurredAt: since });
    const second = await service.record(f.context, { ...f.input, sessionId: null, occurredAt: '2026-10-21T00:00:00Z' }, { source: 'import', sourceKey: 'old' });
    const third = await service.record(f.context, { ...f.input, sessionId: null, occurredAt: '2026-10-21T00:00:00Z' });
    const fixtures: AttendanceFixture[] = [first, second, third].map(({ createdAt: _createdAt, ...entry }) => ({
      gymId: f.gymId, entry, sessionProgramIds: [f.program.id, f.otherProgram.id], sessionTagIds: [f.tag.id, f.otherTag.id],
    }));
    const fake = new FakeAttendanceQueries(fixtures);
    return { f, fake, fixtures, scope: { kind: 'gym' as const, gymId: f.gymId } };
  }
  it('matches the frozen fake for joins, direct import programs, tags, offsets, pagination, and stable ties', async () => {
    const { f, fake, scope } = await queriesFixture();
    for (const filter of [{}, { programId: f.program.id }, { programId: f.otherProgram.id }, { tagId: f.tag.id },
      { since: '2026-10-19T17:00:00-07:00', until: '2026-10-21T00:00:00Z' }, { programId: uuidv7() }]) {
      for (const pagination of [page, { limit: 1, offset: 1 }])
        expect(await service.queries.history(scope, filter, pagination)).toEqual(await fake.history(scope, filter, pagination));
      const countFilter = { ...filter, memberId: f.member.id, since };
      expect(await service.queries.countSince(scope, countFilter)).toBe(await fake.countSince(scope, countFilter));
    }
    await expect(service.queries.history(scope, {}, { limit: 101, offset: 0 })).rejects.toThrow();
    await expect(service.queries.countSince(scope, { memberId: f.member.id, since: '2026-10-22T00:00:00Z', until: since })).rejects.toThrow();
    expect(await service.queries.countSince(scope, { memberId: f.sibling.id, since })).toBe(0);
    expect(await service.queries.countSince(scope, { memberId: f.member.id, since, until: since })).toBe(0);
  });
  it('reloads household grants, separates payer/adult scope, and cannot expose another household or gym', async () => {
    const { f, fixtures } = await queriesFixture();
    const siblingVisit = await service.record(f.context, { ...f.input, memberId: f.sibling.id });
    await service.record(f.context, { ...f.input, memberId: f.outsider.id });
    const payer = await factory('authUser', f.gymId), adult = await factory('authUser', f.gymId);
    const payerIdentity = { gymId: f.gymId, householdId: f.member.householdId, userId: payer.id };
    const adultIdentity = { ...payerIdentity, userId: adult.id };
    await factory('householdUsers', f.gymId, { householdId: f.member.householdId, userId: payer.id, scope: 'payer' });
    const adultLink = await factory('householdUsers', f.gymId, { householdId: f.member.householdId, userId: adult.id, scope: 'member', memberId: f.member.id });
    const households = new FakeMemberHouseholdContext([f.member, f.sibling, f.outsider], [
      { ...payerIdentity, role: 'payer', memberId: null }, { ...adultIdentity, role: 'member', memberId: f.member.id },
    ]);
    const { createdAt: _createdAt, ...entry } = siblingVisit;
    expect(_createdAt).toBe(clock.now().toISOString());
    const fake = new FakeAttendanceQueries([...fixtures, { gymId: f.gymId, entry,
      sessionProgramIds: [f.program.id, f.otherProgram.id], sessionTagIds: [f.tag.id, f.otherTag.id] }], households);
    for (const identity of [payerIdentity, adultIdentity]) {
      const scope = { kind: 'household' as const, identity };
      for (const filter of [{}, { tagId: f.tag.id }, { programId: f.otherProgram.id }, { memberId: f.member.id }])
        expect(await service.queries.history(scope, filter, page)).toEqual(await fake.history(scope, filter, page));
      expect(await service.queries.countSince(scope, { memberId: f.member.id, since })).toBe(3);
      await expect(service.queries.history(scope, { memberId: f.outsider.id }, page)).rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(service.queries.countSince({ kind: 'household', identity: adultIdentity }, { memberId: f.sibling.id, since }))
      .rejects.toMatchObject({ code: 'not_found' });
    for (const identity of [{ ...adultIdentity, gymId: uuidv7() }, { ...adultIdentity, householdId: f.outsider.householdId }])
      await expect(service.queries.history({ kind: 'household', identity }, {}, page)).rejects.toMatchObject({ code: 'not_found' });
    await database.forGym(f.gymId, (tx) => tx.delete(householdUsers).where(eq(householdUsers.id, adultLink.id)));
    await expect(service.queries.history({ kind: 'household', identity: adultIdentity }, {}, page)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('attendance HTTP authorization and tenant isolation', () => {
  it.each(staffRoles)('allows %s to record, list, and read totals using frozen contracts', async (role: StaffRole) => {
    const f = await fixture(), server = app(f, { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
    const recorded = await post(server, f.input); expect(recorded.status).toBe(200);
    expect(attendanceContracts.record.response.safeParse(await recorded.json()).success).toBe(true);
    const listed = await server.request('/api/attendance'); expect(listed.status).toBe(200);
    expect(attendanceContracts.list.response.safeParse(await listed.json()).success).toBe(true);
    const totals = await server.request('/api/attendance/totals?memberId=' + f.member.id); expect(totals.status).toBe(200);
    expect(attendanceContracts.totals.response.safeParse(await totals.json()).success).toBe(true);
  });
  it('denies every endpoint to non-staff, unprivileged staff, and a staff session from another gym', async () => {
    const f = await fixture();
    const principals: Principal[] = [
      { kind: 'anonymous' }, { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [] },
      { kind: 'staff', gymId: uuidv7(), userId: f.user.id, roles: ['owner'] },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      { kind: 'member', userId: f.user.id, scope: { gymId: f.gymId, householdId: f.member.householdId, role: 'payer' } },
      { kind: 'signed_link', gymId: f.gymId, linkId: uuidv7(), householdId: f.member.householdId, link: { purpose: 'update_card' } },
    ];
    for (const principal of principals) {
      const server = app(f, principal), status = principal.kind === 'anonymous' ? 401 : 403;
      expect((await post(server, f.input)).status).toBe(status);
      expect((await server.request('/api/attendance')).status).toBe(status);
      expect((await server.request('/api/attendance/totals?memberId=' + f.member.id)).status).toBe(status);
    }
    expect(await snapshot(f.gymId)).toEqual({ rows: [], audits: [] });
  });
  it('returns 404 for another gym\'s member, session, program, and tag on every relevant endpoint', async () => {
    const a = await fixture(), b = await fixture(), server = app(a);
    await service.record(b.context, b.input);
    for (const input of [{ ...a.input, memberId: b.member.id }, { ...a.input, sessionId: b.session.id }, { ...a.input, programId: b.program.id }])
      expect((await post(server, input)).status).toBe(404);
    for (const [key, value] of Object.entries({ memberId: b.member.id, sessionId: b.session.id, programId: b.program.id, tagId: b.tag.id }))
      expect((await server.request('/api/attendance?' + key + '=' + value)).status).toBe(404);
    expect((await server.request('/api/attendance/totals?memberId=' + b.member.id)).status).toBe(404);
    expect((await service.queries.history({ kind: 'gym', gymId: a.gymId }, {}, page)).data).toEqual([]);
    expect(await service.queries.countSince({ kind: 'gym', gymId: a.gymId }, { memberId: b.member.id, since })).toBe(0);
    expect((await snapshot(b.gymId)).rows).toHaveLength(1);
    expect(await snapshot(a.gymId)).toEqual({ rows: [], audits: [] });
  });
  it('rejects malformed ranges and coach-supplied sources without writing', async () => {
    const f = await fixture(), server = app(f);
    expect((await post(server, { ...f.input, source: 'kiosk' })).status).toBe(400);
    expect((await post(server, { ...f.input, sourceKey: 'fake' })).status).toBe(400);
    expect((await server.request('/api/attendance?since=2026-10-22T00:00:00Z&until=2026-10-20T00:00:00Z')).status).toBe(400);
    expect((await snapshot(f.gymId)).rows).toHaveLength(0);
  });
});
