// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { attendances, members, memberships, uuidv7 } from '@plaingym/db';
// Test-only app-role pool: measure both endpoints sharing production's eight connections.
// eslint-disable-next-line no-restricted-imports, database/system-tables
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createMembersService } from '../members/members.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService } from '../billing/memberships.js';
import { createPaymentService } from '../billing/payments.js';
import { createDashboardService } from './dashboard.js';
import { createBillingDashboardService } from './billing.js';
import { createNotSeenRead } from './not-seen.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T12:00:00Z');
it.each([300, 1000])('measures an owner page load and three years of weekly visits at %i members', async size => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled: true });
  const home = await factory('households', gymId), plan = await factory('plans', gymId);
  const system = await factory('rankSystems', gymId);
  const program = await factory('programs', gymId, { rankSystemId: system.id });
  await factory('ranks', gymId, { rankSystemId: system.id, criteria: [
    { providerId: 'classes-since-promotion', config: { target: 1 } },
  ] });
  const roster = await database.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: size }, (_, index) => ({
    gymId, householdId: home.id, firstName: 'Member', lastName: String(index).padStart(4, '0'),
    status: 'active', createdAt: new Date('2023-01-01Z'),
  }))).returning());
  await database.forGym(gymId, tx => tx.insert(memberships).values(roster.map(member => ({ gymId,
    householdId: home.id, memberId: member.id, planId: plan.id, status: 'active', amountCents: 10000,
    currency: 'USD', interval: 'monthly', startsOn: '2023-01-01', nextDueOn: '2026-11-01' }))));
  for (let week = 0; week < 156; week++) await database.forGym(gymId, tx => tx.insert(attendances).values(roster.map(member => ({
    gymId, memberId: member.id, programId: program.id, kind: 'class', source: 'import',
    occurredAt: new Date(Date.parse('2023-10-01Z') + week * 7 * 86400000),
  }))));
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
    console.info(JSON.stringify({ size, visits: size * 156, surface, ms: Math.round(performance.now() - start), queries, peak }));
    return result;
  };
  try {
    const settings = createGymSettingsAccessor({ scope, clock });
    const attendance = createAttendanceQueries({ scope, clock, settings });
    const ranks = createRanksService({ scope, clock, settings, criteria: createPromotionCriteria(attendance) });
    const dashboard = createDashboardService({ members: createMembersService({ scope, clock }), ranks, attendance, notSeen: createNotSeenRead(scope) });
    const billing = createBillingDashboardService({ settings, scope,
      memberships: createMembershipService({ scope, clock, settings }), payments: createPaymentService({ scope, clock, settings }) });
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
    expect(mat.data.widgets.find(widget => widget.id === 'promotion_ready')).toHaveProperty('count', size);
    expect(money.data.widgets.find(widget => widget.id === 'mrr')).toHaveProperty('money.amountCents', size * 10000);
  } finally { await connection.close(); }
}, 120_000);
