// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- Explain the same scoped promotion read the app runs.
import { sql, type SQL } from 'drizzle-orm';
import { attendances, memberRanks, members, memberships, uuidv7, type Transaction } from '@plaingym/db';
// Test-only app-role pool: measure both endpoints sharing production's eight connections.
// eslint-disable-next-line no-restricted-imports, database/system-tables
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createMembersService } from '../members/members.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { countPromotionAttendance, promotionAttendanceKey, promotionAttendanceStatement,
  type PromotionAttendanceRequest } from '../attendance/promotion.query.js';
import { promotionAttendanceExactProbeChoices, promotionAttendanceForcedRead,
  promotionAttendanceScanChoices } from '../attendance/promotion.query.test-helper.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createDashboardService } from './dashboard.js';
import { createBillingDashboardService } from './billing.js';
import { createNotSeenRead } from './not-seen.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T12:00:00Z');
const until = clock.now().toISOString();
const joinedOn = new Date('2023-01-01Z');

async function explainPromotion(tx: Transaction, size: number, candidateShare: number, former: number, gymId: string,
  requests: readonly PromotionAttendanceRequest[]) {
  const useRosterScan = former === 0 && candidateShare >= 75;
  const variants = [
    { name: former ? 'candidate_join' : 'roster_switch', read: () =>
      promotionAttendanceForcedRead(tx, gymId, requests, until, false, useRosterScan ? 'whole_program' : 'candidate_join'),
    samples: [] as { totalMs: number; executionMs: number }[] },
    { name: 'exact_probe', read: () => promotionAttendanceForcedRead(tx, gymId, requests, until, false, 'exact_probe'),
      samples: [] as { totalMs: number; executionMs: number }[] },
    { name: 'visitor_switch', read: () => promotionAttendanceStatement(tx, gymId, requests, until, false).statement,
      samples: [] as { totalMs: number; executionMs: number }[] },
  ];
  // Warm both plans, then alternate their order. Wall time includes the visitor probe.
  for (let round = 0; round < 11; round++) {
    for (const { name, read, samples } of round % 2 ? [...variants].reverse() : variants) {
      const started = performance.now();
      const query = read();
      // eslint-disable-next-line database/system-tables -- App-role EXPLAIN with the query's bound values.
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, buffers) ${query}`);
      const totalMs = performance.now() - started;
      const plan = rows.map(row => row['QUERY PLAN']);
      const executionMs = Number(plan.at(-1)!.match(/Execution Time: ([\d.]+) ms/)![1]);
      if (round > 1) samples.push({ totalMs, executionMs });
      if (round === 10) console.info(name + ' ' + candidateShare + '%\n' + plan.join('\n'));
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  for (const { name, samples } of variants) {
    console.info(JSON.stringify({ size, former, visits: (size + former) * 156, candidateShare, plan: name,
      medianTotalMs: median(samples.map(sample => sample.totalMs)), medianExecutionMs: median(samples.map(sample => sample.executionMs)) }));
  }
}

it.each([
  { size: 300, candidateShare: 100, former: 0 },
  { size: 1000, candidateShare: 100, former: 0 },
  { size: 1000, candidateShare: 10, former: 0 },
  { size: 1000, candidateShare: 100, former: 3000 },
])('measures an owner page at $size active members with $candidateShare% promotion candidates and $former former members',
  async ({ size, candidateShare, former }) => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled: true });
  const home = await factory('households', gymId), plan = await factory('plans', gymId);
  const system = await factory('rankSystems', gymId);
  const program = await factory('programs', gymId, { rankSystemId: system.id });
  const rank = await factory('ranks', gymId, { rankSystemId: system.id, criteria: [
    { providerId: 'classes-since-promotion', config: { target: 1 } },
  ] });
  const roster = await database.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: size }, (_, index) => ({
    gymId, householdId: home.id, firstName: 'Member', lastName: String(index).padStart(4, '0'),
    status: 'active', createdAt: joinedOn,
  }))).returning());
  const pastRoster = former ? await database.forGym(gymId, tx => tx.insert(members).values(
    Array.from({ length: former }, (_, index) => ({
      gymId, householdId: home.id, firstName: 'Former member', lastName: String(index), status: 'cancelled',
      createdAt: joinedOn,
    }))).returning({ id: members.id })) : [];
  const candidateCount = size * candidateShare / 100;
  const atFinalRank = roster.slice(candidateCount);
  if (atFinalRank.length) await database.forGym(gymId, tx => tx.insert(memberRanks).values(atFinalRank.map(member => ({
    gymId, memberId: member.id, programId: program.id, rankId: rank.id, rankSystemId: system.id,
    promotedAt: new Date('2026-10-01Z'),
  }))));
  await database.forGym(gymId, tx => tx.insert(memberships).values(roster.map(member => ({ gymId,
    householdId: home.id, memberId: member.id, planId: plan.id, status: 'active', amountCents: 10000,
    currency: 'USD', interval: 'monthly', startsOn: '2023-01-01', nextDueOn: '2026-11-01' }))));
  const visitors = [...roster, ...pastRoster];
  for (let week = 0; week < 156; week++) await database.forGym(gymId, tx => tx.insert(attendances).values(visitors.map(member => ({
    gymId, memberId: member.id, programId: program.id, kind: 'class', source: 'import',
    occurredAt: new Date(Date.parse('2023-10-01Z') + week * 7 * 86400000),
  }))));
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try { await maintenance.sql`analyze attendances`; } finally { await maintenance.close(); }
  const connection = openConnection(database.appUrl, 8), { forGym: scope } = scopedDatabase(connection.db);
  let queries = 0, peak = 0;
  const occupied = new Set<number>();
  connection.sql.options.debug = (id, query) => {
    if (/^begin/i.test(query)) { occupied.add(id); peak = Math.max(peak, occupied.size); }
    if (/^(commit|rollback)/i.test(query)) occupied.delete(id);
    // Count scoped application reads, excluding driver catalog discovery when another pool connection opens.
    if (occupied.has(id) && /^\s*(select|with)\b/i.test(query) && !query.includes('set_config')) queries++;
  };
  const measure = async <T>(surface: string, read: () => Promise<T>) => {
    queries = 0; peak = 0; occupied.clear();
    const start = performance.now(), result = await read();
    console.info(JSON.stringify({ size, former, visits: visitors.length * 156, candidateShare, surface, ms: Math.round(performance.now() - start), queries, peak }));
    return result;
  };
  try {
    const settings = createGymSettingsAccessor({ scope, clock });
    const attendance = createAttendanceQueries({ scope, clock, settings });
    const ranks = createRanksService({ scope, clock, settings, criteria: createPromotionCriteria(attendance) });
    const dashboard = createDashboardService({ members: createMembersService({ scope, clock }), ranks, notSeen: createNotSeenRead(scope) });
    const billing = createBillingDashboardService({ settings, scope });
    const context = { gymId, clock, roles: ['owner'] as const };
    await createNotSeenRead(scope)(context);
    const unseen = await measure('not_seen', () => createNotSeenRead(scope)(context));
    expect(unseen.count).toBe(size);
    const [mat, money] = await measure('full_page', () => Promise.all([dashboard.get(context), billing.get(context)]));
    expect(queries).toBe(12); // mat: count/page, unseen, settings, snapshot x4, counts, visits; billing: settings + aggregate
    expect(peak).toBeLessThanOrEqual(2);
    // Three simultaneous staff page loads leave at least two of the eight app connections available.
    await measure('three_pages', () => Promise.all(Array.from({ length: 3 }, () => Promise.all([dashboard.get(context), billing.get(context)]))));
    expect(peak).toBeLessThanOrEqual(6);
    expect(mat.data.widgets.find(widget => widget.id === 'promotion_ready')).toHaveProperty('count', candidateCount);
    expect(money.data.widgets.find(widget => widget.id === 'mrr')).toHaveProperty('money.amountCents', size * 10000);
    if (size === 1000) {
      const requests = roster.slice(0, candidateCount).map(member => ({
        memberId: member.id, programId: program.id, since: joinedOn.toISOString(),
      }));
      await scope(gymId, tx => explainPromotion(tx, size, candidateShare, former, gymId, requests));
    }
  } finally { await connection.close(); }
}, 120_000);

type PlanTiming = { medianTotalMs: number; medianExecutionMs: number };

async function explainProbeCap(tx: Transaction, size: number, programVisitors: number, candidateCount: number,
  gymId: string, requests: readonly PromotionAttendanceRequest[]) {
  const variants = [
    { name: 'statement', read: () => promotionAttendanceStatement(tx, gymId, requests, until, false).statement,
      samples: [] as { totalMs: number; executionMs: number }[] },
    { name: 'exact_probe', read: () => promotionAttendanceForcedRead(tx, gymId, requests, until, false, 'exact_probe'),
      samples: [] as { totalMs: number; executionMs: number }[] },
    { name: 'candidate_join', read: () => promotionAttendanceForcedRead(tx, gymId, requests, until, false, 'candidate_join'),
      samples: [] as { totalMs: number; executionMs: number }[] },
  ];
  // Warm all plans, then alternate their order. Wall time includes the visitor probe.
  for (let round = 0; round < 11; round++) {
    for (const { name, read, samples } of round % 2 ? [...variants].reverse() : variants) {
      const started = performance.now();
      const query = read();
      // eslint-disable-next-line database/system-tables -- App-role EXPLAIN with the query's bound values.
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, buffers) ${query}`);
      const totalMs = performance.now() - started;
      const plan = rows.map(row => row['QUERY PLAN']);
      const executionMs = Number(plan.at(-1)!.match(/Execution Time: ([\d.]+) ms/)![1]);
      if (round > 1) samples.push({ totalMs, executionMs });
      if (round === 10) console.info(name + ' ' + JSON.stringify({ members: size, programVisitors, candidates: candidateCount }) + '\n' + plan.join('\n'));
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const medians = new Map<string, PlanTiming>(variants.map(({ name, samples }) => [name, {
    medianTotalMs: median(samples.map(sample => sample.totalMs)),
    medianExecutionMs: median(samples.map(sample => sample.executionMs)),
  }]));
  for (const [plan, timing] of medians) console.info(JSON.stringify({ members: size, programVisitors, candidates: candidateCount, plan, ...timing }));
  return medians;
}

