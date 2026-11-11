// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, leads, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { leadListResponseSchema, leadResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMembersService } from '../members/members.js';
import { measureReportStatements } from '../reports/statements.test-helper.js';
import { createLeadsService } from './list.js';
import { createLeadsRoutes } from './list.routes.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), userId = uuidv7(), timezone = 'America/New_York';
  await factory('gyms', gymId, { timezone }); await factory('authUser', gymId, { id: userId });
  const clock = new TestClock('2026-03-09T03:59:59.999Z');
  const service = createLeadsService({ scope: db.forGym, clock });
  return { gymId, userId, timezone, clock, service, context: { gymId, actor: { kind: 'user' as const, userId } } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function person(f: Fixture, stage?: string, overrides: Record<string, unknown> = {}) {
  const member = await factory('members', f.gymId, { status: 'prospect', ...overrides });
  if (stage) await factory('leads', f.gymId, { memberId: member.id, stage,
    wonAt: stage === 'won' ? f.clock.now() : null, lostAt: stage === 'lost' ? f.clock.now() : null });
  return member;
}
function app(f: Fixture, roles: readonly StaffRole[] = ['owner'], principal?: Principal) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() }, clock: f.clock,
      requestId: 'leads-test', principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: f.userId, roles } });
    await next();
  });
  server.onError(errorHandler);
  createServerRegistry({ routes: createLeadsRoutes(f.service) }).mount(server, authorize, new Set());
  return server;
}
function request(server: ReturnType<typeof app>, id: string, method: string, suffix = '', body?: unknown) {
  return server.request(`/api/leads/${id}${suffix}`, { method, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
}
const probes = [
  { method: 'GET', suffix: '', body: undefined },
  { method: 'PATCH', suffix: '', body: { revision: 1, source: 'phone' } },
  { method: 'POST', suffix: '/lost', body: { revision: 1, reason: 'Private reason' } },
  { method: 'POST', suffix: '/reopen', body: { revision: 1 } },
];

describe('leads list and edits against PostgreSQL and forced RLS', () => {
  it('includes persisted leads and row-less prospect/trial members, with stable pagination and filtered counts', async () => {
    const f = await fixture();
    const a = await person(f, undefined, { firstName: 'Ada', lastName: 'Alpha' });
    await person(f, undefined, { status: 'trial', lastName: 'Beta' });
    await person(f, 'won', { status: 'active', lastName: 'Gamma' });
    await person(f, 'lost');
    await person(f, undefined, { status: 'active' });
    await person(f, 'new', { anonymizedAt: f.clock.now() });
    const result = leadListResponseSchema.parse(await f.service.list(f, { limit: 1 }));
    expect(result.data.map(row => row.memberId)).toEqual([a.id]);
    expect(result.data[0]).toMatchObject({ stage: 'new', source: null, revision: 0 });
    expect(result.pagination).toEqual({ limit: 1, offset: 0, total: 3 });
    expect(result.counts).toEqual({ new: 2, contacted: 0, trial_booked: 0, trial_attended: 0, won: 1, lost: 0 });
    expect((await f.service.list(f, { includeLost: true })).pagination.total).toBe(4);
    expect((await f.service.list(f, { offset: 100 })).data).toEqual([]);
    expect((await f.service.list(f, { stage: 'lost' })).counts.lost).toBe(1);
    expect((await f.service.list(f, { search: 'Ada' })).data.map(row => row.memberId)).toEqual([a.id]);
    expect((await f.service.list(f, { search: '%' })).data).toEqual([]);
  });
  it('filters repeatable stages and unknown source over HTTP without losing a repeated parameter', async () => {
    const f = await fixture();
    await person(f); await person(f, 'contacted'); await person(f, 'trial_booked');
    const known = await person(f, 'new');
    await f.service.edit(f.context, known.id, { revision: 1, source: 'phone' });
    const response = await app(f).request('/api/leads?stage=new&stage=contacted&source=unknown');
    expect(response.status).toBe(200);
    const result = leadListResponseSchema.parse(await response.json());
    expect(result.pagination.total).toBe(2);
    expect(result.counts).toMatchObject({ new: 1, contacted: 1, trial_booked: 0 });
    expect((await f.service.list(f, { source: 'phone' })).data.map(row => row.memberId)).toEqual([known.id]);
    expect((await app(f).request('/api/leads?includeLost=false&due=false')).status).toBe(200);
  });
  it('uses gym-local today for due open leads across midnight after DST', async () => {
    const f = await fixture();
    for (const [stage, date] of [['new', '2026-03-08'], ['contacted', '2026-03-09'], ['won', '2026-03-08'], ['lost', '2026-03-08']]) {
      const member = await person(f, stage);
      await db.forGym(f.gymId, tx => tx.update(leads).set({ nextFollowUpOn: date }).where(eq(leads.memberId, member.id)));
    }
    await person(f);
    expect((await f.service.list(f, { due: true, includeLost: true })).pagination.total).toBe(1);
    f.clock.advance(1);
    expect((await f.service.list(f, { due: true, includeLost: true })).pagination.total).toBe(2);
  });
  it('retains lost leads, hides them by default, and reopens to contacted, clearing the reason', async () => {
    const f = await fixture(), member = await person(f), server = app(f);
    const lost = await request(server, member.id, 'POST', '/lost', { revision: 0, reason: 'Private reason' });
    expect(lost.status).toBe(200);
    expect(leadResponseSchema.parse(await lost.json()).data).toMatchObject({ stage: 'lost', revision: 1, lostReason: 'Private reason' });
    expect((await f.service.list(f)).data).toEqual([]);
    expect((await f.service.list(f, { includeLost: true })).data.map(row => row.memberId)).toEqual([member.id]);
    expect((await request(server, member.id, 'PATCH', '', { revision: 1, stage: 'contacted' })).status).toBe(409);
    expect((await request(server, member.id, 'POST', '/reopen', { revision: 0 })).status).toBe(409);
    const reopened = await request(server, member.id, 'POST', '/reopen', { revision: 1 });
    expect(reopened.status).toBe(200);
    expect(leadResponseSchema.parse(await reopened.json()).data).toMatchObject({ stage: 'contacted', lostReason: null, revision: 2 });
    expect((await f.service.list(f)).pagination.total).toBe(1);
    expect((await request(server, member.id, 'POST', '/lost', { revision: 1, reason: 'Stale' })).status).toBe(409);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
    expect(audits.map(row => row.action)).toEqual(['lead.lost', 'lead.reopened']);
    expect(JSON.stringify(audits)).not.toContain('Private reason');
    expect(audits[0]).toMatchObject({ actorUserId: f.userId, occurredAt: f.clock.now() });
  });
  it('accepts every manual stage but refuses hand-set won/lost and all stage changes or loss of won leads', async () => {
    const f = await fixture(), member = await person(f), server = app(f);
    let revision = 0;
    for (const stage of ['new', 'contacted', 'trial_booked', 'trial_attended']) {
      const response = await request(server, member.id, 'PATCH', '', { revision, stage });
      expect(response.status).toBe(200); revision++;
    }
    for (const stage of ['won', 'lost'])
      expect((await request(server, member.id, 'PATCH', '', { revision, stage })).status).toBe(409);
    const won = await person(f, 'won');
    expect((await request(server, won.id, 'PATCH', '', { revision: 1, nextFollowUpOn: '0000-01-01' })).status).toBe(400);
    for (const stage of ['new', 'won']) expect((await request(server, won.id, 'PATCH', '', { revision: 1, stage })).status).toBe(409);
    expect((await request(server, won.id, 'POST', '/lost', { revision: 1, reason: 'No' })).status).toBe(409);
    expect((await request(server, won.id, 'POST', '/reopen', { revision: 1 })).status).toBe(409);
    expect((await request(server, won.id, 'PATCH', '', { revision: 1, source: 'referral', nextFollowUpOn: '2026-03-20' })).status).toBe(200);
  });
  it('returns conflicts for stale revisions and racing first edits; only one write and audit wins', async () => {
    const f = await fixture(), member = await person(f), server = app(f);
    const attempts = await Promise.all([0, 1].map(() => request(server, member.id, 'PATCH', '', { revision: 0, source: 'phone' })));
    expect(attempts.map(row => row.status).sort()).toEqual([200, 409]);
    expect((await request(server, member.id, 'PATCH', '', { revision: 0, source: 'other' })).status).toBe(409);
    const again = await request(server, member.id, 'PATCH', '', { revision: 1, source: null, nextFollowUpOn: null });
    expect(again.status).toBe(200);
    expect(leadResponseSchema.parse(await again.json()).data).toMatchObject({ revision: 2, source: null, nextFollowUpOn: null });
    expect((await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).map(row => row.action)).toEqual(['lead.updated', 'lead.updated']);
  });
  it('rolls back the edit and audit together when a transaction fails', async () => {
    const f = await fixture(), member = await person(f);
    const service = createLeadsService({ clock: f.clock, scope: (gymId, fn) => db.forGym(gymId, async tx => {
      await fn(tx); throw new Error('fail after audit');
    }) });
    await expect(service.lost(f.context, member.id, { revision: 0, reason: 'Private' })).rejects.toThrow('fail after audit');
    expect((await f.service.read(f.gymId, member.id)).data.revision).toBe(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).toEqual([]);
  });
  it.each(staffRoles)('checks every route for %s, including successful mutations and no-store responses', async role => {
    const f = await fixture(), server = app(f, [role]);
    const collection = await server.request('/api/leads');
    expect(collection.status).toBe(role === 'coach' ? 403 : 200);
    for (const probe of probes) {
      const member = await person(f, probe.suffix === '/reopen' ? 'lost' : 'new');
      const response = await request(server, member.id, probe.method, probe.suffix, probe.body);
      expect(response.status).toBe(role === 'coach' ? 403 : 200);
      if (role !== 'coach') {
        leadResponseSchema.parse(await response.json());
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
    }
  });
  it('returns 404 for every foreign-gym, erased, missing, or ordinary non-lead resource', async () => {
    const f = await fixture(), b = await fixture(), server = app(f);
    const foreign = await person(b, 'new');
    const erased = await person(f, 'new', { anonymizedAt: f.clock.now() });
    const ordinary = await person(f, undefined, { status: 'active' });
    for (const memberId of [foreign.id, erased.id, ordinary.id, uuidv7()]) for (const probe of probes)
      expect((await request(server, memberId, probe.method, probe.suffix, probe.body)).status).toBe(404);
    expect((await f.service.list(f, { includeLost: true })).data).toEqual([]);
  });
  it('removes an actually erased member from every lead route and leaves other household members visible', async () => {
    const f = await fixture(), member = await person(f, 'lost'), server = app(f);
    const other = await person(f, 'new', { householdId: member.householdId });
    await createMembersService({ scope: db.forGym, clock: f.clock }).anonymizeMember(f.context, member.id, { revision: 1 });
    for (const probe of probes) expect((await request(server, member.id, probe.method, probe.suffix, probe.body)).status).toBe(404);
    expect((await f.service.list(f, { includeLost: true })).data.map(row => row.memberId)).toEqual([other.id]);
  });
  it('denies anonymous, member, kiosk and foreign staff principals on every route', async () => {
    const f = await fixture(), member = await person(f, 'new');
    const principals: Principal[] = [{ kind: 'anonymous' },
      { kind: 'member', userId: f.userId, scope: { gymId: f.gymId, householdId: member.householdId, role: 'payer' } },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      { kind: 'staff', gymId: uuidv7(), userId: f.userId, roles: ['owner'] }];
    for (const principal of principals) {
      const server = app(f, [], principal), status = principal.kind === 'anonymous' ? 401 : 403;
      expect((await server.request('/api/leads')).status).toBe(status);
      for (const probe of probes) expect((await request(server, member.id, probe.method, probe.suffix, probe.body)).status).toBe(status);
    }
  });
  it('keeps two list statements as the cohort grows, including an empty page', async () => {
    const f = await fixture();
    const measure = () => measureReportStatements(db.appUrl, scope => createLeadsService({ scope, clock: f.clock }).list(f, { offset: 100 }));
    const empty = await measure();
    for (let n = 0; n < 5; n++) await person(f, n % 2 ? 'contacted' : undefined);
    const populated = await measure();
    expect(empty.reportStatements).toHaveLength(2); expect(populated.reportStatements).toHaveLength(2);
    expect(populated.result.pagination.total).toBe(5); expect(populated.result.data).toEqual([]);
  });
});
