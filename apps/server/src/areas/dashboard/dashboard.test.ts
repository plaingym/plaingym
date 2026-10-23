// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { members as memberTable, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { matDashboardResponseSchema } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { createMembersService } from '../members/members.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { authorize } from '../staff/auth.permissions.js';
import { createDashboardService } from './dashboard.js';
import { createDashboardRoutes } from './dashboard.routes.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
const attendance = createAttendanceQueries({ scope: database.forGym, clock });
const members = createMembersService({ scope: database.forGym, clock });
const ranks = createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(attendance) });
const service = createDashboardService({ members, ranks, attendance });
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const user = await factory('authUser', gymId);
  const system = await factory('rankSystems', gymId);
  const program = await factory('programs', gymId, { rankSystemId: system.id, active: true });
  const rank = await factory('ranks', gymId, { rankSystemId: system.id, criteria: [
    { providerId: 'time-at-rank', config: { target: 14 } }, { providerId: 'classes-since-promotion', config: { target: 1 } },
  ] });
  const absent = await factory('members', gymId, { firstName: 'Absent', status: 'active', createdAt: new Date('2026-09-01Z') });
  const visitor = await factory('members', gymId, { firstName: 'Open mat visitor', status: 'active', createdAt: new Date('2026-09-01Z') });
  await factory('members', gymId, { firstName: 'Inactive', status: 'cancelled' });
  await factory('attendances', gymId, { memberId: visitor.id, kind: 'open_mat', occurredAt: new Date('2026-10-21T12:00:00Z') });
  await factory('attendances', gymId, { memberId: visitor.id, programId: program.id, kind: 'class', source: 'import',
    sourceKey: 'dashboard-history', occurredAt: new Date('2026-10-01T12:00:00Z') });
  return { gymId, user, absent, visitor, program, rank };
}
function server(f: Awaited<ReturnType<typeof fixture>>, roles: readonly StaffRole[] = ['owner'], principal?: Principal,
  read = () => service) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { requestId: 'dashboard-test', gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, clock,
      principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles } });
    await next();
  });
  app.onError((error, c) => c.json(errorResponse(error, 'dashboard-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createDashboardRoutes(read) }).mount(app, authorize, new Set());
  return app;
}
describe('dashboard routes with PostgreSQL RLS and real area services', () => {
  it('evaluates each member only once when the entire roster has the same next rank', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const household = await factory('households', gymId), system = await factory('rankSystems', gymId);
    await factory('programs', gymId, { rankSystemId: system.id, active: true });
    for (let position = 0; position < 5; position++) await factory('ranks', gymId, {
      name: `Rank ${position}`, rankSystemId: system.id, position,
      criteria: [{ providerId: 'classes-since-promotion', config: { target: 10 } }],
    });
    await database.forGym(gymId, (tx) => tx.insert(memberTable).values(Array.from({ length: 500 }, (_, index) => ({
      gymId, householdId: household.id, firstName: `Member ${index}`, lastName: 'Test', status: 'active', createdAt: new Date('2026-09-01Z'),
    }))));
    let counts = 0, histories = 0;
    const measured = {
      countSince: async (...args: Parameters<typeof attendance.countSince>) => { counts++; return attendance.countSince(...args); },
      history: async (...args: Parameters<typeof attendance.history>) => { histories++; return attendance.history(...args); },
    };
    const dashboard = createDashboardService({ members, attendance: measured,
      ranks: createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(measured) }) });
    const { data } = await dashboard.get({ gymId, clock, roles: ['owner'] });
    expect(data.widgets.find((widget) => widget.id === 'active_members')).toHaveProperty('count', 500);
    expect(data.widgets.find((widget) => widget.id === 'promotion_ready')).toHaveProperty('count', 0);
    expect(counts).toBe(500);
    expect(histories).toBe(500);
  });
  for (const role of staffRoles) it(`allows ${role}, with promotion readiness restricted to promotion staff`, async () => {
    const f = await fixture();
    const response = await server(f, [role]).request('/api/dashboard');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const { data } = matDashboardResponseSchema.parse(await response.json());
    expect(data.widgets.find((item) => item.id === 'active_members')).toHaveProperty('count', 2);
    expect(data.widgets.find((item) => item.id === 'not_seen')).toMatchObject({ count: 1, members: [{ memberId: f.absent.id }] });
    if (role === 'front_desk') expect(data.widgets.map((item) => item.id)).not.toContain('promotion_ready');
    else expect(data.widgets.find((item) => item.id === 'promotion_ready')).toMatchObject({ count: 1, members: [{ memberId: f.visitor.id }] });
  });
  it('never returns another gym data and rejects a session bound to another gym', async () => {
    const a = await fixture(), b = await fixture();
    await factory('members', b.gymId, { status: 'active', firstName: 'Foreign private name' });
    const response = await server(a).request('/api/dashboard?gymId=' + b.gymId);
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const value of [b.absent.id, b.visitor.id, b.program.id, b.rank.id, 'Foreign private name']) expect(text).not.toContain(value);
    const parsed = matDashboardResponseSchema.parse(JSON.parse(text));
    expect(parsed.data.widgets.find((widget) => widget.id === 'active_members')).toHaveProperty('count', 2);
    expect((await server(a, [], { kind: 'staff', gymId: b.gymId, userId: b.user.id, roles: ['owner'] }).request('/api/dashboard')).status).toBe(403);
  });
  it('denies anonymous, portal, kiosk, and roleless identities', async () => {
    const f = await fixture();
    const identities: Principal[] = [{ kind: 'anonymous' }, { kind: 'member', userId: f.user.id,
      scope: { gymId: f.gymId, householdId: f.absent.householdId, role: 'payer' } },
    { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }, { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [] }];
    for (const principal of identities) expect((await server(f, [], principal).request('/api/dashboard')).status)
      .toBe(principal.kind === 'anonymous' ? 401 : 403);
  });
  it('fails closed until configured and advertises the route during generation', async () => {
    const f = await fixture();
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (c, next) => {
      c.set('context', { requestId: 'unconfigured', gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, clock,
        principal: { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: ['owner'] } }); await next();
    });
    app.onError((error, c) => c.json(errorResponse(error, 'unconfigured'), error instanceof AppError ? error.status : 500));
    createServerRegistry({ routes: createDashboardRoutes() }).mount(app, authorize, new Set());
    expect((await app.request('/api/dashboard')).status).toBe(503);
    expect(app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Dashboard', version: '1' } }).paths).toHaveProperty('/api/dashboard');
  });
});