const maxAttendanceLoops = (plan: readonly string[]) => Math.max(0, ...plan.filter(line => line.includes('attendances'))
  .flatMap(line => [...line.matchAll(/loops=(\d+)/g)].map(match => Number(match[1]))));

it.each([
  { members: 5000, programVisitors: 20, candidates: 10 },
  { members: 5000, programVisitors: 10, candidates: 10 },
])('bounds the visitor probe for $members members and $programVisitors program visitors', async ({ members: size, programVisitors, candidates: candidateCount }) => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const home = await factory('households', gymId);
  const system = await factory('rankSystems', gymId);
  const program = await factory('programs', gymId, { rankSystemId: system.id });
  const otherProgram = await factory('programs', gymId);
  const rank = await factory('ranks', gymId, { rankSystemId: system.id, criteria: [
    { providerId: 'classes-since-promotion', config: { target: 1 } },
  ] });
  const roster = await database.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: size }, (_, index) => ({
    gymId, householdId: home.id, firstName: 'Member', lastName: String(index).padStart(4, '0'),
    status: 'active', createdAt: joinedOn,
  }))).returning());
  const visiting = roster.slice(size - programVisitors);
  const candidates = visiting.slice(0, candidateCount);
  const candidateIds = new Set(candidates.map(member => member.id));
  const atFinalRank = roster.filter(member => !candidateIds.has(member.id));
  await database.forGym(gymId, tx => tx.insert(memberRanks).values(atFinalRank.map(member => ({
    gymId, memberId: member.id, programId: program.id, rankId: rank.id, rankSystemId: system.id,
    promotedAt: new Date('2026-10-01Z'),
  }))));
  const visitingIds = new Set(visiting.map(member => member.id));
  const others = roster.filter(member => !visitingIds.has(member.id));
  for (let week = 0; week < 156; week++) await database.forGym(gymId, tx => tx.insert(attendances).values(visiting.map(member => ({
    gymId, memberId: member.id, programId: program.id, kind: 'class', source: 'import',
    occurredAt: new Date(Date.parse('2023-10-01Z') + week * 7 * 86400000),
  }))));
  for (let week = 0; week < 52; week++) await database.forGym(gymId, tx => tx.insert(attendances).values(others.map(member => ({
    gymId, memberId: member.id, programId: otherProgram.id, kind: 'class', source: 'import',
    occurredAt: new Date(Date.parse('2025-11-02Z') + week * 7 * 86400000),
  }))));
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try { await maintenance.sql`analyze attendances`; } finally { await maintenance.close(); }
  const requests = candidates.map(member => ({ memberId: member.id, programId: program.id, since: joinedOn.toISOString() }));
  const choices = await database.forGym(gymId, tx =>
    // eslint-disable-next-line database/system-tables -- Inspect the same plan choice the attendance statement uses.
    tx.execute<{ scan_program: boolean }>(promotionAttendanceScanChoices(tx, gymId, requests, until, false)));
  expect(choices.map(row => row.scan_program)).toEqual([false]);
  const counts = await countPromotionAttendance(database.forGym, gymId, requests, until, false);
  expect(requests.map(request => counts.get(promotionAttendanceKey(request)))).toEqual(candidates.map(() => 156));
  const medians = await database.forGym(gymId, async tx => {
    const explain = async (query: SQL) => {
      // eslint-disable-next-line database/system-tables -- App-role EXPLAIN with the query's bound values.
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, buffers) ${query}`);
      return rows.map(row => row['QUERY PLAN']);
    };
    if (programVisitors === 20) {
      const cappedLoops = maxAttendanceLoops(await explain(promotionAttendanceScanChoices(tx, gymId, requests, until, false)));
      const baselineLoops = maxAttendanceLoops(await explain(promotionAttendanceExactProbeChoices(tx, gymId, requests, until, false)));
      console.info(JSON.stringify({ members: size, programVisitors, candidates: candidateCount, cappedLoops, baselineLoops }));
      expect(cappedLoops).toBeLessThanOrEqual(52);
      expect(baselineLoops).toBeGreaterThan(4_000);
    }
    return explainProbeCap(tx, size, programVisitors, candidateCount, gymId, requests);
  });
  expect(medians.get('statement')!.medianExecutionMs)
    .toBeLessThanOrEqual(medians.get('exact_probe')!.medianExecutionMs * 0.25);
}, 240_000);
