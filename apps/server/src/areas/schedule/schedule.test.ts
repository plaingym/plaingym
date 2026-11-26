// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { auditEvents, attendances, classBookings, classSessions, classTemplates, classSessionPrograms, classSessionTags, members, uuidv7, RevisionConflictError } from '@plaingym/db';
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
import * as settings from '../settings/settings.js';
import type { CancellationNotice } from '../announcements/cancellation.js';
import type { RestoreNotice } from '../announcements/restored.js';

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
describe('stored schedule snapshots and response cutoffs', () => {
  it('reads booking rules once for a multi-session list', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { cancellationCutoffMinutes: 90 });
    const program = await factory('programs', gymId);
    for (let n = 0; n < 3; n++) {
      const session = await factory('classSessions', gymId, {
        startsAt: new Date('2026-03-02T18:00:00Z'), endsAt: new Date('2026-03-02T19:00:00Z'),
      });
      await factory('classSessionPrograms', gymId, { sessionId: session.id, programId: program.id });
    }
    const read = vi.spyOn(settings, 'readBookingRules');
    try {
      const result = await service.listSessions(gymId, { from: '2026-03-01T00:00:00Z', until: '2026-03-03T00:00:00Z', limit: 100, offset: 0 });
      expect(result.data).toHaveLength(3);
      expect(result.data.every(row => row.cancelBefore === '2026-03-02T16:30:00.000Z')).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });
  it('keeps derived cutoffs out of creation, update, cancellation, materialization and detachment audits', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { cancellationCutoffMinutes: 60 });
    const program = await factory('programs', gymId);
    const template = await service.createTemplate(context(gymId), { ...fields(), coachId: null, programIds: [program.id] });
    const session = await service.createSession(context(gymId), { ...sessionFields(), coachId: null, programIds: [program.id] });
    await settings.createSettingsService({ scope: database.forGym, clock }).update(context(gymId), 'booking', { revision: 1, bookingWindowDays: 7, cancellationCutoffMinutes: 90 });
    const updated = await service.updateSession(context(gymId), session.id, { ...sessionFields(), coachId: null, programIds: [program.id], revision: session.revision, notes: 'Updated' });
    const notes = await service.changeSession(context(gymId), session.id, 'notes', { revision: updated.revision, notes: 'Another note' });
    const cancelled = await service.changeSession(context(gymId), session.id, 'cancel', { revision: notes.revision });
    await service.deleteTemplate(context(gymId), template.id, { revision: template.revision });
    expect(session.cancelBefore).toBe('2026-03-02T17:00:00.000Z');
    expect(updated.cancelBefore).toBe('2026-03-02T16:30:00.000Z');
    expect(cancelled.cancelBefore).toBe(updated.cancelBefore);
    const audits = (await database.forGym(gymId, tx => tx.select().from(auditEvents))).filter(row => row.action.startsWith('schedule.session.'));
    expect(audits.map(row => row.action)).toEqual(expect.arrayContaining([
      'schedule.session.created', 'schedule.session.updated', 'schedule.session.notes', 'schedule.session.cancel',
      'schedule.session.materialized', 'schedule.session.template_removed',
    ]));
    for (const audit of audits) for (const snapshot of [audit.before, audit.after]) {
      if (snapshot !== null) expect(snapshot).not.toHaveProperty('cancelBefore');
    }
  });
});
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
  // Restoring needs a cancelled session: the caller cancels it first, which takes revision 2.
  else if (name === 'restoreSession') body = { revision: 2 };
  return { path: scheduleContracts[name].path.replace('{id}', id) + (name === 'listSessions' ? '?from=2026-01-01T00:00:00Z&until=2027-01-01T00:00:00Z' : ''), body };
}
describe('schedule routes and tenant isolation', () => {
  it.each(staffRoles)('projects the configured cancellation cutoff in list and detail responses for %s', async role => {
    const gymId = uuidv7(); await factory('gyms', gymId, { cancellationCutoffMinutes: 45 });
    const program = await factory('programs', gymId);
    const session = await factory('classSessions', gymId, { startsAt: new Date('2026-03-02T18:00:00Z'), endsAt: new Date('2026-03-02T19:00:00Z') });
    await factory('classSessionPrograms', gymId, { sessionId: session.id, programId: program.id });
    const app = server(role, gymId);
    const detail = await app.request(`/api/schedule/sessions/${session.id}`);
    expect(detail.status).toBe(200);
    expect(scheduleContracts.getSession.response.parse(await detail.json()).data.cancelBefore).toBe('2026-03-02T17:15:00.000Z');
    const list = await app.request('/api/schedule/sessions?from=2026-03-02T00:00:00Z&until=2026-03-03T00:00:00Z');
    expect(list.status).toBe(200);
    expect(scheduleContracts.listSessions.response.parse(await list.json()).data).toMatchObject([{ id: session.id, cancelBefore: '2026-03-02T17:15:00.000Z' }]);
  });
  it.each(staffRoles)('checks every endpoint with valid requests for %s', async (role) => {
    const app = server(role);
    for (const name of Object.keys(scheduleContracts) as RouteName[]) {
      const target = await resources(), contract = scheduleContracts[name], value = input(name, target);
      if (name === 'restoreSession') await service.changeSession(context(), target.session.id, 'cancel', { revision: 1 });
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
    expect(await responses.find((response) => response.status === 409)!.json()).toMatchObject({ error: { code: 'conflict' } });
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
    await expect(move(target, sessions[0]!, sessions[1]!.startsAt.toISOString(), sessions[1]!.endsAt.toISOString())).rejects.toMatchObject({ code: 'session_start_taken', status: 409 });
    const response = await request(server('owner', target.gymId), 'PUT', '/api/schedule/sessions/' + sessions[0]!.id, {
      ...sessionFields(), coachId: null, programIds: [target.program.id], revision: sessions[0]!.revision,
      startsAt: sessions[1]!.startsAt.toISOString(), endsAt: sessions[1]!.endsAt.toISOString(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'session_start_taken' } });
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
describe('restoring a cancelled session', () => {
  type Name = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  type Booking = typeof classBookings.$inferSelect;
  /** Capacity 3: A, B and C booked in that order, D and E waitlisted in that order, F cancelled their own place earlier. */
  async function roster(options: { capacity?: number | null; cutoffMinutes?: number; role?: StaffRole; coached?: boolean } = {}) {
    const gymId = uuidv7(), at = new TestClock('2026-03-01T00:00:00Z');
    await factory('gyms', gymId, { timezone: 'America/New_York',
      ...(options.cutoffMinutes === undefined ? {} : { cancellationCutoffMinutes: options.cutoffMinutes }) });
    const user = await factory('authUser', gymId);
    await factory('staffRoles', gymId, { userId: user.id, role: options.role ?? 'owner' });
    const coach = await factory('staffProfiles', gymId, { userId: options.coached ? user.id : null });
    const session = await factory('classSessions', gymId, { name: 'Restore test', coachId: coach.id,
      capacity: options.capacity === undefined ? 3 : options.capacity, startsAt: new Date('2026-03-02T18:00:00Z'), endsAt: new Date('2026-03-02T19:00:00Z') });
    await factory('classSessionPrograms', gymId, { sessionId: session.id });
    const ids = {} as Record<Name, string>;
    // Created out of order, so the restored order can only come from booking times and the old waitlist positions.
    for (const [name, status, minute, waitlistPosition] of [['C', 'booked', 3, null], ['A', 'booked', 1, null], ['B', 'booked', 2, null],
      ['E', 'waitlisted', 5, 2], ['D', 'waitlisted', 4, 1], ['F', 'cancelled', 0, null]] as const) {
      const member = await factory('members', gymId, { firstName: name });
      ids[name] = member.id;
      await factory('classBookings', gymId, { sessionId: session.id, memberId: member.id, bookedBy: user.id, status, waitlistPosition,
        createdAt: new Date(Date.UTC(2026, 1, 20, 12, minute)), cancelledAt: status === 'cancelled' ? new Date('2026-02-25T00:00:00Z') : null });
    }
    const enqueue = vi.fn<RestoreNotice['enqueue']>(async () => {}), cancelEnqueue = vi.fn<CancellationNotice['enqueue']>(async () => {});
    const service = createScheduleService({ scope: database.forGym, clock: at, restore: { enqueue }, cancellation: { enqueue: cancelEnqueue } });
    const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
    const names = new Map(Object.entries(ids).map(([name, id]) => [id, name as Name]));
    const bookings = async () => Object.fromEntries((await database.forGym(gymId, tx => tx.select().from(classBookings)
      .where(eq(classBookings.sessionId, session.id)))).map(row => [names.get(row.memberId)!, row])) as Record<Name, Booking>;
    const waitlist = (rows: Record<Name, Booking>) => Object.entries(rows).filter(([, row]) => row.status === 'waitlisted')
      .sort(([, a], [, b]) => a.waitlistPosition! - b.waitlistPosition!).map(([name]) => name);
    const booked = (rows: Record<Name, Booking>) => Object.entries(rows).filter(([, row]) => row.status === 'booked').map(([name]) => name).sort();
    const audits = (action: string) => database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
    const current = async () => (await database.forGym(gymId, tx => tx.select().from(classSessions).where(eq(classSessions.id, session.id))))[0]!;
    const cancel = async (notify = false) => service.changeSession(actor, session.id, 'cancel', { revision: (await current()).revision, ...(notify ? { notify } : {}) });
    const restore = async ({ revision, ...input }: { revision?: number; notify?: boolean; channels?: ('email' | 'sms')[] } = {}) =>
      service.restoreSession(actor, session.id, { revision: revision ?? (await current()).revision, ...input });
    const snapshot = () => database.forGym(gymId, async tx => ({ sessions: await tx.select().from(classSessions),
      bookings: await tx.select().from(classBookings).orderBy(asc(classBookings.id)), audits: await tx.$count(auditEvents) }));
    return { gymId, at, user, session, ids, enqueue, cancelEnqueue, service, actor, bookings, waitlist, booked, audits, current, cancel, restore, snapshot };
  }
  it('marks the places a cancellation cancels and brings them back in order, leaving earlier cancellations alone', async () => {
    const f = await roster();
    await f.cancel();
    const marked = await f.bookings();
    for (const name of ['A', 'B', 'C'] as const)
      expect(marked[name]).toMatchObject({ status: 'cancelled', waitlistPosition: null, sessionCancelStatus: 'booked', sessionCancelPosition: null });
    expect(marked.D).toMatchObject({ status: 'cancelled', waitlistPosition: null, sessionCancelStatus: 'waitlisted', sessionCancelPosition: 1 });
    expect(marked.E).toMatchObject({ status: 'cancelled', waitlistPosition: null, sessionCancelStatus: 'waitlisted', sessionCancelPosition: 2 });
    expect(marked.F).toMatchObject({ status: 'cancelled', cancelledAt: new Date('2026-02-25T00:00:00Z'), sessionCancelStatus: null });
    expect(await f.audits('booking.cancelled')).toHaveLength(5);
    expect(await f.restore()).toMatchObject({ id: f.session.id, status: 'scheduled', revision: 3, restoredBookings: 5 });
    const rows = await f.bookings();
    expect(f.booked(rows)).toEqual(['A', 'B', 'C']); expect(f.waitlist(rows)).toEqual(['D', 'E']);
    for (const name of ['A', 'B', 'C', 'D', 'E'] as const)
      expect(rows[name]).toMatchObject({ cancelledAt: null, sessionCancelStatus: null, sessionCancelPosition: null });
    expect(rows.F).toMatchObject({ status: 'cancelled', cancelledAt: new Date('2026-02-25T00:00:00Z'), sessionCancelStatus: null });
    const restored = await f.audits('booking.restored');
    expect(restored.map(audit => (audit.after as { memberId: string }).memberId).sort()).toEqual(['A', 'B', 'C', 'D', 'E'].map(name => f.ids[name as Name]).sort());
    expect(await f.audits('schedule.session.restored')).toMatchObject([{ targetId: f.session.id, before: { status: 'cancelled' }, after: { status: 'scheduled' } }]);
    expect((await f.current()).restoreCount).toBe(1);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    ['lowered to 2', 2, false, ['A', 'B'], ['C', 'D', 'E'], 0],
    ['raised to 5', 5, false, ['A', 'B', 'C', 'D', 'E'], [], 2],
    ['cleared', null, false, ['A', 'B', 'C', 'D', 'E'], [], 2],
    ['raised to 5 after the cancellation cutoff', 5, true, ['A', 'B', 'C'], ['D', 'E'], 0],
  ] as const)('fills places by the capacity %s while cancelled, then promotes as a capacity change does', async (_change, capacity, late, booked, waitlisted, promoted) => {
    const f = await roster({ cutoffMinutes: 120 });
    await f.cancel();
    await f.service.changeSession(f.actor, f.session.id, 'capacity', { revision: (await f.current()).revision, capacity });
    if (late) f.at.set(new Date('2026-03-02T17:00:00Z'));
    await f.restore();
    const rows = await f.bookings();
    expect(f.booked(rows)).toEqual(booked); expect(f.waitlist(rows)).toEqual(waitlisted);
    expect(await f.audits('booking.restored')).toHaveLength(5);
    expect(await f.audits('booking.promoted')).toHaveLength(promoted);
  });
  it('leaves an erased member cancelled and spends their marker', async () => {
    const f = await roster();
    await f.cancel();
    await database.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.at.now() }).where(eq(members.id, f.ids.B)));
    await f.restore({ notify: true, channels: ['email'] });
    const rows = await f.bookings();
    expect(rows.B).toMatchObject({ status: 'cancelled', sessionCancelStatus: null, sessionCancelPosition: null });
    // B's place is free, so the first of the old waitlist is promoted into it.
    expect(f.booked(rows)).toEqual(['A', 'C', 'D']); expect(f.waitlist(rows)).toEqual(['E']);
    expect(await f.audits('booking.restored')).toHaveLength(4);
    expect(f.enqueue.mock.calls[0]![1]).toEqual({ sessionId: f.session.id, memberIds: ['A', 'C', 'D', 'E'].map(name => f.ids[name as Name]).sort(),
      channels: ['email'], round: 1 });
  });
  it('restores an empty cancelled session with no booking change and no notice, even when asked to notify', async () => {
    const f = await roster();
    const empty = await factory('classSessions', f.gymId, { status: 'cancelled', startsAt: new Date('2026-03-02T18:00:00Z'), endsAt: new Date('2026-03-02T19:00:00Z') });
    await factory('classSessionPrograms', f.gymId, { sessionId: empty.id });
    const before = await f.bookings();
    expect(await f.service.restoreSession(f.actor, empty.id, { revision: empty.revision, notify: true })).toMatchObject({ status: 'scheduled', restoredBookings: 0 });
    expect(await f.bookings()).toEqual(before);
    expect(await f.audits('booking.restored')).toHaveLength(0);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('reports how many marked bookings came back, and 0 when none carried a cancellation marker', async () => {
    const two = await roster();
    await two.cancel();
    await database.forGym(two.gymId, tx => tx.update(classBookings).set({ sessionCancelStatus: null, sessionCancelPosition: null })
      .where(and(eq(classBookings.sessionId, two.session.id), inArray(classBookings.memberId, [two.ids.C, two.ids.D, two.ids.E]))));
    expect(await two.restore()).toMatchObject({ status: 'scheduled', restoredBookings: 2 });
    const unmarked = await roster();
    await unmarked.cancel();
    await database.forGym(unmarked.gymId, tx => tx.update(classBookings).set({ sessionCancelStatus: null, sessionCancelPosition: null })
      .where(eq(classBookings.sessionId, unmarked.session.id)));
    expect(await unmarked.restore({ notify: true })).toMatchObject({ status: 'scheduled', restoredBookings: 0 });
    expect(Object.values(await unmarked.bookings()).every(row => row.status === 'cancelled')).toBe(true);
    expect(await unmarked.audits('booking.restored')).toHaveLength(0);
    expect(unmarked.enqueue).not.toHaveBeenCalled();
  });
  it('queues one notice for every restored member, by both channels unless staff chose one', async () => {
    const f = await roster();
    await f.cancel();
    await f.restore({ notify: true });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0]![1]).toEqual({ sessionId: f.session.id,
      memberIds: ['A', 'B', 'C', 'D', 'E'].map(name => f.ids[name as Name]).sort(), channels: ['email', 'sms'], round: 1 });
    expect(f.enqueue.mock.calls[0]![2]).toBe('America/New_York');
    await f.cancel(); await f.restore({ notify: true, channels: ['sms'] });
    expect(f.enqueue.mock.calls[1]![1]).toMatchObject({ channels: ['sms'], round: 2 });
  });
  it('brings back only the places active before the latest cancellation, and scopes a later cancellation notice by the restore count', async () => {
    const f = await roster();
    await f.cancel(true);
    expect(f.cancelEnqueue.mock.calls[0]![1]).not.toHaveProperty('round');
    await f.restore();
    // A cancels their own restored place; the session is then cancelled and restored again.
    await database.forGym(f.gymId, tx => tx.update(classBookings).set({ status: 'cancelled', cancelledAt: f.at.now() })
      .where(and(eq(classBookings.sessionId, f.session.id), eq(classBookings.memberId, f.ids.A))));
    await f.cancel(true);
    expect(f.cancelEnqueue.mock.calls[1]![1]).toMatchObject({ round: 1 });
    expect(f.cancelEnqueue.mock.calls[1]![1].memberIds).toEqual(['B', 'C', 'D', 'E'].map(name => f.ids[name as Name]).sort());
    await f.restore();
    const rows = await f.bookings();
    expect(rows.A).toMatchObject({ status: 'cancelled', sessionCancelStatus: null });
    expect(f.booked(rows)).toEqual(['B', 'C', 'D']); expect(f.waitlist(rows)).toEqual(['E']);
    expect(await f.audits('booking.restored')).toHaveLength(9);
    expect((await f.current()).restoreCount).toBe(2);
  });
  it('refuses a scheduled session, a stale revision and a started session without changing anything', async () => {
    const f = await roster();
    let before = await f.snapshot();
    await expect(f.restore()).rejects.toMatchObject({ code: 'conflict', details: { reason: ['not_cancelled'] },
      message: 'This session isn\'t cancelled any more. No notice was queued.' });
    expect(await f.snapshot()).toEqual(before);
    await f.cancel(); before = await f.snapshot();
    await expect(f.restore({ revision: 1 })).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await f.snapshot()).toEqual(before);
    for (const instant of ['2026-03-02T18:00:00Z', '2026-03-02T20:00:00Z']) {
      f.at.set(new Date(instant));
      await expect(f.restore({ notify: true })).rejects.toMatchObject({ code: 'conflict', details: { reason: ['session_started'] },
        message: 'This session has started and can\'t be restored.' });
      expect(await f.snapshot()).toEqual(before);
    }
    await expect(f.restore({ channels: ['email'] })).rejects.toMatchObject({ code: 'invalid_request', details: { reason: ['channels_without_notify'] } });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('lets only one of two concurrent restores succeed, without duplicating a booking', async () => {
    const f = await roster();
    await f.cancel();
    const revision = (await f.current()).revision;
    const results = await Promise.allSettled([f.restore({ revision }), f.restore({ revision })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const reason: unknown = results.find(result => result.status === 'rejected')!.reason;
    expect(reason instanceof RevisionConflictError || (reason as { details?: { reason?: string[] } }).details?.reason?.[0] === 'not_cancelled').toBe(true);
    const rows = await f.bookings();
    expect(f.booked(rows)).toEqual(['A', 'B', 'C']); expect(f.waitlist(rows)).toEqual(['D', 'E']);
    expect(await f.audits('booking.restored')).toHaveLength(5);
    expect(await f.audits('schedule.session.restored')).toHaveLength(1);
  });
  it('lets a coach restore any session, but notify only the members of their own', async () => {
    const other = await roster({ role: 'coach' });
    await other.cancel();
    await expect(other.restore({ notify: true })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await other.current()).status).toBe('cancelled');
    expect(await other.restore()).toMatchObject({ status: 'scheduled' });
    const own = await roster({ role: 'coach', coached: true });
    await own.cancel();
    expect(await own.restore({ notify: true })).toMatchObject({ status: 'scheduled' });
    expect(own.enqueue).toHaveBeenCalledTimes(1);
  });
  it('denies front desk, refuses notify-only channels, and hides another gym\'s session through the route', async () => {
    const { session } = await resources();
    await service.changeSession(context(), session.id, 'cancel', { revision: 1 });
    const path = `/api/schedule/sessions/${session.id}/restore`;
    expect((await request(server('front_desk'), 'POST', path, { revision: 2 })).status).toBe(403);
    expect((await request(server('owner', gymB), 'POST', path, { revision: 2 })).status).toBe(404);
    expect((await request(server(), 'POST', path, { revision: 2, channels: ['email'] })).status).toBe(400);
    expect((await service.getSession(gymA, session.id))).toMatchObject({ status: 'cancelled', revision: 2 });
    const restored = await request(server('coach'), 'POST', path, { revision: 2 });
    expect(restored.status).toBe(200);
    expect(scheduleContracts.restoreSession.response.parse(await restored.json())).toMatchObject({ data: { status: 'scheduled', revision: 3 }, restoredBookings: 0 });
  });
});
describe('template capacity edits on upcoming sessions', () => {
  const zone = 'America/New_York';
  async function weekly(capacity: number | null = null) {
    const gymId = uuidv7(), at = new TestClock('2026-03-01T00:00:00Z');
    await factory('gyms', gymId, { timezone: zone });
    const program = await factory('programs', gymId), user = await factory('authUser', gymId);
    const own = createScheduleService({ scope: database.forGym, clock: at });
    const body = { ...fields(), coachId: null, capacity, programIds: [program.id] };
    const template = await own.createTemplate(context(gymId), body);
    const sessions = () => database.forGym(gymId, tx => tx.select().from(classSessions).orderBy(asc(classSessions.startsAt), asc(classSessions.id)));
    const audits = (action: string) => database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
    const edit = async (change: Partial<CreateClassTemplateRequest>) => {
      const [current] = (await own.listTemplates(gymId, { limit: 100, offset: 0 })).data.filter(row => row.id === template.id);
      return own.updateTemplate(context(gymId), template.id, { ...body, ...change, revision: current!.revision });
    };
    return { gymId, at, program, user, own, body, template, sessions, audits, edit };
  }
  it('gives every upcoming scheduled session that held the old capacity the new one, with one capacity audit each', async () => {
    const f = await weekly();
    const generated = (await f.sessions()).filter(row => row.templateId === f.template.id);
    expect(generated.length).toBeGreaterThan(4);
    expect(generated.every(row => row.capacity === null)).toBe(true);
    const updated = await f.edit({ capacity: 10 });
    expect(updated.capacity).toBe(10);
    const after = new Map((await f.sessions()).map(row => [row.id, row]));
    for (const row of generated) expect(after.get(row.id)).toMatchObject({ capacity: 10, revision: row.revision + 1 });
    const capacityAudits = await f.audits('schedule.session.capacity');
    expect(capacityAudits.map(audit => audit.targetId).sort()).toEqual(generated.map(row => row.id).sort());
    for (const audit of capacityAudits) {
      expect(audit.before).toMatchObject({ id: audit.targetId, capacity: null });
      expect(audit.after).toMatchObject({ id: audit.targetId, capacity: 10 });
      expect(audit.after).not.toHaveProperty('cancelBefore');
    }
  });
  it('keeps a session\'s own capacity, started sessions, another template\'s sessions and detached sessions, while updating cancelled ones at the old capacity', async () => {
    const f = await weekly();
    const other = await f.own.createTemplate(context(f.gymId), { ...f.body, name: 'Other class', weekday: 2 });
    const detached = await f.own.createSession(context(f.gymId), { ...sessionFields(), coachId: null, programIds: [f.program.id], startsAt: '2026-03-10T18:00:00Z', endsAt: '2026-03-10T19:00:00Z' });
    const [started, overridden, cancelled, ...rest] = (await f.sessions()).filter(row => row.templateId === f.template.id);
    await f.own.changeSession(context(f.gymId), overridden!.id, 'capacity', { revision: overridden!.revision, capacity: 6 });
    await f.own.changeSession(context(f.gymId), cancelled!.id, 'cancel', { revision: cancelled!.revision });
    // The first session began at 23:00 UTC on the first of March, an hour before this.
    f.at.set('2026-03-02T00:00:00Z');
    const before = new Map((await f.sessions()).map(row => [row.id, row]));
    await f.edit({ capacity: 10 });
    const after = new Map((await f.sessions()).map(row => [row.id, row]));
    expect(after.get(started!.id)).toMatchObject({ capacity: null, revision: before.get(started!.id)!.revision });
    expect(after.get(overridden!.id)).toMatchObject({ capacity: 6, revision: before.get(overridden!.id)!.revision });
    expect(after.get(cancelled!.id)).toMatchObject({ status: 'cancelled', capacity: 10, revision: before.get(cancelled!.id)!.revision + 1 });
    expect(after.get(detached.id)).toMatchObject({ templateId: null, capacity: null, revision: before.get(detached.id)!.revision });
    for (const row of before.values()) if (row.templateId === other.id) expect(after.get(row.id)).toMatchObject({ capacity: null, revision: row.revision });
    for (const row of rest) expect(after.get(row.id)).toMatchObject({ capacity: 10 });
    const targets = (await f.audits('schedule.session.capacity')).filter(audit => (audit.after as { capacity: number }).capacity === 10).map(audit => audit.targetId);
    expect(targets.sort()).toEqual([cancelled!, ...rest].map(row => row.id).sort());
  });
  it('updates cancelled sessions at the old capacity without touching cancelled bookings so restore rebooks up to the new capacity', async () => {
    const f = await weekly(10);
    const upcoming = (await f.sessions()).filter(row => row.templateId === f.template.id);
    expect(upcoming.length).toBeGreaterThanOrEqual(3);
    const cancelled = upcoming[1]!;
    for (let index = 0; index < 12; index++) {
      const member = await factory('members', f.gymId, { firstName: 'Member ' + index });
      await factory('classBookings', f.gymId, { sessionId: cancelled.id, memberId: member.id, bookedBy: f.user.id,
        status: index < 10 ? 'booked' : 'waitlisted', waitlistPosition: index < 10 ? null : index - 9,
        createdAt: new Date(Date.UTC(2026, 1, 20, 12, index)) });
    }
    await f.own.changeSession(context(f.gymId), cancelled.id, 'cancel', { revision: cancelled.revision });
    const bookingsBefore = await database.forGym(f.gymId, tx => tx.select().from(classBookings).where(eq(classBookings.sessionId, cancelled.id)).orderBy(asc(classBookings.id)));
    await f.edit({ capacity: 20 });
    const after = new Map((await f.sessions()).map(row => [row.id, row]));
    for (const row of upcoming) expect(after.get(row.id)).toMatchObject({ capacity: 20 });
    const cancelledAudits = (await f.audits('schedule.session.capacity')).filter(audit => audit.targetId === cancelled.id);
    expect(cancelledAudits).toHaveLength(1);
    expect(cancelledAudits[0]!.before).toMatchObject({ capacity: 10 });
    expect(cancelledAudits[0]!.after).toMatchObject({ capacity: 20 });
    const bookingsAfterEdit = await database.forGym(f.gymId, tx => tx.select().from(classBookings).where(eq(classBookings.sessionId, cancelled.id)).orderBy(asc(classBookings.id)));
    expect(bookingsAfterEdit).toEqual(bookingsBefore);
    await f.own.restoreSession(context(f.gymId), cancelled.id, { revision: after.get(cancelled.id)!.revision });
    const restoredBookings = await database.forGym(f.gymId, tx => tx.select().from(classBookings).where(eq(classBookings.sessionId, cancelled.id)));
    expect(restoredBookings.filter(row => row.status === 'booked')).toHaveLength(12);
    expect(restoredBookings.filter(row => row.status === 'waitlisted')).toHaveLength(0);
    await f.edit({ capacity: 25 });
    expect((await f.sessions()).find(row => row.id === cancelled.id)).toMatchObject({ capacity: 25 });
  });
  it('keeps a cancelled session\'s own capacity and started sessions when the class capacity changes', async () => {
    const f = await weekly(10);
    const [started, cancelled] = (await f.sessions()).filter(row => row.templateId === f.template.id);
    const overridden = await f.own.changeSession(context(f.gymId), cancelled!.id, 'capacity', { revision: cancelled!.revision, capacity: 8 });
    await f.own.changeSession(context(f.gymId), cancelled!.id, 'cancel', { revision: overridden.revision });
    f.at.set('2026-03-02T00:00:00Z');
    await f.edit({ capacity: 20 });
    const after = new Map((await f.sessions()).map(row => [row.id, row]));
    expect(after.get(cancelled!.id)).toMatchObject({ status: 'cancelled', capacity: 8 });
    expect(after.get(started!.id)).toMatchObject({ capacity: 10 });
  });
  async function booked() {
    const f = await weekly(5);
    // The second session is a week away, well before any cancellation cutoff.
    const session = (await f.sessions())[1]!;
    const memberIds: string[] = [];
    // Full at capacity 5 with two waiting, so one more place promotes exactly one member.
    for (const [index, status] of (['booked', 'booked', 'booked', 'booked', 'booked', 'waitlisted', 'waitlisted'] as const).entries()) {
      const member = await factory('members', f.gymId, { firstName: 'Member ' + index });
      memberIds.push(member.id);
      await factory('classBookings', f.gymId, { sessionId: session.id, memberId: member.id, bookedBy: f.user.id, status,
        waitlistPosition: status === 'waitlisted' ? index - 4 : null, createdAt: new Date(Date.UTC(2026, 1, 20, 12, index)) });
    }
    const bookings = () => database.forGym(f.gymId, tx => tx.select().from(classBookings).where(eq(classBookings.sessionId, session.id)).orderBy(asc(classBookings.id)));
    const snapshot = () => database.forGym(f.gymId, async tx => ({ templates: await tx.select().from(classTemplates).orderBy(asc(classTemplates.id)),
      sessions: await tx.select().from(classSessions).orderBy(asc(classSessions.id)), bookings: await tx.select().from(classBookings).orderBy(asc(classBookings.id)),
      audits: await tx.$count(auditEvents) }));
    return { ...f, session, memberIds, bookings, snapshot };
  }
  it('promotes the first waitlisted member when a raised template capacity opens a place', async () => {
    const f = await booked();
    await f.edit({ capacity: 6 });
    const rows = await f.bookings();
    const status = new Map(rows.map(row => [row.memberId, row.status]));
    expect(f.memberIds.map(id => status.get(id))).toEqual(['booked', 'booked', 'booked', 'booked', 'booked', 'booked', 'waitlisted']);
    const promoted = await f.audits('booking.promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.after).toMatchObject({ memberId: f.memberIds[5] });
    expect((await f.sessions()).find(row => row.id === f.session.id)).toMatchObject({ capacity: 6 });
  });
  it('refuses a template capacity below a session\'s booked count, naming the first blocking session, and changes nothing', async () => {
    const f = await booked();
    const otherSession = (await f.sessions())[2]!;
    for (let index = 0; index < 2; index++) {
      const member = await factory('members', f.gymId, { firstName: 'Other ' + index });
      await factory('classBookings', f.gymId, { sessionId: otherSession.id, memberId: member.id, bookedBy: f.user.id, status: 'booked' });
    }
    const before = await f.snapshot();
    await expect(f.edit({ capacity: 3 })).rejects.toMatchObject({ code: 'conflict',
      details: { reason: ['capacityBelowBooked'], startsAt: [f.session.startsAt.toISOString()] } });
    expect(await f.snapshot()).toEqual(before);
  });
  it('names the first by session ID when several sessions block the new capacity, not the earliest', async () => {
    const f = await booked();
    const otherSession = (await f.sessions())[2]!;
    for (let index = 0; index < 4; index++) {
      const member = await factory('members', f.gymId, { firstName: 'Other ' + index });
      await factory('classBookings', f.gymId, { sessionId: otherSession.id, memberId: member.id, bookedBy: f.user.id, status: 'booked' });
    }
    const [lower, higher] = [f.session, otherSession].sort((a, b) => a.id < b.id ? -1 : 1);
    // Move the lower ID past the other session, so ID order and date order disagree.
    const startsAt = new Date(higher!.startsAt.getTime() + 86_400_000);
    await database.forGym(f.gymId, tx => tx.update(classSessions).set({ startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) })
      .where(eq(classSessions.id, lower!.id)));
    await expect(f.edit({ capacity: 3 })).rejects.toMatchObject({ code: 'conflict',
      details: { reason: ['capacityBelowBooked'], startsAt: [startsAt.toISOString()] } });
  });
  it('returns the refusal as a 409 through the route', async () => {
    const f = await booked();
    const before = await f.snapshot();
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (c, next) => {
      c.set('context', { gym: { gymId: f.gymId, timezone: zone, enabledModules: new Set() }, principal: { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: ['owner'] },
        clock: f.at, requestId: 'schedule-capacity-test' });
      await next();
    });
    app.onError(errorHandler);
    createServerRegistry({ routes: createScheduleRoutes(f.own) }).mount(app, authorize, new Set());
    const contract = scheduleContracts.updateTemplate;
    const response = await request(app, contract.method, contract.path.replace('{id}', f.template.id), { ...f.body, capacity: 3, revision: f.template.revision });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict',
      details: { reason: ['capacityBelowBooked'], startsAt: [f.session.startsAt.toISOString()] } } });
    expect(await f.snapshot()).toEqual(before);
  });
  it('reads and writes no session when the capacity is unchanged, and hides the template from another gym', async () => {
    const f = await weekly(5);
    const before = await f.sessions();
    const read = vi.spyOn(settings, 'readBookingRules');
    try {
      expect(await f.edit({ name: 'Renamed class' })).toMatchObject({ name: 'Renamed class', capacity: 5 });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
    expect(await f.sessions()).toEqual(before);
    expect(await f.audits('schedule.session.capacity')).toEqual([]);
    const contract = scheduleContracts.updateTemplate;
    const foreign = await request(server('owner', gymB), contract.method, contract.path.replace('{id}', f.template.id), { ...fields(gymB), capacity: 10, revision: 2 });
    expect(foreign.status).toBe(404);
    expect(await f.sessions()).toEqual(before);
  });
});
