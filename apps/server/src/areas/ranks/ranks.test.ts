// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, memberRanks, ranks, uuidv7 } from '@plaingym/db';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, canStaff, staffRoles, type ContentPack, type StaffRole } from '@plaingym/shared';
import { ranksContracts, type CreatePromotionRequest } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { FakeAttendanceQueries } from '../../core/interfaces/attendance.js';
import { FakePromotionCriterionProvider } from '../../core/interfaces/extensions.js';
import { authorize } from '../staff/auth.permissions.js';
import { createPromotionCriteria } from './criteria.js';
import { createRanksService } from './ranks.service.js';
import { createRanksRoutes } from './ranks.routes.js';
import { createContentPackService } from './packs.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
let userId: string;
beforeAll(async () => {
  const gym = uuidv7(); await factory('gyms', gym); userId = (await factory('authUser', gym)).id;
});
const mutation = (gymId: string) => ({ gymId, actor: { kind: 'user' as const, userId } });
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const criteria = createPromotionCriteria(new FakeAttendanceQueries());
  const service = createRanksService({ scope: database.forGym, clock, criteria });
  const context = mutation(gymId);
  const system = await service.createRankSystem(context, { name: 'Progression' });
  const program = await service.createProgram(context, { name: 'Adults', rankSystemId: system.id, active: true });
  const rank = await service.createRank(context, { rankSystemId: system.id, name: 'Foundation', position: 0,
    color: '#ffffff', subRanks: [{ id: 'tip', name: 'Tip' }], criteria: [] });
  const member = await factory('members', gymId, { status: 'active', dateOfBirth: '2000-01-01', createdAt: new Date('2026-09-01Z') });
  const promotion: CreatePromotionRequest = { memberId: member.id, programId: program.id, rankId: rank.id,
    rankSystemId: system.id, subRank: 0, promotedAt: '2026-10-01T12:00:00Z' };
  return { gymId, service, criteria, context, system, program, rank, member, promotion };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function server(f: Fixture, role: StaffRole = 'owner', principal?: Principal, enabledModules = new Set<string>()) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId: f.gymId, timezone: 'UTC', enabledModules },
      principal: principal ?? { kind: 'staff', gymId: f.gymId, userId, roles: [role] }, clock, requestId: 'ranks-test' });
    await next();
  });
  app.onError((error, c) => c.json(errorResponse(error, 'ranks-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createRanksRoutes(() => f.service) }).mount(app, authorize, enabledModules);
  return app;
}
type Operation = Exclude<keyof typeof ranksContracts, 'catalog' | 'listPacks' | 'applyPack'>;
const operations: Operation[] = ['listPrograms', 'createProgram', 'updateProgram', 'listRankSystems', 'createRankSystem',
  'updateRankSystem', 'listRanks', 'createRank', 'updateRank', 'listPromotions', 'promote', 'bulkPromote', 'eligibility'];
function request(app: ReturnType<typeof server>, operation: Operation, f: Fixture) {
  const contract = ranksContracts[operation];
  const bodies: Partial<Record<Operation, unknown>> = {
    createProgram: { name: 'New program', rankSystemId: f.system.id, active: true },
    updateProgram: { revision: f.program.revision, name: 'Edited program' },
    createRankSystem: { name: 'New system' }, updateRankSystem: { revision: f.system.revision, name: 'Edited system' },
    createRank: { rankSystemId: f.system.id, name: 'Advanced', position: 1, color: '#123456', subRanks: [], criteria: [] },
    updateRank: { revision: f.rank.revision, color: '#654321' }, promote: f.promotion,
    bulkPromote: { ...f.promotion, memberId: undefined, memberIds: [f.member.id] },
  };
  const suffix: Partial<Record<Operation, string>> = {
    listPrograms: '?rankSystemId=' + f.system.id, listRanks: '?rankSystemId=' + f.system.id,
    listPromotions: '?memberId=' + f.member.id + '&programId=' + f.program.id,
    eligibility: '?programId=' + f.program.id + '&rankId=' + f.rank.id + '&readyOnly=true',
  };
  const id = operation === 'updateProgram' ? f.program.id : operation === 'updateRankSystem' ? f.system.id : f.rank.id;
  return app.request(contract.path.replace('{id}', id) + (suffix[operation] ?? ''), { method: contract.method.toUpperCase(),
    ...(bodies[operation] ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies[operation]) } : {}) });
}

