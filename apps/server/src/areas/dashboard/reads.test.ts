// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { attendances, members as memberTable, memberships, uuidv7 } from '@plaingym/db';
// Test-only app-role pool matches production's eight connections; every measured read still uses forGym.
// eslint-disable-next-line no-restricted-imports, database/system-tables
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ListResponse, MatDashboardWidget } from '@plaingym/shared/contracts';
import { addDays, localDate } from '@plaingym/shared/time';
import { TestClock } from '../../core/clock.js';
import { createMembersService } from '../members/members.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService } from '../billing/memberships.js';
import { createPaymentService } from '../billing/payments.js';
import { createDashboardService } from './dashboard.js';
import { createBillingDashboardService, type BillingDashboardServices } from './billing.js';
import { createNotSeenRead } from './not-seen.js';
import type { DashboardContext } from './widgets.js';
import type { MatWidgetServices } from './mat.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T12:00:00Z');
async function pages<T>(read: (page: { limit: number; offset: number }) => Promise<ListResponse<T>>) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read({ limit: 100, offset });
    rows.push(...page.data);
    if (!page.data.length || offset + 100 >= page.pagination.total) return rows;
  }
}
/** The former production path is retained as an independent parity oracle. */
function oldNotSeen(services: MatWidgetServices) {
  return async (context: DashboardContext): Promise<Extract<MatDashboardWidget, { id: 'not_seen' }>> => {
    const unseen = [], cutoff = context.clock.now().getTime() - 14 * 86400000;
    for (const member of await pages(page => services.members.listMembers(context.gymId, { ...page, status: 'active' }))) {
      const history = await services.attendance.history({ kind: 'gym', gymId: context.gymId },
        { memberId: member.id, until: new Date(context.clock.now().getTime() + 1).toISOString() }, { limit: 1, offset: 0 });
      const lastSeenAt = history.data[0]?.occurredAt ?? null;
      if (Date.parse(lastSeenAt ?? member.createdAt) <= cutoff)
        unseen.push({ memberId: member.id, firstName: member.firstName, lastName: member.lastName, lastSeenAt });
    }
    return { id: 'not_seen', titleKey: 'dashboard/dashboard:widget.not_seen', status: 'ready', days: 14,
      count: unseen.length, members: unseen.slice(0, 100) };
  };
}
/** Former billing read workload, including settings and all six simultaneous paginated reads. */
async function oldBillingReads(services: BillingDashboardServices, context: DashboardContext) {
  const gym = await services.settings.get(context.gymId);
  const from = localDate(context.clock.now(), gym.timezone), through = addDays(from, 6);
  await Promise.all([
    pages(page => services.memberships.list(context.gymId, { ...page, status: 'active' })),
    pages(page => services.memberships.list(context.gymId, { ...page, dueOnOrBefore: through })),
    pages(page => services.payments.listInvoices(context.gymId, { ...page, status: 'past_due' })),
    pages(page => services.payments.listInvoices(context.gymId, { ...page, status: 'open', dueThrough: addDays(from, -1) })),
    pages(page => services.payments.listInvoices(context.gymId, { ...page, dueFrom: from, dueThrough: through })),
    pages(page => services.payments.listInvoices(context.gymId, { ...page, dispute: 'open' })),
  ]);
}

