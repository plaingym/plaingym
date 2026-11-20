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
import { createAttendanceQueries, predicate } from '../attendance/attendance.js';
import { promotionAttendanceRead, type PromotionAttendanceRequest } from '../attendance/promotion.query.js';
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

// The previous whole-program batch, for comparison on the same runner and fixture.
function wholeProgramRead(tx: Transaction, gymId: string, programId: string, requests: readonly PromotionAttendanceRequest[]): SQL {
  const windows = JSON.stringify(requests.map(({ memberId, since }) => ({ member_id: memberId, program_id: programId, since })));
  return sql`
    with eligible as materialized (
      select ${attendances.id} as id, ${attendances.memberId} as member_id,
        ${attendances.occurredAt} as occurred_at, ${programId}::uuid as program_id
      from ${attendances} where ${predicate(tx, gymId, { programId, until, excludeOpenMat: true })}
    )
    select c.member_id, c.program_id, c.since, count(e.id)::integer as total
    from jsonb_to_recordset(${windows}::jsonb) as c(member_id uuid, program_id uuid, since timestamptz)
    left join eligible e on e.member_id = c.member_id and e.program_id = c.program_id and e.occurred_at >= c.since
    group by c.member_id, c.program_id, c.since
  `;
}

async function explainPromotion(tx: Transaction, size: number, candidateShare: number, gymId: string,
  requests: readonly PromotionAttendanceRequest[], programId: string) {
  const variants = [
    { name: 'before', read: wholeProgramRead(tx, gymId, programId, requests), samples: [] as number[] },
    { name: 'after', read: promotionAttendanceRead(tx, gymId, requests, until, false, size), samples: [] as number[] },
  ];
  // Warm both plans and alternate their order so neither always runs first.
  for (let round = 0; round < 6; round++) {
    for (const { name, read, samples } of round % 2 ? [...variants].reverse() : variants) {
      // eslint-disable-next-line database/system-tables -- App-role EXPLAIN with the query's bound values.
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, buffers) ${read}`);
      const plan = rows.map(row => row['QUERY PLAN']);
      if (round > 0) samples.push(Number(plan.at(-1)!.match(/Execution Time: ([\d.]+) ms/)![1]));
      if (round === 5) console.info(name + ' ' + candidateShare + '%\n' + plan.join('\n'));
    }
  }
  for (const { name, samples } of variants) {
    const ms = samples.sort((a, b) => a - b)[2];
    console.info(JSON.stringify({ size, visits: size * 156, candidateShare, plan: name, medianExecutionMs: ms }));
  }
}

it.each([
  { size: 300, candidateShare: 100 },
  { size: 1000, candidateShare: 100 },
  { size: 1000, candidateShare: 10 },
])('measures an owner page at $size members with $candidateShare% promotion candidates', async ({ size, candidateShare }) => {
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
  const candidateCount = size * candidateShare / 100;
  const atFinalRank = roster.slice(candidateCount);
  if (atFinalRank.length) await database.forGym(gymId, tx => tx.insert(memberRanks).values(atFinalRank.map(member => ({
    gymId, memberId: member.id, programId: program.id, rankId: rank.id, rankSystemId: system.id,
    promotedAt: new Date('2026-10-01Z'),
  }))));
  await database.forGym(gymId, tx => tx.insert(memberships).values(roster.map(member => ({ gymId,
    householdId: home.id, memberId: member.id, planId: plan.id, status: 'active', amountCents: 10000,
    currency: 'USD', interval: 'monthly', startsOn: '2023-01-01', nextDueOn: '2026-11-01' }))));
  for (let week = 0; week < 156; week++) await database.forGym(gymId, tx => tx.insert(attendances).values(roster.map(member => ({
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
    console.info(JSON.stringify({ size, visits: size * 156, candidateShare, surface, ms: Math.round(performance.now() - start), queries, peak }));
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
      await scope(gymId, tx => explainPromotion(tx, size, candidateShare, gymId, requests, program.id));
    }
  } finally { await connection.close(); }
}, 120_000);
