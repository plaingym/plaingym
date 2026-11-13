// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { terminalDisputeStatuses, type ListResponse } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService } from '../billing/memberships.js';
import { createPaymentService } from '../billing/payments.js';
import { createBillingDashboardService } from './billing.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T12:00:00Z');
async function pages<T>(read: (input: { limit: number; offset: number }) => Promise<ListResponse<T>>) {
  const result: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read({ limit: 100, offset }); result.push(...page.data);
    if (offset + 100 >= page.pagination.total) return result;
  }
}

it('matches the former six billing reads across statuses, annual rounding, date edges and cycle replacement', async () => {
  const gymId = uuidv7(), foreignId = uuidv7();
  await factory('gyms', gymId, { billingEnabled: true }); await factory('gyms', foreignId);
  const plan = await factory('plans', gymId);
  for (let index = 0; index < 16; index++) {
    const home = await factory('households', gymId), member = await factory('members', gymId, { householdId: home.id });
    const dueOn = ['2026-10-31', '2026-11-01', '2026-11-07', '2026-11-08'][index % 4]!;
    for (let sibling = 0; sibling < 2; sibling++) await factory('memberships', gymId, { householdId: home.id, memberId: member.id,
      planId: plan.id, status: ['active', 'trial', 'frozen', 'cancelled'][Math.floor(index / 4)]!,
      interval: sibling ? 'annual' : 'monthly', amountCents: 101 + index, nextDueOn: dueOn });
    const status = ['draft', 'open', 'past_due', 'paid', 'void', 'processing'][index % 6]!;
    await factory('invoices', gymId, { householdId: home.id, kind: 'cycle', dueOn, status,
      number: status === 'draft' ? null : index + 1, amountCents: index === 6 ? 0 : 500 + index,
      periodStartsOn: '2026-10-01', periodEndsOn: '2026-11-01',
      disputeId: index % 2 ? 'dp_' + index : null, disputeStatus: index % 3 ? null : 'won', needsReview: index % 2 === 0 });
    await factory('invoices', gymId, { householdId: home.id, kind: 'one_off', dueOn, status: 'open', number: 100 + index,
      amountCents: 10 + index, disputeId: index % 2 ? 'dp_extra_' + index : null, disputeStatus: index % 3 ? 'warning_needs_response' : 'lost' });
  }
  await factory('memberships', foreignId, { status: 'active', amountCents: 999999 });
  await factory('invoices', foreignId, { status: 'past_due', number: 1, amountCents: 999999 });
  const scope = database.forGym, settings = createGymSettingsAccessor({ scope, clock });
  const memberships = createMembershipService({ scope, settings, clock }), payments = createPaymentService({ scope, settings, clock });
  const active = await pages(page => memberships.list(gymId, { ...page, status: 'active' }));
  const due = await pages(page => memberships.list(gymId, { ...page, dueOnOrBefore: '2026-11-07' }));
  const overdue = [...await pages(page => payments.listInvoices(gymId, { ...page, status: 'past_due' })),
    ...await pages(page => payments.listInvoices(gymId, { ...page, status: 'open', dueThrough: '2026-10-31' }))]
    .filter(row => row.amountCents > 0);
  const upcomingInvoices = await pages(page => payments.listInvoices(gymId, { ...page, dueFrom: '2026-11-01', dueThrough: '2026-11-07' }));
  const flagged = await pages(page => payments.listInvoices(gymId, { ...page, dispute: 'open' }));
  const disputes = flagged.filter(row => row.disputeId !== null && !new Set<string>(terminalDisputeStatuses).has(row.disputeStatus ?? ''));
  const twelfths = active.reduce((sum, row) => sum + BigInt(row.amountCents) * (row.interval === 'annual' ? 1n : 12n), 0n);
  const upcoming = new Map<string, number>();
  for (const row of due) if (['active', 'trial'].includes(row.status) && row.nextDueOn >= '2026-11-01') {
    const key = row.householdId + ':' + row.nextDueOn;
    upcoming.set(key, (upcoming.get(key) ?? 0) + row.amountCents);
  }
  for (const row of upcomingInvoices) {
    if (row.status === 'draft') continue;
    const key = row.kind === 'cycle' ? row.householdId + ':' + row.dueOn : row.id;
    if (row.kind === 'cycle') upcoming.delete(key);
    if (row.status === 'open') upcoming.set(key, row.amountCents);
  }
  const { data } = await createBillingDashboardService({ scope, settings }).get({ gymId, clock, roles: ['owner'] });
  expect(data.widgets.find(row => row.id === 'mrr')).toHaveProperty('money.amountCents', Number((twelfths + 6n) / 12n));
  expect(data.widgets.find(row => row.id === 'past_due')).toMatchObject({ invoiceCount: overdue.length,
    money: { amountCents: overdue.reduce((sum, row) => sum + row.amountCents, 0) } });
  expect(data.widgets.find(row => row.id === 'upcoming_charges')).toMatchObject({ invoiceCount: upcoming.size,
    money: { amountCents: [...upcoming.values()].reduce((sum, amount) => sum + amount, 0) } });
  expect(data.widgets.find(row => row.id === 'disputes')).toMatchObject({ count: disputes.length,
    money: { amountCents: disputes.reduce((sum, row) => sum + row.amountCents, 0) } });
});
