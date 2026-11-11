// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { attendances, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { attendanceReportResponseSchema, type AttendanceReportQuery } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { createAttendanceReportService } from './attendance.js';
import { createAttendanceReportRoutes } from './attendance.routes.js';
import { measureReportStatements } from './statements.test-helper.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-12-01T00:30:00Z'); // Still November in New York.
const service = createAttendanceReportService(database.forGym);
async function fixture(prefix = '') {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone: 'America/New_York' });
  const member = await factory('members', gymId), other = await factory('members', gymId);
  const program = await factory('programs', gymId, { name: prefix + 'Active program' });
  const archived = await factory('programs', gymId, { name: prefix + 'Archived program', active: false });
  return { gymId, member, other, program, archived, timezone: 'America/New_York', clock };
}
async function visit(f: Awaited<ReturnType<typeof fixture>>, instant: string, extra: Partial<typeof attendances.$inferInsert> = {}) {
  return factory('attendances', f.gymId, { memberId: f.member.id, programId: f.program.id, occurredAt: new Date(instant), ...extra });
}
const query: AttendanceReportQuery = { from: '2026-03', to: '2026-03', granularity: 'month' };
function app(f: Awaited<ReturnType<typeof fixture>>, roles: readonly StaffRole[] = ['owner'], principal?: Principal) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (c, next) => {
    c.set('context', { requestId: 'reports-test', gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() }, clock,
      principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: uuidv7(), roles } });
    await next();
  });
  server.onError((error, c) => c.json(errorResponse(error, 'reports-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createAttendanceReportRoutes(service) }).mount(server, authorize, new Set());
  return server;
}
const url = (input = query) => '/api/reports/attendance?' + new URLSearchParams(input);

describe('attendance report with real PostgreSQL and RLS', () => {
  it('has known monthly and weekly answers across spring DST, month and Monday midnight, and deduplicates totals', async () => {
    const f = await fixture();
    for (const instant of ['2026-03-01T04:59:59.999Z', '2026-03-01T05:00:00Z',
      '2026-03-02T04:59:59.999Z', '2026-03-02T05:00:00Z', '2026-03-08T06:59:59.999Z', '2026-03-08T07:00:00Z',
      '2026-04-01T03:59:59.999Z', '2026-04-01T04:00:00Z']) await visit(f, instant);
    await visit(f, '2026-03-03T12:00:00Z', { programId: f.archived.id, source: 'import', sourceKey: 'import-visit' });
    await visit(f, '2026-03-04T12:00:00Z', { programId: null, kind: 'open_mat' });
    await visit(f, '2026-03-04T13:00:00Z', { memberId: f.other.id });
    const session = await factory('classSessions', f.gymId);
    await factory('classSessionPrograms', f.gymId, { sessionId: session.id, programId: f.program.id });
    await factory('classSessionPrograms', f.gymId, { sessionId: session.id, programId: f.archived.id });
    // The direct program and session program overlap: this check-in appears once per program.
    await visit(f, '2026-03-05T12:00:00Z', { sessionId: session.id });
    const monthly = attendanceReportResponseSchema.parse(await service.get(f, query));
    expect(monthly.data.buckets[0]).toMatchObject({ startsAt: '2026-03-01T05:00:00.000Z', endsAt: '2026-04-01T04:00:00.000Z',
      partial: false, totals: { checkIns: 10, uniqueMembers: 2 } });
    expect(monthly.data.buckets[0]!.programs).toEqual([
      { programId: f.program.id, programName: 'Active program', checkIns: 8, uniqueMembers: 2 },
      { programId: f.archived.id, programName: 'Archived program', checkIns: 2, uniqueMembers: 1 },
      { programId: null, programName: null, checkIns: 1, uniqueMembers: 1 },
    ]);
    const weekly = await service.get(f, { ...query, granularity: 'week' });
    expect(weekly.data.buckets.map(bucket => bucket.totals.checkIns)).toEqual([2, 7, 0, 0, 0, 1]);
    expect(weekly.data.buckets[1]).toMatchObject({ startDate: '2026-03-02', endsAt: '2026-03-09T04:00:00.000Z',
      totals: { checkIns: 7, uniqueMembers: 2 } });
    expect(weekly.data.buckets.filter(bucket => bucket.partial).map(bucket => bucket.startDate)).toEqual(['2026-03-01', '2026-03-30']);
    expect(weekly.data.buckets[2]!.programs).toEqual([]);
    expect((await service.get(f, { from: '2026-02', to: '2026-04', granularity: 'month' })).data.buckets.map(bucket => bucket.totals.checkIns))
      .toEqual([1, 10, 1]);
  });
  it('has known answers across fall DST including both occurrences of the repeated hour and clipped Monday weeks', async () => {
    const f = await fixture();
    for (const instant of ['2026-11-01T03:59:59.999Z', '2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z',
      '2026-11-01T06:30:00Z', '2026-11-02T04:59:59.999Z', '2026-11-02T05:00:00Z',
      '2026-12-01T04:59:59.999Z', '2026-12-01T05:00:00Z']) await visit(f, instant);
    const range = { from: '2026-10', to: '2026-11' };
    const monthly = await service.get(f, { ...range, granularity: 'month' });
    expect(monthly.data.buckets.map(bucket => bucket.totals)).toEqual([{ checkIns: 1, uniqueMembers: 1 }, { checkIns: 6, uniqueMembers: 1 }]);
    const weekly = await service.get(f, { ...range, granularity: 'week' });
    expect(weekly.data.buckets.find(bucket => bucket.startDate === '2026-10-26')).toMatchObject({
      startsAt: '2026-10-26T04:00:00.000Z', endsAt: '2026-11-02T05:00:00.000Z', totals: { checkIns: 5, uniqueMembers: 1 } });
    const november = await service.get(f, { from: '2026-11', to: '2026-11', granularity: 'week' });
    expect(november.data.buckets.map(bucket => bucket.totals.checkIns)).toEqual([4, 1, 0, 0, 0, 1]);
  });
  it('never counts or names gym B programs, on the service or HTTP path', async () => {
    const a = await fixture(), b = await fixture('FOREIGN SECRET ');
    await visit(a, '2026-03-04T12:00:00Z');
    await visit(b, '2026-03-04T12:00:00Z');
    await visit(b, '2026-03-04T13:00:00Z', { memberId: b.other.id, programId: b.archived.id });
    const response = await app(a).request(url());
    expect(response.status).toBe(200);
    const body = attendanceReportResponseSchema.parse(await response.json());
    expect(body.data.buckets[0]!.totals).toEqual({ checkIns: 1, uniqueMembers: 1 });
    expect(body.data.buckets[0]!.programs.map(p => p.programId)).toEqual([a.program.id]);
    expect(JSON.stringify(body)).not.toContain(b.program.id);
    expect(JSON.stringify(body)).not.toContain(b.archived.id);
    expect(JSON.stringify(body)).not.toContain('FOREIGN SECRET');
    expect((await service.get(b, query)).data.buckets[0]!.totals).toEqual({ checkIns: 2, uniqueMembers: 2 });
  });
  it.each(staffRoles)('enforces reports.read for %s and disables caching', async role => {
    const f = await fixture(), response = await app(f, [role]).request(url());
    expect(response.status).toBe(role === 'front_desk' ? 403 : 200);
    if (response.status === 200) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(attendanceReportResponseSchema.safeParse(await response.json()).success).toBe(true);
    }
    expect((await app(f, [role]).request('/api/reports/attendance?from=invalid')).status).toBe(role === 'front_desk' ? 403 : 400);
  });
  it('denies anonymous, member, device and foreign-gym staff principals', async () => {
    const f = await fixture(), userId = uuidv7();
    const principals: Principal[] = [{ kind: 'anonymous' },
      { kind: 'member', userId, scope: { gymId: f.gymId, householdId: f.member.householdId, role: 'payer' } },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      { kind: 'staff', gymId: uuidv7(), userId, roles: ['owner'] }];
    for (const principal of principals) expect((await app(f, [], principal).request(url())).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
  });
  it.each([
    { from: '2024-11', to: '2026-11' }, { from: '2026-04', to: '2026-03' }, { from: '2026-12', to: '2026-12' },
  ])('rejects invalid and future ranges through HTTP: %j', async range => {
    const f = await fixture();
    expect((await app(f).request(url({ ...range, granularity: 'month' }))).status).toBe(400);
  });
  it('runs one report statement in one scope regardless of range, bucket count or attendance size', async () => {
    const f = await fixture();
    const measure = (input: AttendanceReportQuery) => measureReportStatements(database.appUrl,
      scope => createAttendanceReportService(scope).get(f, input));
    const short = await measure(query);
    await database.forGym(f.gymId, tx => tx.insert(attendances).values(Array.from({ length: 250 }, () => ({
      gymId: f.gymId, memberId: f.member.id, programId: f.program.id, source: 'coach', occurredAt: new Date('2026-03-04T12:00:00Z'),
    }))));
    const long = await measure({ from: '2024-12', to: '2026-11', granularity: 'week' });
    expect(short.reportStatements).toHaveLength(1); expect(long.reportStatements).toHaveLength(1);
    // BEGIN + set_config + report + COMMIT, observed by the real driver.
    expect(short.statements).toHaveLength(4); expect(long.statements).toHaveLength(4);
    expect(long.result.data.buckets.reduce((sum, bucket) => sum + bucket.totals.checkIns, 0)).toBe(250);
  });
});
