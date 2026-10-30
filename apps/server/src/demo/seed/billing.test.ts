// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { localDate } from '@plaingym/shared/time';
import { createCustomersService } from '../../areas/billing/customers.js';
import { demoPlans } from './billing.js';
import { demoHouseholds } from './members.js';
import { fixture, snapshot as rowsOf } from './billing.fixture.test-helper.js';

const db = useTestDatabase();
const snapshot = (gymId: string) => rowsOf(db, gymId);

describe('demo billing seed', { timeout: 90_000 }, () => {
  it('overlaps at most three card preparations and waits for all preparations before charging', async () => {
    const f = await fixture(db), original = f.gateway.seedCard.getMockImplementation()!;
    let release!: () => void, active = 0, maximum = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.gateway.seedCard.mockImplementation(async (...args) => {
      active++; maximum = Math.max(maximum, active);
      try { await gate; return await original(...args); } finally { active--; }
    });
    const run = f.seed.run(f.context);
    await vi.waitFor(() => expect(active).toBe(3));
    expect((await snapshot(f.gymId)).attempts).toHaveLength(0);
    release(); await run;
    expect(maximum).toBe(3); expect(active).toBe(0);
    expect((await snapshot(f.gymId)).gym.billingEnabled).toBe(false);
  });
  it('creates plans, family invoices, paid history and two past-due households using real billing services', async () => {
    const f = await fixture(db); await f.seed.run(f.context);
    const rows = await snapshot(f.gymId), today = localDate(f.clock.now(), f.context.timezone);
    expect(today).toBe('2026-10-25');
    expect(rows.plans.map(row => row.name).sort()).toEqual(demoPlans.map(row => row.name).sort());
    expect(rows.memberships).toHaveLength(demoHouseholds.flatMap(home => home.members).length);
    expect(new Set(rows.memberships.map(row => row.status))).toEqual(new Set(['active', 'trial', 'pending', 'frozen', 'cancelled']));
    expect(rows.memberships.filter(row => row.status === 'active').every(row => row.nextDueOn > today)).toBe(true);
    expect(rows.memberships.find(row => row.interval === 'annual')?.anniversaryOn).toBe('2026-08-23');
    expect(rows.households).toHaveLength(14); expect(rows.cards).toHaveLength(14);
    expect(rows.households.every(row => row.stripeCustomerId)).toBe(true);
    expect(rows.cards.every(row => row.isDefault && !row.revokedAt && row.processorCreatedAt)).toBe(true);
    expect(rows.cards.filter(row => row.last4 === '0341')).toHaveLength(2);
    const overdue = rows.invoices.filter(row => row.status === 'past_due');
    expect(overdue).toHaveLength(2);
    expect(overdue.map(row => rows.households.find(home => home.id === row.householdId)!.email).sort())
      .toEqual(['murphy@example.invalid', 'oneill@example.invalid']);
    expect(rows.invoices.filter(row => row.status === 'paid').length).toBeGreaterThan(15);
    expect(rows.payments.some(row => row.method === 'card')).toBe(true);
    expect(rows.payments.some(row => row.method === 'cash')).toBe(true);
    expect(rows.invoices.every(row => row.number && row.currency === 'CAD' && !row.needsReview)).toBe(true);
    expect(new Set(rows.invoices.map(row => row.number)).size).toBe(rows.invoices.length);
    const rivera = rows.households.find(row => row.email === 'rivera@example.invalid')!;
    const family = rows.invoices.filter(row => row.householdId === rivera.id);
    expect(family).toHaveLength(3);
    for (const invoice of family) {
      expect(invoice.amountCents).toBe(48000);
      expect(rows.lines.filter(row => row.invoiceId === invoice.id)).toHaveLength(4);
    }
    const retryDays = rows.audit.filter(row => row.action === 'billing.transition.effect.created')
      .map(row => row.after as { kind: string; retryDay?: number }).filter(work => work.kind === 'retry').map(work => work.retryDay).sort();
    expect(retryDays).toEqual([3, 3, 7, 7]);
    expect(f.gateway.createCustomer).toHaveBeenCalledTimes(14);
    for (const call of f.gateway.createCustomer.mock.calls) expect(call[0]).toMatchObject({
      householdId: expect.any(String), email: expect.stringMatching(/@example[.]invalid$/),
      idempotencyKey: expect.stringMatching(/^household:.*:customer$/),
    });
    expect(rows.emails).toHaveLength(0);
    expect(rows.gym.billingEnabled).toBe(false); expect(rows.gym.memberEmailsEnabled).toBe(false);
    expect(rows.audit.some(row => row.action === 'settings.go_live.updated')).toBe(true);
    expect(rows.audit.every(row => row.actorKind === 'system' && row.gymId === f.gymId)).toBe(true);
  });

  it('is unchanged on rerun even a month later and never changes another gym', async () => {
    const other = await fixture(db), f = await fixture(db);
    await other.seed.run(other.context); const otherBefore = await snapshot(other.gymId);
    await f.seed.run(f.context); const before = await snapshot(f.gymId);
    f.clock.advance(32 * 86_400_000); await f.seed.run(f.context);
    expect(await snapshot(f.gymId)).toEqual(before); expect(await snapshot(other.gymId)).toEqual(otherBefore);
    expect(f.gateway.createCustomer).toHaveBeenCalledTimes(14); expect(f.gateway.seedCard).toHaveBeenCalledTimes(14);
    const customer = createCustomersService({ scope: db.forGym, clock: f.clock, paymentsFor: async () => f.gateway.payments });
    await expect(customer.ensureCustomer(f.gymId, otherBefore.households[0]!.id)).rejects.toMatchObject({ code: 'not_found' });
    f.gateway.payments.seedCustomer({ id: 'cus_foreign', email: 'foreign@example.invalid', gymId: other.gymId });
    await expect(f.gateway.payments.adoptCustomer('cus_foreign')).rejects.toThrow(/another gym/);
  });
});
