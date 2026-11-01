// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { localDate } from '@plaingym/shared/time';
import { demoPlans } from './billing.js';
import { demoHouseholds } from './members.js';
import { fixture, snapshot as rowsOf } from './billing.fixture.test-helper.js';

const db = useTestDatabase();
const snapshot = (gymId: string) => rowsOf(db, gymId);

describe('demo billing seed', { timeout: 90_000 }, () => {
  it('overlaps at most three card preparations and waits for all preparations before charging', async () => {
    const f = await fixture(db), original = f.gateway.seedCard.getMockImplementation()!;
    let release!: () => void, filled!: () => void, active = 0, maximum = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Settled by the third preparation to start: how long that takes depends on the machine's load, so nothing polls for it.
    const three = new Promise<void>(resolve => { filled = resolve; });
    f.gateway.seedCard.mockImplementation(async (...args) => {
      active++; maximum = Math.max(maximum, active);
      if (active === 3) filled();
      try { await gate; return await original(...args); } finally { active--; }
    });
    const run = f.seed.run(f.context);
    // A seed that ends or fails before three preparations overlap fails the test now, not at its timeout.
    const ended = new Promise<never>((_, reject) => { run.then(() => reject(new Error('The seed ended before three preparations overlapped')), reject); });
    ended.catch(() => {});
    await Promise.race([three, ended]);
    expect(active).toBe(3);
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
});
