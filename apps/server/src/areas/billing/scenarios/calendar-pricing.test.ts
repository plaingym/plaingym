// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { localDate } from '@plaingym/shared/time';
import { calculateFirstPeriod, calculateOneOffInvoice } from '../invoicing/index.js';
import { billingFixture, invoiceDetail } from './fixture.js';

const db = useTestDatabase();

describe('billing scenarios: persisted catalog and lifecycle → invoice calculation', () => {
  it.each([
    ['2027-01-31', '2027-02-28', '2027-03-31'],
    ['2028-01-31', '2028-02-29', '2028-03-31'],
    ['2028-12-31', '2029-01-31', '2029-02-28'],
  ])('retains the household 31st anchor across %s → %s → %s', async (start, second, third) => {
    const f = await billingFixture(db);
    let member = await f.assign(await f.plan(), { startsOn: start, nextDueOn: start });
    for (const [due, next] of [[start, second], [second, third]]) {
      f.clock.set(due + 'T20:00:00Z');
      const result = await f.cycle();
      expect(invoiceDetail(result.invoice, f.clock).invoice).toMatchObject({ dueOn: due, amountCents: 10_000, periodEndsOn: next });
      expect(result.nextDueDates).toEqual([{ membershipId: member.id, expectedRevision: member.revision,
        previousDueOn: due, nextDueOn: next, skipped: false }]);
      // Exercise the existing revision-checked lifecycle. This does not simulate issuing an invoice.
      member = await f.lifecycle.update(f.context, { membershipId: member.id, revision: member.revision, nextDueOn: next });
    }
  });

  it.each([
    ['America/New_York', '2028-03-10T04:59:59Z', '2028-03-10T05:00:00Z'],
    ['Asia/Tokyo', '2028-03-09T14:59:59Z', '2028-03-09T15:00:00Z'],
  ])('ends a free trial on the %s calendar date and prorates to the household day', async (timezone, before, after) => {
    const f = await billingFixture(db, { timezone, billingDay: 1, now: before });
    await f.assign(await f.plan({ amountCents: 3100 }), { startsOn: '2028-03-01', nextDueOn: '2028-04-01' });
    const trial = await f.assign(await f.plan({ amountCents: 3100, trialDays: 7 }), {
      startsOn: '2028-03-03', nextDueOn: '2028-03-10', initialStatus: 'trial', firstPeriod: 'prorate_now',
    });
    const first = calculateFirstPeriod({ ...await f.pricing(), ...await f.priced(trial.id), firstPeriod: 'prorate_now' });
    expect(first.invoice).toBeNull();
    expect(await f.membershipService.processDates(f.gymId, timezone)).toBe(0);
    expect((await f.cycle()).invoice).toBeNull();
    f.clock.set(after);
    expect(localDate(f.clock.now(), timezone)).toBe('2028-03-10');
    expect(await f.membershipService.processDates(f.gymId, timezone)).toBe(1);
    const result = await f.cycle();
    expect(invoiceDetail(result.invoice, f.clock).invoice).toMatchObject({ amountCents: 2200, periodEndsOn: '2028-04-01' });
    expect(result.nextDueDates).toMatchObject([{ membershipId: trial.id, nextDueOn: '2028-04-01' }]);
  });

  it('consolidates a family by exact due date while annual renewals retain their own date', async () => {
    const f = await billingFixture(db), monthly = await f.plan();
    await f.assign(monthly); await f.assign(monthly);
    const annual = await f.assign(await f.plan({ interval: 'annual', amountCents: 120_000 }), {
      startsOn: '2027-01-03', nextDueOn: '2028-06-19',
    });
    expect(invoiceDetail((await f.cycle()).invoice, f.clock).invoice.amountCents).toBe(20_000);
    f.clock.set('2028-06-19T19:00:00Z');
    const renewal = await f.cycle();
    expect(invoiceDetail(renewal.invoice, f.clock).lineItems).toMatchObject([{ membershipId: annual.id, amountCents: 120_000 }]);
    expect(renewal.nextDueDates).toMatchObject([{ membershipId: annual.id, nextDueOn: '2029-06-19' }]);
  });

  it('excludes a frozen, cancelled and pending sibling while resuming the frozen sibling on its date', async () => {
    const f = await billingFixture(db), plan = await f.plan();
    const active = await f.assign(plan), frozen = await f.assign(plan), cancelled = await f.assign(plan);
    await f.assign(plan, { initialStatus: 'pending' });
    await f.lifecycle.freeze(f.context, { membershipId: frozen.id, revision: frozen.revision, resumesOn: '2028-03-15' });
    await f.lifecycle.cancel(f.context, { membershipId: cancelled.id, revision: cancelled.revision });
    expect(invoiceDetail((await f.cycle()).invoice, f.clock).lineItems.map(line => line.membershipId)).toEqual([active.id]);
    f.clock.set('2028-03-15T19:00:00Z');
    expect(await f.membershipService.processDates(f.gymId, f.timezone)).toBe(1);
    f.clock.set('2028-03-31T19:00:00Z');
    expect(invoiceDetail((await f.cycle()).invoice, f.clock).lineItems.map(line => line.membershipId)).toEqual([frozen.id]);
  });

  it.each(['prorate_now', 'next_billing_date'] as const)('adds a sibling with %s, keeping the sign-up fee separate', async firstPeriod => {
    const f = await billingFixture(db, { billingDay: 1, discount: 1000, now: '2028-03-16T19:00:00Z' });
    const plan = await f.plan({ amountCents: 3100, signupFeeCents: 2500 });
    await f.assign(plan, { startsOn: '2028-03-01', nextDueOn: '2028-04-01' });
    const sibling = await f.assign(plan, { startsOn: '2028-03-16', nextDueOn: '2028-04-01', firstPeriod, initialStatus: 'pending' });
    const first = calculateFirstPeriod({ ...await f.pricing(), ...await f.priced(sibling.id), firstPeriod });
    if (firstPeriod === 'prorate_now') {
      expect(first).toMatchObject({ billedDays: 16, periodDays: 31 });
      expect(invoiceDetail(first.invoice, f.clock).invoice).toMatchObject({ kind: 'one_off', amountCents: 1440, dueOn: '2028-03-16' });
    } else expect(first.invoice).toBeNull();
    const fee = calculateOneOffInvoice({ householdId: f.home.id, currency: 'CAD', dueOn: '2028-03-16',
      charges: [{ kind: 'signup_fee', membershipId: sibling.id, description: 'Registration',
        amountCents: plan.signupFeeCents, currency: plan.currency, taxRates: [] }] });
    expect(invoiceDetail(fee, f.clock).invoice).toMatchObject({ kind: 'one_off', amountCents: 2500 });
    expect(fee.lineItems.some(line => line.kind === 'discount')).toBe(false);
  });

  it('allocates the family discount before GST and QST, then preserves the calculated receipt after catalog edits', async () => {
    const f = await billingFixture(db, { discount: 1000 });
    const gst = await f.catalog.createTaxRate(f.context, { name: 'GST', rateMillionths: 50_000, inclusive: false });
    const qst = await f.catalog.createTaxRate(f.context, { name: 'QST', rateMillionths: 99_750, inclusive: false });
    const plan = await f.plan({ taxRateIds: [gst.id, qst.id] });
    await f.assign(plan); await f.assign(plan);
    const detail = invoiceDetail((await f.cycle()).invoice, f.clock), saved = structuredClone(detail);
    expect(detail.invoice.amountCents).toBe(20_696); // 2 × (10000 - 1000 + 450 + 898).
    expect(detail.lineItems.filter(line => line.kind === 'discount').map(line => line.amountCents)).toEqual([-1000, -1000]);
    expect(detail.lineItems.filter(line => line.kind === 'tax').map(line => line.amountCents).sort()).toEqual([450, 450, 898, 898]);
    await f.catalog.updateTaxRate(f.context, qst.id, { revision: qst.revision, name: 'Edited tax', rateMillionths: 0, inclusive: true });
    await f.catalog.updatePlan(f.context, plan.id, { revision: plan.revision, amountCents: 20_000 });
    expect(detail).toEqual(saved);
    const future = invoiceDetail((await f.cycle()).invoice, f.clock);
    expect(future.lineItems.filter(line => line.kind === 'membership').map(line => line.amountCents)).toEqual([10_000, 10_000]);
    expect(future.invoice.amountCents).toBe(18_900);
  });

  it('extracts inclusive HST after the family discount before adding exclusive GST', async () => {
    const f = await billingFixture(db, { discount: 1000 });
    const hst = await f.catalog.createTaxRate(f.context, { name: 'Included HST', rateMillionths: 130_000, inclusive: true });
    const gst = await f.catalog.createTaxRate(f.context, { name: 'Additional GST', rateMillionths: 50_000, inclusive: false });
    await f.assign(await f.plan({ amountCents: 11_300, taxRateIds: [hst.id, gst.id] }));
    const detail = invoiceDetail((await f.cycle()).invoice, f.clock);
    expect(detail.invoice.amountCents).toBe(10_620);
    expect(detail.lineItems.filter(line => line.kind === 'tax')).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'Included HST', amountCents: 1170, taxInclusive: true }),
      expect.objectContaining({ description: 'Additional GST', amountCents: 450, taxInclusive: false }),
    ]));
  });

  it('rounds a family half-cent once across siblings and produces a zero total with a full discount', async () => {
    for (const [discount, total, reduction] of [[5000, 1, -1], [10_000, 0, -2]] as const) {
      const f = await billingFixture(db, { discount }), plan = await f.plan({ amountCents: 1 });
      await f.assign(plan); await f.assign(plan);
      const detail = invoiceDetail((await f.cycle()).invoice, f.clock);
      expect(detail.invoice.amountCents).toBe(total);
      expect(detail.lineItems.filter(line => line.kind === 'discount').reduce((sum, line) => sum + line.amountCents, 0)).toBe(reduction);
    }
  });

  it('rejects another household and another gym at the lifecycle boundary before calculating charges', async () => {
    const a = await billingFixture(db), b = await billingFixture(db), plan = await a.plan();
    const member = await a.assign(plan), foreign = await b.assign(await b.plan());
    await expect(a.lifecycle.get(a.gymId, foreign.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.lifecycle.assign(a.context, { id: foreign.id, memberId: member.memberId,
      householdId: foreign.householdId, planId: plan.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31', firstPeriod: 'prorate_now' })).rejects.toMatchObject({ code: 'not_found' });
    const otherHome = await a.factory('households', a.gymId);
    await expect(a.lifecycle.assign(a.context, { id: foreign.id, memberId: member.memberId,
      householdId: otherHome.id, planId: plan.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31', firstPeriod: 'prorate_now' })).rejects.toMatchObject({ code: 'not_found' });
    expect(invoiceDetail((await a.cycle()).invoice, a.clock).invoice.amountCents).toBe(10_000);
  });
});