describe('dashboard grouped reads and pool budget', () => {
  it.each([300, 1000])('matches the old path and measures an eight-connection pool at %i members', async (size) => {
    const gymId = uuidv7(), foreignId = uuidv7();
    await factory('gyms', gymId, { billingEnabled: true }); await factory('gyms', foreignId);
    const home = await factory('households', gymId), plan = await factory('plans', gymId);
    const foreign = await factory('members', foreignId, { status: 'active', firstName: 'Foreign secret', createdAt: new Date('2026-01-01Z') });
    // Long unseen, so a read that crossed gyms would list this member.
    await factory('attendances', foreignId, { memberId: foreign.id, occurredAt: new Date('2026-02-01Z') });
    const roster = await database.forGym(gymId, tx => tx.insert(memberTable).values(Array.from({ length: size }, (_, index) => ({
      gymId, householdId: home.id, firstName: 'Member', lastName: String(index).padStart(4, '0'),
      status: index % 10 === 9 ? 'cancelled' : 'active',
      createdAt: new Date(index % 10 === 8 ? '2026-10-31T12:00:00Z' : '2026-01-01T00:00:00Z'),
    }))).returning());
    await database.forGym(gymId, tx => tx.insert(attendances).values(roster.flatMap((member, index) => {
      // Include older history, future-only history, both visit kinds, and exact +/-1 ms boundaries.
      const dates = [[], ['2026-10-18T12:00:00Z'], ['2026-10-18T12:00:00.001Z'],
        ['2026-10-18T11:59:59.999Z'], ['2026-11-02T12:00:00Z'], ['2026-11-01T12:00:00Z'],
        ['2026-10-01T12:00:00Z', '2026-10-31T12:00:00Z'], [], [], ['2026-10-01T00:00:00Z']][index % 10]!;
      return dates.map(date => ({ gymId, memberId: member.id, kind: index % 2 ? 'class' as const : 'open_mat' as const,
        source: 'coach' as const, occurredAt: new Date(date) }));
    })));
    await database.forGym(gymId, tx => tx.insert(memberships).values(roster.map(member => ({ gymId,
      householdId: home.id, memberId: member.id, planId: plan.id, status: 'active', amountCents: 10000,
      currency: 'USD', interval: 'monthly', startsOn: '2026-01-01', nextDueOn: '2026-11-01' }))));

    const connection = openConnection(database.appUrl, 8), scoped = scopedDatabase(connection.db);
    let queries = 0, peak = 0;
    const occupied = new Set<number>();
    connection.sql.options.debug = (connectionId, query) => {
      if (/^begin/i.test(query)) { occupied.add(connectionId); peak = Math.max(peak, occupied.size); }
      if (/^(commit|rollback)/i.test(query)) occupied.delete(connectionId);
      if (/^select/i.test(query) && !query.includes('set_config')) queries++;
    };
    const measure = async <T>(run: () => Promise<T>) => {
      queries = 0; peak = 0; occupied.clear();
      const start = performance.now(), result = await run();
      return { result, ms: Math.round(performance.now() - start), queries, peak };
    };
    try {
      const scope = scoped.forGym;
      const services: MatWidgetServices = { members: createMembersService({ scope, clock }),
        attendance: createAttendanceQueries({ scope, clock }),
        ranks: { listPrograms: async () => ({ data: [], pagination: { total: 0, limit: 100, offset: 0 } }),
          listRanks: async () => { throw new Error('No programs'); }, eligibility: async () => { throw new Error('No programs'); } } };
      const context = { gymId, clock, roles: ['front_desk'] as const };
      const legacy = createDashboardService({ ...services, notSeen: oldNotSeen(services) });
      const dashboard = createDashboardService({ ...services, notSeen: createNotSeenRead(scope) });
      // Warm both paths before measuring; no time threshold on a shared workstation.
      await legacy.get(context); await dashboard.get(context);
      const before = await measure(() => legacy.get(context)), after = await measure(() => dashboard.get(context));
      expect(after.result).toEqual(before.result);
      expect(after.result.data.widgets.find(widget => widget.id === 'not_seen')).toHaveProperty('count', size / 2);
      expect(after.queries).toBe(3); // member count + first page + grouped last seen, independent of roster size
      expect(after.peak).toBe(1);
      expect(JSON.stringify(after.result)).not.toContain(foreign.id);
      const foreignResult = await createNotSeenRead(scope)({ ...context, gymId: foreignId });
      expect(foreignResult).toMatchObject({ count: 1, members: [{ memberId: foreign.id }] });

      const settings = createGymSettingsAccessor({ scope, clock });
      const billing = { settings, memberships: createMembershipService({ scope, clock, settings }),
        payments: createPaymentService({ scope, clock, settings }) };
      await oldBillingReads(billing, context); await createBillingDashboardService(billing).get(context);
      const billingBefore = await measure(() => oldBillingReads(billing, context));
      const billingAfter = await measure(() => createBillingDashboardService(billing).get(context));
      expect(billingBefore.peak).toBe(6); expect(billingAfter.peak).toBeLessThanOrEqual(2);
      expect(billingAfter.queries).toBe(billingBefore.queries);
      expect(billingAfter.result.data.widgets.some(widget => widget.id === 'disputes')).toBe(false);
      for (const [surface, old, current] of [['mat', before, after], ['billing', billingBefore, billingAfter]] as const)
        console.info(JSON.stringify({ members: size, surface, before: { ms: old.ms, queries: old.queries, peak: old.peak },
          after: { ms: current.ms, queries: current.queries, peak: current.peak } }));
    } finally { await connection.close(); }
  }, 120_000);
});