describe('rank routes with real permissions and Postgres RLS', () => {
  for (const operation of operations) {
    for (const role of staffRoles) it(`${operation}: ${role} follows the declared permission`, async () => {
      const f = await fixture(), contract = ranksContracts[operation];
      const response = await request(server(f, role), operation, f);
      expect(response.status).toBe(canStaff([role], contract.permission.capability) ? 200 : 403);
    });
    it(`${operation}: never accesses another gym's references or list`, async () => {
      const a = await fixture(), b = await fixture();
      const response = await request(server(a), operation, b);
      // Lists without resource references return only this gym's own records.
      if (operation === 'listRankSystems') {
        expect(response.status).toBe(200);
        expect((await response.json() as { data: { gymId: string }[] }).data.every((row) => row.gymId === a.gymId)).toBe(true);
      } else if (operation === 'createRankSystem') {
        expect(response.status).toBe(200);
        expect((await response.json() as { data: { gymId: string } }).data.gymId).toBe(a.gymId);
      } else expect(response.status).toBe(404);
    });
    it(`${operation}: rejects an anonymous or member principal`, async () => {
      const f = await fixture();
      expect((await request(server(f, 'owner', { kind: 'anonymous' }), operation, f)).status).toBe(401);
      const household = await factory('households', f.gymId);
      const principal: Principal = { kind: 'member', userId, scope: { gymId: f.gymId, householdId: household.id, role: 'payer' } };
      expect((await request(server(f, 'owner', principal), operation, f)).status).toBe(403);
    });
  }
  it('generates OpenAPI for JSON-configured criteria without recursion', async () => {
    const app = server(await fixture());
    expect(app.getOpenAPIDocument({ openapi: '3.1.0', info: { title: 'Ranks', version: '1' } }).paths).toHaveProperty('/api/ranks');
  });
});

