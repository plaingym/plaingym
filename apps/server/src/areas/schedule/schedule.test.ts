// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, attendances, classBookings, classSessions, classSessionPrograms, classSessionTags, uuidv7, RevisionConflictError } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { canStaff, staffRoles, type StaffRole } from '@plaingym/shared';
import { scheduleContracts, type CreateClassTemplateRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { errorHandler } from '../../core/errors.js';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { authorize } from '../staff/auth.permissions.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createScheduleService } from './schedule.js';
import { createScheduleRoutes } from './schedule.routes.js';
import { createScheduleJobs } from './schedule.jobs.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-03-01T00:00:00Z'), service = createScheduleService({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7(), context = (gymId = gymA) => ({ gymId, actor: { kind: 'system' as const } });
let programA: string, programB: string, coachA: string, coachB: string, userId: string;
beforeAll(async () => {
  await factory('gyms', gymA, { timezone: 'America/New_York' }); await factory('gyms', gymB, { timezone: 'Asia/Tokyo' });
  programA = (await factory('programs', gymA, { name: 'A program' })).id;
  programB = (await factory('programs', gymB, { name: 'B private program' })).id;
  coachA = (await factory('staffProfiles', gymA, { displayName: 'A coach' })).id;
  coachB = (await factory('staffProfiles', gymB, { displayName: 'B private coach' })).id;
  userId = (await factory('authUser', gymA)).id;
});
function fields(gymId = gymA): CreateClassTemplateRequest {
  return { name: 'Evening class', weekday: 0, localStartTime: '18:00', durationMinutes: 60, coachId: gymId === gymA ? coachA : coachB,
    capacity: null, notes: null, kind: 'class', programIds: [gymId === gymA ? programA : programB], tagIds: [] };
}
function sessionFields(gymId = gymA) {
  const { name, coachId, capacity, notes, kind, programIds, tagIds } = fields(gymId);
  return { name, coachId, capacity, notes, kind, programIds, tagIds, startsAt: '2026-03-02T18:00:00Z', endsAt: '2026-03-02T19:00:00Z' };
}
function server(role: StaffRole | 'anonymous' | 'member' = 'owner', gymId = gymA) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: gymId === gymA ? 'America/New_York' : 'Asia/Tokyo', enabledModules: new Set() },
      principal: role === 'anonymous' ? { kind: 'anonymous' } : role === 'member' ? { kind: 'member', userId, scope: { gymId, householdId: uuidv7(), role: 'payer' } }
        : { kind: 'staff', gymId, userId, roles: [role] }, clock, requestId: 'schedule-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createScheduleRoutes(service) }).mount(app, authorize, new Set());
  return app;
}
const request = (app: ReturnType<typeof server>, method: string, path: string, body?: unknown) => app.request(path, {
  method: method.toUpperCase(), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
async function resources(gymId = gymA) {
  return { tag: await service.createTag(context(gymId), { name: uuidv7() }),
    template: await service.createTemplate(context(gymId), fields(gymId)), session: await service.createSession(context(gymId), sessionFields(gymId)) };
}
type RouteName = keyof typeof scheduleContracts;
function input(name: RouteName, target: Awaited<ReturnType<typeof resources>>, gymId = gymA) {
  const id = name.includes('Tag') ? target.tag.id : name.includes('Template') ? target.template.id : target.session.id;
  let body: unknown;
  if (name === 'createTag' || name === 'updateTag') body = { name: uuidv7(), ...(name === 'updateTag' ? { revision: 1 } : {}) };
  else if (name === 'createTemplate' || name === 'updateTemplate') body = { ...fields(gymId), ...(name === 'updateTemplate' ? { revision: 1 } : {}) };
  else if (name === 'createSession' || name === 'updateSession') body = { ...sessionFields(gymId), ...(name === 'updateSession' ? { revision: 1 } : {}) };
  else if (name === 'swapCoach') body = { revision: 1, coachId: gymId === gymA ? coachA : coachB };
  else if (name === 'updateNotes') body = { revision: 1, notes: '<script>plain text</script>' };
  else if (name === 'updateCapacity') body = { revision: 1, capacity: 25 };
  else if (['deleteTag', 'deleteTemplate', 'cancelSession'].includes(name)) body = { revision: 1 };
  return { path: scheduleContracts[name].path.replace('{id}', id) + (name === 'listSessions' ? '?from=2026-01-01T00:00:00Z&until=2027-01-01T00:00:00Z' : ''), body };
}
describe('schedule routes and tenant isolation', () => {
  it.each(staffRoles)('checks every endpoint with valid requests for %s', async (role) => {
    const app = server(role);
    for (const name of Object.keys(scheduleContracts) as RouteName[]) {
      const target = await resources(), contract = scheduleContracts[name], value = input(name, target);
      const response = await request(app, contract.method, value.path, value.body);
      const allowed = canStaff([role], contract.permission.capability);
      expect(response.status, name).toBe(allowed ? 200 : 403);
      if (allowed) expect(contract.response.safeParse(await response.json()).success, name).toBe(true);
    }
    expect((await app.request('/api/schedule/options')).status).toBe(200);
  });
  it.each(['anonymous', 'member'] as const)('denies all endpoints to %s before validation', async (role) => {
    const app = server(role), target = await resources();
    for (const name of Object.keys(scheduleContracts) as RouteName[]) {
      const contract = scheduleContracts[name], value = input(name, target);
      expect((await request(app, contract.method, value.path, value.body)).status, name).toBe(role === 'anonymous' ? 401 : 403);
    }
    expect((await app.request('/api/schedule/options')).status).toBe(role === 'anonymous' ? 401 : 403);
  });
  it('returns 404 on every foreign resource and rejects foreign relationship IDs on create', async () => {
    const app = server(), foreign = await resources(gymB);
    for (const name of Object.keys(scheduleContracts) as RouteName[]) {
      const contract = scheduleContracts[name];
      if (!contract.path.includes('{id}')) continue;
      const value = input(name, foreign, gymB);
      expect((await request(app, contract.method, value.path, value.body)).status, name).toBe(404);
    }
    for (const name of ['createTemplate', 'createSession'] as const) {
      const value = input(name, foreign, gymB);
      expect((await request(app, scheduleContracts[name].method, value.path, value.body)).status).toBe(404);
    }
    const local = await resources();
    for (const [name, path, body] of [
      ['foreign coach', '/api/schedule/sessions/' + local.session.id + '/coach', { revision: 1, coachId: coachB }],
      ['foreign tag', '/api/schedule/templates', { ...fields(), tagIds: [foreign.tag.id] }],
    ] as const) expect((await request(app, 'POST', path, body)).status, name).toBe(404);
    const options = await (await app.request('/api/schedule/options')).json();
    expect(JSON.stringify(options)).not.toMatch(/B private/);
    const tags = await service.listTags(gymA, { limit: 100, offset: 0 });
    expect(tags.data.some((tag) => tag.id === foreign.tag.id)).toBe(false);
    const templates = await service.listTemplates(gymA, { limit: 100, offset: 0, programId: programB });
    expect(templates.data).toEqual([]);
    const sessions = await service.listSessions(gymA, { limit: 100, offset: 0, from: '2026-01-01T00:00:00Z', until: '2027-01-01T00:00:00Z', coachId: coachB });
    expect(sessions.data).toEqual([]);
  });
  it('returns stale revisions as 409 and only one concurrent save wins', async () => {
    const { session } = await resources();
    const responses = await Promise.all([10, 20].map((capacity) => request(server(), 'PATCH', '/api/schedule/sessions/' + session.id + '/capacity', { revision: 1, capacity })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await expect(service.changeSession(context(), session.id, 'notes', { revision: 1, notes: 'stale' })).rejects.toBeInstanceOf(RevisionConflictError);
  });
  it('materializes open-mat templates as open-mat sessions and defaults new records to classes', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const program = await factory('programs', gymId);
    const base = { ...fields(), coachId: null, programIds: [program.id] };
    const withoutKind: Partial<CreateClassTemplateRequest> = { ...base }; delete withoutKind.kind;
    expect((await service.createTemplate(context(gymId), withoutKind as CreateClassTemplateRequest)).kind).toBe('class');
    const template = await service.createTemplate(context(gymId), { ...base, kind: 'open_mat', weekday: 3 });
    await service.materialize(gymId, 'America/New_York');
    const sessions = await database.forGym(gymId, (tx) => tx.select().from(classSessions).where(eq(classSessions.templateId, template.id)));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.kind === 'open_mat')).toBe(true);
    const updated = await service.updateTemplate(context(gymId), template.id, { ...base, kind: 'class', weekday: 3, revision: template.revision });
    expect(updated.kind).toBe('class');
    expect((await service.getSession(gymId, sessions[0]!.id)).kind).toBe('open_mat');
  });
  it('keeps sessions and attendance on template deletion and exposes no session DELETE route', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const program = await factory('programs', gymId);
    const template = await service.createTemplate(context(gymId), { ...fields(), coachId: null, programIds: [program.id] });
    await service.materialize(gymId, 'America/New_York');
    const [session] = await database.forGym(gymId, (tx) => tx.select().from(classSessions));
    const member = await factory('members', gymId);
    await factory('attendances', gymId, { sessionId: session!.id, memberId: member.id });
    expect((await request(server('owner', gymId), 'DELETE', '/api/schedule/sessions/' + session!.id, { revision: 1 })).status).toBe(404);
    await service.changeSession(context(gymId), session!.id, 'cancel', { revision: 1 });
    await service.deleteTemplate(context(gymId), template.id, { revision: template.revision });
    expect(await service.getSession(gymId, session!.id)).toMatchObject({ status: 'cancelled', templateId: null });
    expect(await database.forGym(gymId, (tx) => tx.select().from(attendances))).toHaveLength(1);
    await expect(database.forGym(gymId, (tx) => tx.delete(classSessions).where(eq(classSessions.id, session!.id)))).rejects.toThrow();
  });
  it('audits mutations with the injected clock and rejects deletion of a referenced tag', async () => {
    const target = await resources();
    await service.updateTemplate(context(), target.template.id, { ...fields(), tagIds: [target.tag.id], revision: 1 });
    await expect(service.deleteTag(context(), target.tag.id, { revision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, target.template.id)));
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining(['schedule.template.created', 'schedule.template.updated']));
    expect(audits.every((audit) => audit.occurredAt.getTime() === clock.now().getTime())).toBe(true);
  });
});
describe('materialization job against PostgreSQL', () => {
  it('materializes on create, serializes concurrent retries, snapshots mappings, preserves overrides and extends the horizon', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { timezone: 'America/New_York' });
    const p1 = await factory('programs', gymId), p2 = await factory('programs', gymId), tag = await factory('classTags', gymId);
    const template = await service.createTemplate(context(gymId), { ...fields(), programIds: [p1.id, p2.id], tagIds: [tag.id], coachId: null });
    expect(await database.forGym(gymId, (tx) => tx.select().from(classSessions))).toHaveLength(8);
    const counts = await Promise.all([service.materialize(gymId, 'America/New_York'), service.materialize(gymId, 'America/New_York')]);
    expect(counts).toEqual([0, 0]);
    let sessions = await database.forGym(gymId, (tx) => tx.select().from(classSessions));
    expect(sessions).toHaveLength(8);
    const [first] = sessions.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    expect(first!.startsAt.toISOString()).toBe('2026-03-01T23:00:00.000Z');
    expect(sessions[1]!.startsAt.toISOString()).toBe('2026-03-08T22:00:00.000Z');
    await service.changeSession(context(gymId), first!.id, 'cancel', { revision: 1 });
    await service.changeSession(context(gymId), first!.id, 'notes', { revision: 2, notes: 'Keep this override' });
    await service.updateTemplate(context(gymId), template.id, { ...fields(), localStartTime: '19:00', notes: 'New template notes', coachId: null, programIds: [p1.id], tagIds: [], revision: 1 });
    expect(await service.materialize(gymId, 'America/New_York')).toBe(0);
    expect(await service.getSession(gymId, first!.id)).toMatchObject({ status: 'cancelled', notes: 'Keep this override', programIds: [p1.id, p2.id].sort(), tagIds: [tag.id] });
    expect(await database.forGym(gymId, (tx) => tx.select().from(classSessionPrograms))).toHaveLength(16);
    expect(await database.forGym(gymId, (tx) => tx.select().from(classSessionTags))).toHaveLength(8);
    expect(await service.materialize(gymId, 'America/New_York', new TestClock('2026-03-08T00:00:00Z'))).toBe(1);
    sessions = await database.forGym(gymId, (tx) => tx.select().from(classSessions));
    expect(sessions).toHaveLength(9);
    const materialized = await database.forGym(gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.session.materialized')));
    expect(materialized).toHaveLength(9);
  });
  it('does not duplicate today after its original time has passed and the template moves later', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const program = await factory('programs', gymId);
    const template = await service.createTemplate(context(gymId), { ...fields(), programIds: [program.id], coachId: null });
    await service.materialize(gymId, 'America/New_York');
    await service.updateTemplate(context(gymId), template.id, { ...fields(), programIds: [program.id], coachId: null, localStartTime: '20:00', revision: 1 });
    expect(await service.materialize(gymId, 'America/New_York', new TestClock('2026-03-02T00:00:00Z'))).toBe(0);
    expect(await database.forGym(gymId, (tx) => tx.select().from(classSessions))).toHaveLength(8);
  });
  it('uses each job gym, timezone and clock rather than payload IDs', async () => {
    const worker = new FakeJobs(clock), calls: unknown[][] = [];
    const fake = { ...service, async materialize(...args: Parameters<typeof service.materialize>) { calls.push(args); return 0; } };
    createServerRegistry({ jobs: createScheduleJobs(fake) }).registerJobs(worker, new Set());
    expect(worker.schedules.get('schedule.materialize')).toBe('0 0 * * *');
    await worker.triggerSchedule('schedule.materialize', [{ gymId: gymA, timezone: 'America/New_York' }, { gymId: gymB, timezone: 'Asia/Tokyo' }], 'today');
    await worker.runNext(); await worker.runNext();
    expect(calls).toEqual([[gymA, 'America/New_York', clock], [gymB, 'Asia/Tokyo', clock]]);
  });
});
describe('moving generated sessions', () => {
  const zone = 'America/New_York';
  // The previous release left a new template's sessions to the nightly job.
  const asPreviousRelease = (gymId: string) => database.forGym(gymId, async (tx) => {
    await tx.delete(classSessionPrograms); await tx.delete(classSessionTags); await tx.delete(classSessions);
  });
  async function generated() {
    const gymId = uuidv7(); await factory('gyms', gymId, { timezone: zone });
    const program = await factory('programs', gymId);
    const template = await service.createTemplate(context(gymId), { ...fields(), programIds: [program.id], coachId: null });
    await service.materialize(gymId, zone);
    const sessions = () => database.forGym(gymId, (tx) => tx.select().from(classSessions).orderBy(asc(classSessions.startsAt)));
    return { gymId, program, template, sessions };
  }
  const move = (target: { gymId: string; program: { id: string } }, session: { id: string; revision: number }, startsAt: string, endsAt: string) =>
    service.updateSession(context(target.gymId), session.id, { ...sessionFields(), coachId: null, programIds: [target.program.id], startsAt, endsAt, revision: session.revision });
  it('keeps the moved session, its bookings and attendance, and never recreates it at the original time', async () => {
    const target = await generated(), [first] = await target.sessions();
    const member = await factory('members', target.gymId), user = await factory('authUser', target.gymId);
    const booking = await factory('classBookings', target.gymId, { memberId: member.id, sessionId: first!.id, bookedBy: user.id });
    const visit = await factory('attendances', target.gymId, { memberId: member.id, sessionId: first!.id });
    // Sunday 18:00 moves to Tuesday 19:30 local time.
    const moved = await move(target, first!, '2026-03-04T00:30:00Z', '2026-03-04T01:30:00Z');
    expect(moved).toMatchObject({ id: first!.id, templateId: target.template.id, startsAt: '2026-03-04T00:30:00.000Z', endsAt: '2026-03-04T01:30:00.000Z', revision: first!.revision + 1 });
    await expect(move(target, first!, '2026-03-04T01:00:00Z', '2026-03-04T02:00:00Z')).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await service.materialize(target.gymId, zone)).toBe(0);
    expect(await service.materialize(target.gymId, zone, new TestClock('2026-03-08T00:00:00Z'))).toBe(1);
    const sessions = await target.sessions();
    expect(sessions).toHaveLength(9);
    expect(sessions.filter((session) => session.startsAt.toISOString() === '2026-03-01T23:00:00.000Z')).toEqual([]);
    expect(sessions[0]).toMatchObject({ id: first!.id, startsAt: new Date('2026-03-04T00:30:00Z'), occurrenceStartsAt: new Date('2026-03-01T23:00:00Z') });
    expect(await database.forGym(target.gymId, (tx) => tx.select().from(classBookings))).toEqual([booking]);
    expect(await database.forGym(target.gymId, (tx) => tx.select().from(attendances))).toEqual([visit]);
    const [audit] = await database.forGym(target.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.session.updated')));
    expect(audit).toMatchObject({ targetId: first!.id, before: expect.objectContaining({ startsAt: '2026-03-01T23:00:00.000Z' }), after: expect.objectContaining({ startsAt: '2026-03-04T00:30:00.000Z' }) });
  });
  it('rejects a move onto another occurrence and skips an unmaterialized occurrence a session was moved onto', async () => {
    const target = await generated(), sessions = await target.sessions();
    await expect(move(target, sessions[0]!, sessions[1]!.startsAt.toISOString(), sessions[1]!.endsAt.toISOString())).rejects.toMatchObject({ code: 'conflict' });
    // The last Sunday moves one week later, onto an occurrence beyond the current horizon.
    const last = sessions.at(-1)!, later = (date: Date) => new Date(date.getTime() + 604_800_000).toISOString();
    await move(target, last, later(last.startsAt), later(last.endsAt));
    expect(await service.materialize(target.gymId, zone, new TestClock('2026-03-08T00:00:00Z'))).toBe(0);
    expect(await target.sessions()).toHaveLength(8);
  });
  it('keys occurrences in local time across a DST change and a template time change', async () => {
    const target = await generated(), sessions = await target.sessions();
    expect(sessions.every((session) => session.occurrenceStartsAt?.getTime() === session.startsAt.getTime())).toBe(true);
    // March 8 is the first Sunday on daylight time: 18:00 local is 22:00Z. Move it to 19:00 local.
    const dst = sessions[1]!;
    expect(dst.startsAt.toISOString()).toBe('2026-03-08T22:00:00.000Z');
    await move(target, dst, '2026-03-08T23:00:00Z', '2026-03-09T00:00:00Z');
    await service.updateTemplate(context(target.gymId), target.template.id, { ...fields(), programIds: [target.program.id], coachId: null, localStartTime: '17:00', revision: target.template.revision });
    expect(await service.materialize(target.gymId, zone, new TestClock('2026-03-08T00:00:00Z'))).toBe(1);
    const after = await target.sessions();
    expect(after.map((session) => [session.startsAt.toISOString(), session.occurrenceStartsAt?.toISOString()])).toEqual([
      ['2026-03-01T23:00:00.000Z', '2026-03-01T23:00:00.000Z'], ['2026-03-08T23:00:00.000Z', '2026-03-08T22:00:00.000Z'],
      ...['03-15', '03-22', '03-29', '04-05', '04-12', '04-19'].map((day) => Array(2).fill('2026-' + day + 'T22:00:00.000Z')),
      ['2026-04-26T21:00:00.000Z', '2026-04-26T21:00:00.000Z'],
    ]);
  });
  it('accepts inserts from the previous release\'s materializer and never duplicates them', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const program = await factory('programs', gymId);
    const template = await service.createTemplate(context(gymId), { ...fields(), programIds: [program.id], coachId: null });
    await asPreviousRelease(gymId);
    const legacy = () => database.forGym(gymId, (tx) => tx.insert(classSessions).values({ gymId, templateId: template.id, name: template.name,
      startsAt: new Date('2026-03-01T23:00:00Z'), endsAt: new Date('2026-03-02T00:00:00Z'), createdAt: clock.now() })
      .onConflictDoNothing({ target: [classSessions.gymId, classSessions.templateId, classSessions.startsAt] }).returning());
    expect(await legacy()).toHaveLength(1);
    expect(await service.materialize(gymId, zone)).toBe(7);
    expect(await legacy()).toEqual([]);
    expect(await database.forGym(gymId, (tx) => tx.select().from(classSessions))).toHaveLength(8);
  });
  it('keys a session the previous release generated when it is moved, so its original date is not regenerated', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { timezone: zone });
    const program = await factory('programs', gymId);
    const template = await service.createTemplate(context(gymId), { ...fields(), programIds: [program.id], coachId: null });
    await asPreviousRelease(gymId);
    const [legacy] = await database.forGym(gymId, async (tx) => {
      const rows = await tx.insert(classSessions).values({ gymId, templateId: template.id, name: template.name,
        startsAt: new Date('2026-03-01T23:00:00Z'), endsAt: new Date('2026-03-02T00:00:00Z'), createdAt: clock.now() }).returning();
      await tx.insert(classSessionPrograms).values({ gymId, sessionId: rows[0]!.id, programId: program.id, createdAt: clock.now() });
      return rows;
    });
    expect(await service.materialize(gymId, zone)).toBe(7);
    await move({ gymId, program }, legacy!, '2026-03-04T00:30:00Z', '2026-03-04T01:30:00Z');
    expect(await service.materialize(gymId, zone)).toBe(0);
    const sessions = await database.forGym(gymId, (tx) => tx.select().from(classSessions));
    expect(sessions).toHaveLength(8);
    expect(sessions.find((session) => session.id === legacy!.id)).toMatchObject({ startsAt: new Date('2026-03-04T00:30:00Z'), occurrenceStartsAt: new Date('2026-03-01T23:00:00Z') });
  });
  it('returns 404 when moving another gym\'s generated session and leaves it unchanged', async () => {
    const own = await generated(), foreign = await generated(), [session] = await foreign.sessions();
    const response = await request(server('owner', own.gymId), 'PUT', '/api/schedule/sessions/' + session!.id,
      { ...sessionFields(), coachId: null, programIds: [own.program.id], startsAt: '2026-03-04T00:30:00Z', endsAt: '2026-03-04T01:30:00Z', revision: session!.revision });
    expect(response.status).toBe(404);
    expect((await foreign.sessions())[0]).toEqual(session);
  });
});
