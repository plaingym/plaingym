// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { auditEvents, memberships, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { membersReportResponseSchema, type MembersReportQuery } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMembersReportService } from './members.js';
import { createMembersReportRoutes } from './members.routes.js';
import { measureReportStatements } from './statements.test-helper.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-12-01T00:30:00Z'); // November in New York.
const service = createMembersReportService(database.forGym);
const query: MembersReportQuery = { from: '2026-03', to: '2026-05' };
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone: 'America/New_York' });
  return { gymId, timezone: 'America/New_York', clock };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = typeof memberships.$inferSelect;
async function membership(f: Fixture, overrides: Partial<typeof memberships.$inferInsert> = {}) {
  return factory('memberships', f.gymId, { status: 'active', ...overrides });
}
async function event(f: Fixture, row: Row, action: string, instant: string, state = 'active', beforeState?: string) {
  const after = action === 'assigned' ? { membership: { id: row.id, status: state } }
    : action === 'imported' ? { memberId: row.memberId, planId: row.planId } : { status: state };
  return factory('auditEvents', f.gymId, { action: 'billing.membership.' + action,
    targetType: 'membership', targetId: row.id, occurredAt: new Date(instant), after,
    ...(beforeState ? { before: { status: beforeState } } : {}) });
}
async function assigned(f: Fixture, instant: string, overrides: Partial<typeof memberships.$inferInsert> = {}) {
  const row = await membership(f, overrides);
  await event(f, row, 'assigned', instant, 'active'); return row;
}
function app(f: Fixture, roles: readonly StaffRole[] = ['owner'], principal?: Principal) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (c, next) => {
    c.set('context', { requestId: 'members-report-test', gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() }, clock,
      principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: uuidv7(), roles } });
    await next();
  });
  server.onError((error, c) => c.json(errorResponse(error, 'members-report-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createMembersReportRoutes(service) }).mount(server, authorize, new Set());
  return server;
}
const url = (input = query) => '/api/reports/members?' + new URLSearchParams(input);
function identity(response: Awaited<ReturnType<typeof service.get>>) {
  for (const month of response.data.buckets) {
    expect(month.activeAtStart + month.new + month.imported - month.cancelled, month.startDate).toBe(month.activeAtEnd);
    expect(month.netChange).toBe(month.new + month.imported - month.cancelled);
  }
}

describe('members report with real PostgreSQL and RLS', () => {
  it('limits churn to distinct members active at the start while keeping all cancellations in the column', async () => {
    const f = await fixture();
    const existing = await assigned(f, '2026-02-01T12:00:00Z', { status: 'cancelled', cancelledAt: new Date('2026-03-05T12:00:00Z') });
    await assigned(f, '2026-03-10T12:00:00Z', { memberId: existing.memberId, householdId: existing.householdId,
      status: 'cancelled', cancelledAt: new Date('2026-03-20T12:00:00Z') });
    for (let index = 0; index < 5; index++) await assigned(f, '2026-03-02T12:00:00Z', {
      status: 'cancelled', cancelledAt: new Date('2026-03-25T12:00:00Z') });
    const result = await service.get(f, query); identity(result);
    expect(result.data.buckets[0]).toMatchObject({ activeAtStart: 1, new: 6, cancelled: 7, activeAtEnd: 0,
      churn: { numerator: 1, denominator: 1 } });
  });
  it('counts a frozen member only while every live membership is frozen, including overlap boundaries', async () => {
    const f = await fixture(), frozen = await assigned(f, '2026-02-01T12:00:00Z');
    await event(f, frozen, 'frozen', '2026-03-05T12:00:00Z', 'frozen', 'active');
    await assigned(f, '2026-02-15T12:00:00Z', { memberId: frozen.memberId, householdId: frozen.householdId,
      status: 'cancelled', cancelledAt: new Date('2026-04-01T04:00:00Z') });
    const result = await service.get(f, query); identity(result);
    expect(result.data.buckets.map(bucket => [bucket.activeAtEnd, bucket.frozenAtEnd])).toEqual([[1, 0], [1, 1], [1, 1]]);
  });
  it('rebuilds known monthly answers across DST, midnight, freeze, conversion, overlaps, return, import, erasure and fallback', async () => {
    const f = await fixture();
    await assigned(f, '2026-03-01T04:59:59.999Z', { status: 'cancelled', cancelledAt: new Date('2026-04-15T12:00:00Z') });
    await assigned(f, '2026-03-01T05:00:00Z'); // New in March, even with the default January starts_on.
    const frozen = await assigned(f, '2026-02-15T12:00:00Z');
    await event(f, frozen, 'frozen', '2026-03-05T12:00:00Z', 'frozen');
    await event(f, frozen, 'activated', '2026-05-05T12:00:00Z');
    const pending = await membership(f, { status: 'cancelled', cancelledAt: new Date('2026-03-10T12:00:00Z') });
    await event(f, pending, 'assigned', '2026-02-05T12:00:00Z', 'pending');
    const trial = await membership(f);
    await event(f, trial, 'assigned', '2026-02-05T12:00:00Z', 'trial');
    await event(f, trial, 'activated', '2026-03-10T12:00:00Z');
    const overlap = await assigned(f, '2026-02-10T12:00:00Z', { status: 'cancelled', cancelledAt: new Date('2026-03-15T12:00:00Z') });
    await assigned(f, '2026-03-01T05:00:00Z', { memberId: overlap.memberId, householdId: overlap.householdId,
      status: 'cancelled', cancelledAt: new Date('2026-05-01T04:00:00Z') });
    const returning = await assigned(f, '2026-02-12T12:00:00Z', { status: 'cancelled', cancelledAt: new Date('2026-03-10T12:00:00Z') });
    await assigned(f, '2026-04-10T12:00:00Z', { memberId: returning.memberId, householdId: returning.householdId });
    const imported = await membership(f, { startsOn: '2020-01-01' });
    await event(f, imported, 'imported', '2026-03-20T12:00:00Z');
    const erased = await factory('members', f.gymId, { anonymizedAt: new Date('2026-04-20T12:00:00Z'), status: 'cancelled' });
    await assigned(f, '2026-02-20T12:00:00Z', { memberId: erased.id, householdId: erased.householdId,
      status: 'cancelled', cancelledAt: erased.anonymizedAt });
    await membership(f, { startsOn: '2026-01-15' }); // No-audit active fallback.
    await membership(f, { status: 'frozen', startsOn: '2026-02-01', frozenAt: new Date('2026-02-15T12:00:00Z') });
    await membership(f, { status: 'cancelled', cancelledAt: new Date('2026-03-15T12:00:00Z') }); // No activation: never counted.
    const frozenTrial = await membership(f);
    await event(f, frozenTrial, 'assigned', '2026-02-05T12:00:00Z', 'trial');
    await event(f, frozenTrial, 'frozen', '2026-03-08T07:00:00Z', 'frozen');
    await event(f, frozenTrial, 'activated', '2026-04-05T12:00:00Z');
    const result = membersReportResponseSchema.parse(await service.get(f, { from: '2026-01', to: '2026-05' }));
    identity(result);
    expect(result.data.buckets.map(({ activeAtStart, new: added, imported, cancelled, activeAtEnd, frozenAtEnd }) =>
      [activeAtStart, added, imported, cancelled, activeAtEnd, frozenAtEnd])).toEqual([
      [0, 1, 0, 0, 1, 0], [1, 6, 0, 0, 7, 1], [7, 2, 1, 1, 9, 2], [9, 2, 0, 2, 9, 2], [9, 0, 0, 1, 8, 1],
    ]);
    expect(result.data.buckets[0]!.churn).toBeNull();
    expect(result.data.buckets[2]).toMatchObject({ startsAt: '2026-03-01T05:00:00.000Z', endsAt: '2026-04-01T04:00:00.000Z',
      churn: { numerator: 1, denominator: 7 } });
  });
  it('does not use seed fallback for a trial frozen before its first activation', async () => {
    const f = await fixture();
    const trial = await membership(f, { status: 'frozen', frozenAt: new Date('2026-03-05T12:00:00Z') });
    await event(f, trial, 'assigned', '2026-02-05T12:00:00Z', 'trial');
    await event(f, trial, 'frozen', '2026-03-05T12:00:00Z', 'frozen', 'trial');
    // A directly seeded trial also has reliable evidence once it is frozen through the service.
    const seeded = await membership(f, { status: 'frozen', frozenAt: new Date('2026-03-05T12:00:00Z') });
    await event(f, seeded, 'frozen', '2026-03-05T12:00:00Z', 'frozen', 'trial');
    const result = await service.get(f, query); identity(result);
    for (const bucket of result.data.buckets) expect(bucket).toMatchObject({ activeAtStart: 0, new: 0, imported: 0,
      cancelled: 0, netChange: 0, activeAtEnd: 0, frozenAtEnd: 0, churn: null });
  });
  it('keeps the seed fallback for a seeded active membership frozen and resumed or cancelled through the service', async () => {
    const f = await fixture();
    const resumed = await membership(f, { startsOn: '2026-01-15' });
    await event(f, resumed, 'frozen', '2026-03-05T12:00:00Z', 'frozen', 'active');
    await event(f, resumed, 'activated', '2026-04-05T12:00:00Z', 'active', 'frozen');
    const cancelled = await membership(f, { startsOn: '2026-01-15', status: 'cancelled',
      frozenAt: new Date('2026-03-05T12:00:00Z'), cancelledAt: new Date('2026-04-10T12:00:00Z') });
    await event(f, cancelled, 'frozen', '2026-03-05T12:00:00Z', 'frozen', 'active');
    const result = await service.get(f, query); identity(result);
    expect(result.data.buckets.map(({ activeAtStart, new: added, imported, cancelled: left, activeAtEnd, frozenAtEnd }) =>
      [activeAtStart, added, imported, left, activeAtEnd, frozenAtEnd])).toEqual([
      [2, 0, 0, 0, 2, 2], [2, 0, 0, 1, 1, 0], [1, 0, 0, 0, 1, 0],
    ]);
  });
  it('counts leave and return transitions within one month, merges touching memberships, and preserves import provenance', async () => {
    const f = await fixture();
    const first = await assigned(f, '2026-02-01T05:00:00Z', { status: 'cancelled', cancelledAt: new Date('2026-03-05T12:00:00Z') });
    await assigned(f, '2026-03-10T12:00:00Z', { memberId: first.memberId, householdId: first.householdId,
      status: 'cancelled', cancelledAt: new Date('2026-03-20T12:00:00Z') });
    await assigned(f, '2026-03-20T12:00:00Z', { memberId: first.memberId, householdId: first.householdId });
    const imported = await membership(f, { status: 'cancelled', cancelledAt: new Date('2026-03-15T12:00:00Z') });
    await event(f, imported, 'imported', '2026-03-01T05:00:00Z');
    await assigned(f, '2026-03-10T12:00:00Z', { memberId: imported.memberId, householdId: imported.householdId });
    const result = await service.get(f, query); identity(result);
    expect(result.data.buckets[0]).toMatchObject({ activeAtStart: 1, new: 1, imported: 1, cancelled: 1, activeAtEnd: 2,
      netChange: 1, churn: { numerator: 1, denominator: 1 } });
  });
  it('uses gym-local fall boundaries, both repeated hours, and inclusive cancellation at the next month start', async () => {
    const f = await fixture();
    await assigned(f, '2026-11-01T03:59:59.999Z', { status: 'cancelled', cancelledAt: new Date('2026-11-01T04:00:00Z') });
    await assigned(f, '2026-11-01T04:00:00Z');
    await assigned(f, '2026-11-01T05:30:00Z');
    await assigned(f, '2026-11-01T06:30:00Z');
    const result = await service.get(f, { from: '2026-10', to: '2026-11' }); identity(result);
    expect(result.data.buckets.map(b => [b.activeAtStart, b.new, b.cancelled, b.activeAtEnd])).toEqual([[0, 1, 0, 1], [1, 3, 1, 3]]);
    expect(result.data.buckets[1]).toMatchObject({ startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-12-01T05:00:00.000Z' });
  });
  it('isolates memberships and audit histories across gyms on service and HTTP paths', async () => {
    const a = await fixture(), b = await fixture();
    await assigned(a, '2026-03-01T05:00:00Z');
    const foreign = await assigned(b, '2026-02-01T05:00:00Z', { status: 'cancelled', cancelledAt: new Date('2026-03-10T12:00:00Z') });
    await assigned(b, '2026-03-01T05:00:00Z');
    // Even a foreign audit targeting A's UUID must not change A's first activation.
    await factory('auditEvents', b.gymId, { targetId: (await membership(a, { status: 'cancelled', cancelledAt: new Date('2026-03-10T12:00:00Z') })).id,
      targetType: 'membership', action: 'billing.membership.imported', occurredAt: new Date('2026-02-01T05:00:00Z') });
    const response = await app(a).request(url());
    expect(response.status).toBe(200);
    const result = membersReportResponseSchema.parse(await response.json()); identity(result);
    expect(result.data.buckets[0]).toMatchObject({ activeAtStart: 0, new: 1, imported: 0, cancelled: 0, activeAtEnd: 1 });
    expect(JSON.stringify(result)).not.toContain(foreign.id);
    expect((await service.get(b, query)).data.buckets[0]).toMatchObject({ activeAtStart: 1, new: 1, cancelled: 1, activeAtEnd: 1 });
  });
  it.each(staffRoles)('requires both permissions before validation for %s and disables caching', async role => {
    const f = await fixture(), allowed = role === 'owner' || role === 'admin';
    const response = await app(f, [role]).request(url());
    expect(response.status).toBe(allowed ? 200 : 403);
    if (allowed) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(membersReportResponseSchema.safeParse(await response.json()).success).toBe(true);
    }
    expect((await app(f, [role]).request('/api/reports/members?from=invalid')).status).toBe(allowed ? 400 : 403);
  });
  it('denies anonymous, member, device and foreign-gym staff principals', async () => {
    const f = await fixture(), userId = uuidv7();
    const principals: Principal[] = [{ kind: 'anonymous' },
      { kind: 'member', userId, scope: { gymId: f.gymId, householdId: uuidv7(), role: 'payer' } },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      { kind: 'staff', gymId: uuidv7(), userId, roles: ['owner'] }];
    for (const principal of principals) expect((await app(f, [], principal).request(url())).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
  });
  it.each([{ from: '2024-11', to: '2026-11' }, { from: '2026-04', to: '2026-03' }, { from: '2026-12', to: '2026-12' },
    { ...query, granularity: 'week' }])('rejects invalid, future and nonmonthly queries: %j', async input => {
    const f = await fixture(); expect((await app(f).request(url(input))).status).toBe(400);
  });
  it('runs exactly one report statement in one scope for empty or populated 24-month ranges', async () => {
    const f = await fixture();
    const measure = (input: MembersReportQuery) => measureReportStatements(database.appUrl,
      scope => createMembersReportService(scope).get(f, input));
    const short = await measure(query);
    const row = await membership(f);
    await database.forGym(f.gymId, async tx => {
      const rows = await tx.insert(memberships).values(Array.from({ length: 250 }, () => ({ gymId: f.gymId,
        memberId: row.memberId, householdId: row.householdId, planId: row.planId, status: 'active',
        amountCents: 10000, currency: row.currency, interval: 'monthly', startsOn: '2026-03-01', nextDueOn: '2026-03-01' }))).returning();
      await tx.insert(auditEvents).values(rows.map(row => ({ gymId: f.gymId, targetId: row.id, targetType: 'membership',
        actorKind: 'system', action: 'billing.membership.imported', occurredAt: new Date('2026-03-01T05:00:00Z') })));
    });
    const long = await measure({ from: '2024-12', to: '2026-11' }); identity(long.result);
    expect(short.reportStatements).toHaveLength(1); expect(long.reportStatements).toHaveLength(1);
    expect(short.statements).toHaveLength(4); expect(long.statements).toHaveLength(4);
    expect(long.result.data.buckets.at(-1)!.activeAtEnd).toBe(1); // All memberships belong to the same member.
  });
});