describe('rank editing and promotion services', () => {
  it('uses revisions, writes audits with the injected clock and preserves edits on pack reapply', async () => {
    const f = await fixture();
    const packs = createContentPackService({ scope: database.forGym, clock });
    const pack: ContentPack = { id: 'custom', name: 'Custom', version: 1, classTags: [],
      programs: [{ id: 'track', name: 'Pack track', rankSystemId: 'system' }],
      rankSystems: [{ id: 'system', name: 'Pack system', ranks: [{ id: 'base', name: 'Base', color: '#ffffff', subRanks: [] }] }] };
    const installed = await packs.apply(f.context, pack);
    const original = (await f.service.listRanks(f.gymId, { rankSystemId: installed.rankSystems[0]!.id })).data[0]!;
    const edited = await f.service.updateRank(f.context, original.id, { revision: original.revision, name: 'Our name',
      color: '#123abc', position: 5, subRanks: [{ id: 'degree', name: 'Degree' }], criteria: [{ providerId: 'minimum-age', config: { target: 16 } }] });
    await packs.apply(f.context, pack);
    expect((await f.service.listRanks(f.gymId, { rankSystemId: original.rankSystemId })).data).toEqual([edited]);
    await expect(f.service.updateRank(f.context, original.id, { revision: 1, name: 'Stale' })).rejects.toMatchObject({ code: 'conflict' });
    const audits = await database.forGym(f.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, original.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: userId, occurredAt: clock.now(), before: { name: 'Base' }, after: { name: 'Our name', color: '#123abc', revision: 2 } });
  });
  it('includes external module providers in eligibility without evaluating inside a transaction', async () => {
    const f = await fixture();
    const fake = new FakePromotionCriterionProvider('skills', 'skills:complete');
    fake.setProgress({ gymId: f.gymId, memberId: f.member.id, programId: f.program.id, rankId: f.rank.id,
      promotedAt: f.member.createdAt.toISOString() }, 3);
    f.criteria.register({ id: fake.id, labelKey: fake.labelKey, configSchema: fake.configSchema, moduleId: 'skills',
      evaluate: async (context, config) => { assertNoTransaction('criterion'); return fake.evaluate(context, fake.configSchema.parse(config)); } });
    await f.service.updateRank(f.context, f.rank.id, { revision: 1, criteria: [{ providerId: 'skills', config: { target: 3 } }] });
    const response = await request(server(f, 'coach', undefined, new Set(['skills'])), 'eligibility', f);
    expect(response.status).toBe(200);
    expect((await response.json() as { data: unknown[] }).data).toMatchObject([{ eligible: true, criteria: [{ providerId: 'skills', current: 3 }] }]);
    await expect(f.service.eligibility(f.gymId, { programId: f.program.id, rankId: f.rank.id })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('resets class and time counters at promotion and records the shared system and staff profile', async () => {
    const f = await fixture();
    await factory('staffProfiles', f.gymId, { userId });
    const attendance = new FakeAttendanceQueries(['2026-09-20Z', '2026-10-02Z'].map((date) => ({ gymId: f.gymId,
      entry: { id: uuidv7(), memberId: f.member.id, programId: f.program.id, sessionId: null, source: 'import', kind: 'class', occurredAt: new Date(date).toISOString() },
      sessionProgramIds: [], sessionTagIds: [] })));
    const service = createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(attendance) });
    await service.updateRank(f.context, f.rank.id, { revision: 1, criteria: [
      { providerId: 'classes-since-promotion', config: { target: 2 } }, { providerId: 'time-at-rank', config: { target: 30 } }] });
    const query = { programId: f.program.id, rankId: f.rank.id };
    expect((await service.eligibility(f.gymId, query)).data[0]).toMatchObject({ eligible: true, subRank: 0, criteria: [{ current: 2 }, { current: 51 }] });
    const promoted = await service.promote(f.context, f.promotion);
    expect(promoted.rankSystemId).toBe(f.system.id); expect(promoted.promotedBy).not.toBeNull();
    expect((await service.eligibility(f.gymId, query)).data[0]).toMatchObject({ eligible: false, subRank: 1, criteria: [{ current: 1 }, { current: 21 }] });
    expect((await service.eligibility(f.gymId, { ...query, readyOnly: 'true' })).data).toEqual([]);
    expect((await service.listPromotions(f.gymId, { memberId: f.member.id })).data).toEqual([promoted]);
    await service.promote(f.context, { ...f.promotion, subRank: 1, promotedAt: clock.now().toISOString() });
    expect((await service.eligibility(f.gymId, query)).data).toEqual([]);
    await expect(service.updateRank(f.context, f.rank.id, { revision: 2, subRanks: [] })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('serializes concurrent duplicate promotions and rejects future, mismatched and anonymized promotions', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.service.promote(f.context, f.promotion), f.service.promote(f.context, f.promotion)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await database.forGym(f.gymId, (tx) => tx.select().from(memberRanks))).toHaveLength(1);
    await expect(f.service.promote(f.context, { ...f.promotion, subRank: 2 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.promote(f.context, { ...f.promotion, promotedAt: '2027-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'conflict' });
    const other = await f.service.createRankSystem(f.context, { name: 'Other' });
    await expect(f.service.promote(f.context, { ...f.promotion, rankSystemId: other.id })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.updateProgram(f.context, f.program.id, { revision: 1, rankSystemId: other.id })).rejects.toMatchObject({ code: 'conflict' });
    const anonymized = await factory('members', f.gymId, { anonymizedAt: clock.now() });
    await expect(f.service.promote(f.context, { ...f.promotion, memberId: anonymized.id })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('uses progression order to break identical promotion timestamps without allowing duplicates', async () => {
    const f = await fixture();
    await f.service.promote(f.context, f.promotion);
    await f.service.promote(f.context, { ...f.promotion, subRank: 1 });
    expect((await f.service.listPromotions(f.gymId, { memberId: f.member.id })).data.map((row) => row.subRank)).toEqual([1, 0]);
    await expect(f.service.promote(f.context, { ...f.promotion, subRank: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.eligibility(f.gymId, { programId: f.program.id, rankId: f.rank.id })).data).toEqual([]);
  });
  it('bulk promotes with an audit per member and preflights cross-gym members before writing', async () => {
    const f = await fixture(), foreign = await fixture();
    const second = await factory('members', f.gymId);
    const { memberId, ...body } = f.promotion; void memberId;
    await expect(f.service.bulkPromote(f.context, { ...body, memberIds: [f.member.id, foreign.member.id] })).rejects.toMatchObject({ code: 'not_found' });
    expect(await database.forGym(f.gymId, (tx) => tx.select().from(memberRanks))).toHaveLength(0);
    const promoted = await f.service.bulkPromote(f.context, { ...body, notes: 'Knee injury, call 555-0100', memberIds: [f.member.id, second.id] });
    expect(promoted.map((row) => row.memberId)).toEqual([f.member.id, second.id]);
    const audits = await database.forGym(f.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'promotion.created')));
    expect(audits).toHaveLength(2);
    // Append-only audit rows must not keep notes that anonymization later clears.
    for (const audit of audits) { expect(JSON.stringify(audit.after)).not.toContain('555-0100'); expect(audit.after).toMatchObject({ hasNotes: true }); }
  });
  it('paginates consistently, filters inactive programs, and rejects stale configuration saves', async () => {
    const f = await fixture();
    await f.service.updateProgram(f.context, f.program.id, { revision: 1, active: false });
    expect((await f.service.listPrograms(f.gymId, { active: 'true' })).data).toEqual([]);
    expect((await f.service.eligibility(f.gymId, { programId: f.program.id, rankId: f.rank.id })).data).toEqual([]);
    await expect(f.service.updateProgram(f.context, f.program.id, { revision: 1, name: 'Stale' })).rejects.toMatchObject({ code: 'conflict' });
    await f.service.updateRankSystem(f.context, f.system.id, { revision: 1, name: 'New name' });
    await expect(f.service.updateRankSystem(f.context, f.system.id, { revision: 1, name: 'Stale' })).rejects.toMatchObject({ code: 'conflict' });
    await f.service.createRank(f.context, { rankSystemId: f.system.id, name: 'Second', position: 1, subRanks: [], criteria: [] });
    expect(await f.service.listRanks(f.gymId, { rankSystemId: f.system.id, limit: 1, offset: 1 }))
      .toMatchObject({ data: [{ name: 'Second' }], pagination: { total: 2, limit: 1, offset: 1 } });
    const before = await database.forGym(f.gymId, (tx) => tx.select().from(ranks));
    await expect(f.service.createRank(f.context, { rankSystemId: f.system.id, name: 'Collision', position: 0, subRanks: [], criteria: [] })).rejects.toMatchObject({ code: 'conflict' });
    expect(await database.forGym(f.gymId, (tx) => tx.select().from(ranks))).toEqual(before);
  });
});
