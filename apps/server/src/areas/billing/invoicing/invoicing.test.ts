// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { invoiceDetailSchema } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { FakeMembershipLifecycle } from '../../../core/interfaces/membership-lifecycle.js';
import type { MembershipSnapshot } from '../../../core/interfaces/membership-lifecycle.js';
import {
  calculateCycleInvoice, calculateFirstPeriod, calculateOneOffInvoice, calendarDaysBetween,
  nextBillingDate, previousBillingDate,
} from './index.js';
import type { AppliedTaxRate, CalculatedInvoice, CycleInvoiceInput, FirstPeriodInput, PricedMembership } from './index.js';

const id = (n: number) => '00000000-0000-7000-8000-' + n.toString().padStart(12, '0');
const householdId = id(1);
const membership = (overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot => ({
  id: id(10), householdId, memberId: id(20), planId: id(30), interval: 'monthly', status: 'active',
  startsOn: '2026-01-01', nextDueOn: '2026-03-01', amountCents: 10_000, currency: 'CAD',
  trialEndsOn: null, commitmentEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, revision: 3,
  ...overrides,
});
const priced = (overrides: Partial<MembershipSnapshot> = {}, taxRates: readonly AppliedTaxRate[] = []): PricedMembership => ({
  membership: membership(overrides), description: 'Monthly membership', taxRates,
});
const tax = (rateMillionths: number, inclusive = false, n = 50): AppliedTaxRate => ({
  id: id(n), name: 'Tax ' + n, rateMillionths, inclusive,
});
const cycle = (overrides: Partial<CycleInvoiceInput> = {}): CycleInvoiceInput => ({
  householdId, currency: 'CAD', billingDay: 1, familyDiscountBasisPoints: 0, discountDescription: 'Family discount',
  dueOn: '2026-03-01', memberships: [priced()], ...overrides,
});
const first = (overrides: Partial<FirstPeriodInput> = {}): FirstPeriodInput => ({
  householdId, currency: 'CAD', billingDay: 1, familyDiscountBasisPoints: 0, discountDescription: 'Family discount',
  ...priced({ startsOn: '2026-03-16', nextDueOn: '2026-04-01', amountCents: 3_100, status: 'pending' }),
  firstPeriod: 'prorate_now', ...overrides,
});
function invoice(input = cycle()): CalculatedInvoice {
  const result = calculateCycleInvoice(input).invoice;
  expect(result).not.toBeNull();
  return result!;
}
function checkContract(calculated: CalculatedInvoice): void {
  const invoiceId = id(90);
  const createdAt = '2026-03-01T12:00:00Z';
  const { lineItems, ...fields } = calculated;
  expect(() => invoiceDetailSchema.parse({
    invoice: { ...fields, id: invoiceId, createdAt, status: 'draft', number: null,
      paidAt: null, needsReview: false, disputeId: null, disputeStatus: null },
    lineItems: lineItems.map((line, index) => ({ ...line, id: id(100 + index), invoiceId, householdId, createdAt })),
    payments: [], refunds: [],
  })).not.toThrow();
  expect(lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(calculated.amountCents);
}

describe('household cycles', () => {
  it('consolidates only active memberships due on the exact date, with independent next dates', () => {
    const input = cycle({ memberships: [
      priced({ id: id(12), amountCents: 120_000, interval: 'annual', startsOn: '2025-03-01' }),
      priced(), priced({ id: id(11), amountCents: 5_000 }),
      priced({ id: id(13), status: 'frozen', resumesOn: '2026-03-02' }),
      priced({ id: id(14), nextDueOn: '2026-03-02' }),
      priced({ id: id(15), nextDueOn: '2026-02-01' }),
      priced({ id: id(16), status: 'pending' }), priced({ id: id(17), status: 'trial' }),
      priced({ id: id(18), status: 'cancelled' }),
    ] });
    const result = calculateCycleInvoice(input);
    expect(result.invoice).toMatchObject({ householdId, kind: 'cycle', dueOn: '2026-03-01',
      periodStartsOn: '2026-03-01', periodEndsOn: '2027-03-01', amountCents: 135_000, currency: 'CAD' });
    expect(result.invoice!.lineItems.map((line) => line.membershipId)).toEqual([id(10), id(11), id(12)]);
    expect(result.nextDueDates).toEqual([
      { membershipId: id(10), expectedRevision: 3, previousDueOn: '2026-03-01', nextDueOn: '2026-04-01', skipped: false },
      { membershipId: id(11), expectedRevision: 3, previousDueOn: '2026-03-01', nextDueOn: '2026-04-01', skipped: false },
      { membershipId: id(12), expectedRevision: 3, previousDueOn: '2026-03-01', nextDueOn: '2027-03-01', skipped: false },
      { membershipId: id(13), expectedRevision: 3, previousDueOn: '2026-03-01', nextDueOn: '2026-04-01', skipped: true },
    ]);
    checkContract(result.invoice!);
  });
  it.each(['pending', 'trial', 'cancelled'] as const)('does not bill or advance %s memberships', (status) => {
    expect(calculateCycleInvoice(cycle({ memberships: [priced({ status })] }))).toEqual({ invoice: null, nextDueDates: [] });
  });
  it.each([null, '2026-03-01'])('advances a frozen month without an invoice (resume %s)', (resumesOn) => {
    const result = calculateCycleInvoice(cycle({ dueOn: '2026-02-28', billingDay: 31,
      memberships: [priced({ status: 'frozen', nextDueOn: '2026-02-28', resumesOn })] }));
    expect(result.invoice).toBeNull();
    expect(result.nextDueDates).toMatchObject([{ nextDueOn: '2026-03-31', skipped: true }]);
  });
  it.each(['2026-02-20', '2026-02-28'])('leaves a cycle owed after an overdue resume (%s) for the lifecycle to resume', (resumesOn) => {
    expect(calculateCycleInvoice(cycle({ dueOn: '2026-02-28', billingDay: 31,
      memberships: [priced({ status: 'frozen', nextDueOn: '2026-02-28', resumesOn })] }))).toEqual({ invoice: null, nextDueDates: [] });
  });
  it('handles an empty household without creating an empty invoice', () => {
    expect(calculateCycleInvoice(cycle({ memberships: [] }))).toEqual({ invoice: null, nextDueDates: [] });
  });
  it.each([0, 500, 1_000, 10_000])('applies a %i basis-point discount before tax', (discount) => {
    const result = invoice(cycle({ familyDiscountBasisPoints: discount, memberships: [priced({}, [tax(130_000)])] }));
    const expected = new Map([[0, 11_300], [500, 10_735], [1_000, 10_170], [10_000, 0]]);
    expect(result.amountCents).toBe(expected.get(discount));
    const reduction = result.lineItems.filter((line) => line.kind === 'discount');
    expect(reduction.map((line) => line.amountCents)).toEqual(discount ? [-discount] : []);
    checkContract(result);
  });
  it('rounds the household discount once and assigns its odd cent deterministically', () => {
    const items = [priced({ id: id(11), amountCents: 1 }), priced({ amountCents: 1 })];
    const result = invoice(cycle({ familyDiscountBasisPoints: 5_000, memberships: items }));
    expect(result.amountCents).toBe(1);
    expect(result.lineItems.filter((line) => line.kind === 'discount')).toMatchObject([{ membershipId: id(10), amountCents: -1 }]);
    expect(invoice(cycle({ familyDiscountBasisPoints: 5_000, memberships: items.toReversed() }))).toEqual(result);
  });
  it('allocates a discount across differently taxed memberships before computing each tax', () => {
    const result = invoice(cycle({ familyDiscountBasisPoints: 1_000,
      memberships: [priced({ amountCents: 10_000 }, [tax(50_000)]), priced({ id: id(11), amountCents: 20_000 }, [tax(130_000, false, 51)])] }));
    expect(result.amountCents).toBe(29_790);
    expect(result.lineItems.filter((line) => line.kind === 'tax').map((line) => line.amountCents)).toEqual([450, 2_340]);
    checkContract(result);
  });
  it('keeps imported annual renewals on their own date rather than the household billing day', () => {
    const result = calculateCycleInvoice(cycle({ dueOn: '2026-06-19', billingDay: 31,
      memberships: [priced({ interval: 'annual', startsOn: '2025-01-03', nextDueOn: '2026-06-19' })] }));
    expect(result.nextDueDates[0]?.nextDueOn).toBe('2027-06-19');
  });
  it('keeps an imported annual renewal when its day differs within the original start month', () => {
    const result = calculateCycleInvoice(cycle({ dueOn: '2026-06-19', billingDay: 31,
      memberships: [priced({ interval: 'annual', startsOn: '2025-06-03', nextDueOn: '2026-06-19' })] }));
    expect(result.nextDueDates[0]?.nextDueOn).toBe('2027-06-19');
  });
  it('uses the frozen lifecycle snapshots without changing them or the pricing inputs', async () => {
    const gymId = id(200);
    const lifecycle = new FakeMembershipLifecycle([
      { id: id(30), gymId, interval: 'monthly', amountCents: 10_000, currency: 'CAD', commitmentMonths: null },
    ], [{ id: id(20), gymId, householdId }]);
    const context = { gymId, actor: { kind: 'system' as const } };
    const assigned = await lifecycle.assign(context, { id: id(10), memberId: id(20), householdId, planId: id(30),
      startsOn: '2026-01-01', nextDueOn: '2026-03-01', firstPeriod: 'next_billing_date' });
    const active = await lifecycle.activate(context, { membershipId: assigned.id, revision: assigned.revision });
    const item = { membership: active, description: 'Membership', taxRates: [tax(50_000)] };
    const input = cycle({ memberships: [item] });
    const before = structuredClone(input);
    Object.freeze(active); Object.freeze(item.taxRates[0]); Object.freeze(item.taxRates); Object.freeze(item); Object.freeze(input.memberships); Object.freeze(input);
    const result = calculateCycleInvoice(input);
    expect(result.invoice?.amountCents).toBe(10_500);
    result.invoice!.lineItems[0]!.description = 'Changed output';
    expect(input).toEqual(before);
    expect(await lifecycle.get(gymId, active.id)).toEqual(active);
  });
  it.each(['CAD', 'USD', 'EUR', 'JPY'])('carries explicit %s integer cents through every line', (currency) => {
    const result = invoice(cycle({ currency, memberships: [priced({ currency }, [tax(50_000)])] }));
    expect(result.currency).toBe(currency);
    expect(result.lineItems.every((line) => line.currency === currency && Number.isInteger(line.amountCents))).toBe(true);
    checkContract(result);
  });
});

describe('tax and cents rounding', () => {
  it.each([
    { name: 'exclusive HST', amount: 10_000, rates: [tax(130_000)], base: 10_000, taxes: [1_300], total: 11_300 },
    { name: 'inclusive HST', amount: 11_300, rates: [tax(130_000, true)], base: 10_000, taxes: [1_300], total: 11_300 },
    { name: 'GST and QST without compounding', amount: 10_000, rates: [tax(50_000), tax(99_750, false, 51)], base: 10_000, taxes: [500, 998], total: 11_498 },
    { name: 'several inclusive rates', amount: 11_498, rates: [tax(50_000, true), tax(99_750, true, 51)], base: 10_000, taxes: [500, 998], total: 11_498 },
    { name: 'inclusive and exclusive together', amount: 11_300, rates: [tax(130_000, true), tax(50_000, false, 51)], base: 10_000, taxes: [1_300, 500], total: 11_800 },
    { name: '8.875 percent half cent', amount: 4_000, rates: [tax(88_750)], base: 4_000, taxes: [355], total: 4_355 },
    { name: 'exclusive exact half rounds up', amount: 1, rates: [tax(500_000)], base: 1, taxes: [1], total: 2 },
    { name: 'exclusive below half rounds down', amount: 1, rates: [tax(499_999)], base: 1, taxes: [0], total: 1 },
    { name: 'each exclusive rate rounds separately', amount: 1, rates: [tax(500_000), tax(500_000, false, 51)], base: 1, taxes: [1, 1], total: 3 },
    { name: 'inclusive base exact half rounds up', amount: 1, rates: [tax(1_000_000, true)], base: 1, taxes: [0], total: 1 },
    { name: 'inclusive residual cent uses stable tax order', amount: 1, rates: [tax(1_000_000, true), tax(1_000_000, true, 51)], base: 0, taxes: [1, 0], total: 1 },
    { name: 'zero-rate tax still snapshots', amount: 12_345, rates: [tax(0)], base: 12_345, taxes: [0], total: 12_345 },
    { name: 'zero amount', amount: 0, rates: [tax(130_000, true)], base: 0, taxes: [0], total: 0 },
  ])('$name', ({ amount, rates, base, taxes, total }) => {
    const result = invoice(cycle({ memberships: [priced({ amountCents: amount }, rates)] }));
    expect(result.lineItems[0]?.amountCents).toBe(base);
    expect(result.lineItems.filter((line) => line.kind === 'tax').map((line) => line.amountCents)).toEqual(taxes);
    expect(result.amountCents).toBe(total);
    checkContract(result);
  });
  it('discounts an inclusive quote before extracting tax and adding exclusive tax', () => {
    const result = invoice(cycle({ familyDiscountBasisPoints: 1_000,
      memberships: [priced({ amountCents: 11_300 }, [tax(130_000, true), tax(50_000, false, 51)])] }));
    expect(result.lineItems.map((line) => line.amountCents)).toEqual([10_000, -1_000, 1_170, 450]);
    expect(result.amountCents).toBe(10_620);
  });
  it('snapshots names, rates and treatment independently of later catalog edits', () => {
    const rate = { ...tax(99_750, true), name: 'QST' };
    const result = invoice(cycle({ memberships: [priced({}, [rate])] }));
    rate.name = 'Replacement'; rate.rateMillionths = 0; rate.inclusive = false;
    expect(result.lineItems.find((line) => line.kind === 'tax')).toMatchObject({ description: 'QST', taxRateMillionths: 99_750, taxInclusive: true });
  });
  it('uses integer arithmetic at the PostgreSQL cents limit', () => {
    const result = invoice(cycle({ memberships: [priced({ amountCents: 2_147_483_647 }, [tax(1_000_000, true)])] }));
    expect(result.lineItems.map((line) => line.amountCents)).toEqual([1_073_741_824, 1_073_741_823]);
    expect(result.amountCents).toBe(2_147_483_647);
    checkContract(result);
  });
  it('reconciles every cent for small inclusive quotes, discounts and multiple tax rates', () => {
    for (let amount = 0; amount <= 50; amount++) {
      for (const discount of [0, 3333, 5000, 10_000]) {
        const result = invoice(cycle({ familyDiscountBasisPoints: discount,
          memberships: [priced({ amountCents: amount }, [tax(50_000, true), tax(99_750, true, 51)])] }));
        expect(result.amountCents).toBe(amount - Math.floor((amount * discount + 5_000) / 10_000));
        checkContract(result);
      }
    }
  });
});

describe('billing calendar', () => {
  it.each([
    [29, '2025-01-29', '2025-02-28'], [30, '2025-01-30', '2025-02-28'], [31, '2025-01-31', '2025-02-28'],
    [29, '2024-01-29', '2024-02-29'], [30, '2024-01-30', '2024-02-29'], [31, '2024-01-31', '2024-02-29'],
    [29, '2025-02-28', '2025-03-29'], [30, '2025-02-28', '2025-03-30'], [31, '2025-02-28', '2025-03-31'],
    [31, '2026-03-31', '2026-04-30'], [31, '2026-04-30', '2026-05-31'], [31, '2026-12-31', '2027-01-31'],
  ] as const)('anchor %i: %s → %s', (anchor, dueOn, expected) => {
    expect(nextBillingDate({ dueOn, interval: 'monthly', billingDay: anchor })).toBe(expected);
    expect(previousBillingDate({ dueOn: expected, interval: 'monthly', billingDay: anchor })).toBe(dueOn);
  });
  it.each([
    ['2026-06-19', '2025-06-19', '2027-06-19'],
    ['2024-02-29', '2024-02-29', '2025-02-28'],
    ['2025-02-28', '2024-02-29', '2026-02-28'],
    ['2027-02-28', '2024-02-29', '2028-02-29'],
    ['2099-02-28', '2024-02-29', '2100-02-28'],
  ])('annual %s with anniversary %s → %s', (dueOn, annualAnchorOn, expected) => {
    expect(nextBillingDate({ dueOn, annualAnchorOn, interval: 'annual', billingDay: 1 })).toBe(expected);
  });
  it('keeps the Feb 29 anniversary through several annual cycle calculations', () => {
    let item = priced({ interval: 'annual', startsOn: '2024-02-29', nextDueOn: '2024-02-29' });
    for (const expected of ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']) {
      const result = calculateCycleInvoice(cycle({ dueOn: item.membership.nextDueOn, memberships: [item] }));
      expect(result.nextDueDates[0]?.nextDueOn).toBe(expected);
      item = { ...item, membership: { ...item.membership, nextDueOn: expected } };
    }
  });
  it('retains an explicit imported leap-day anniversary independently of the start date', () => {
    let item: PricedMembership = { ...priced({ interval: 'annual', startsOn: '2023-05-12', nextDueOn: '2024-02-29' }),
      annualAnchorOn: '2024-02-29' };
    for (const expected of ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']) {
      const result = calculateCycleInvoice(cycle({ dueOn: item.membership.nextDueOn, memberships: [item] }));
      expect(result.nextDueDates[0]?.nextDueOn).toBe(expected);
      item = { ...item, membership: { ...item.membership, nextDueOn: expected } };
    }
  });
  it.each([
    ['America/Vancouver', '2026-03-09T00:30:00Z', '2026-03-08', '2026-04-08'],
    ['America/Vancouver', '2026-11-01T08:30:00Z', '2026-11-01', '2026-12-01'],
    ['America/Vancouver', '2026-11-01T09:30:00Z', '2026-11-01', '2026-12-01'],
    ['Australia/Sydney', '2026-10-03T16:30:00Z', '2026-10-04', '2026-11-04'],
  ])('uses the gym calendar on a DST boundary in %s (%s)', (timezone, instant, dueOn, nextDueOn) => {
    const date = localDate(new Date(instant), timezone);
    expect(date).toBe(dueOn);
    const result = calculateCycleInvoice(cycle({ dueOn: date, billingDay: Number(dueOn.slice(8)),
      memberships: [priced({ nextDueOn: date })] }));
    expect(result.invoice?.dueOn).toBe(dueOn);
    expect(result.invoice?.amountCents).toBe(10_000);
    expect(result.nextDueDates[0]?.nextDueOn).toBe(nextDueOn);
  });
});

describe('monthly cycles off the household billing day', () => {
  it.each([
    { name: 'trial ended mid-cycle', billingDay: 1, dueOn: '2026-03-10', next: '2026-04-01', total: 2200 },
    { name: 'billing day later in the same month', billingDay: 15, dueOn: '2026-03-10', next: '2026-03-15', total: 554 },
    { name: 'billing day moved earlier', billingDay: 5, dueOn: '2026-03-20', next: '2026-04-05', total: 1600 },
  ])('prorates to the next billing day: $name', ({ billingDay, dueOn, next, total }) => {
    const result = calculateCycleInvoice(cycle({ billingDay, dueOn, memberships: [priced({ nextDueOn: dueOn, amountCents: 3_100 })] }));
    expect(result.nextDueDates).toMatchObject([{ previousDueOn: dueOn, nextDueOn: next, skipped: false }]);
    expect(result.invoice).toMatchObject({ dueOn, periodStartsOn: dueOn, periodEndsOn: next, amountCents: total });
    checkContract(result.invoice!);
  });
  it('bills a clamped short-month date in full', () => {
    const result = calculateCycleInvoice(cycle({ billingDay: 31, dueOn: '2026-02-28', memberships: [priced({ nextDueOn: '2026-02-28', amountCents: 3_100 })] }));
    expect(result.nextDueDates[0]?.nextDueOn).toBe('2026-03-31');
    expect(result.invoice?.amountCents).toBe(3_100);
  });
  it('skips a frozen off-day date to the next billing day', () => {
    const result = calculateCycleInvoice(cycle({ billingDay: 15, dueOn: '2026-03-10', memberships: [priced({ nextDueOn: '2026-03-10', status: 'frozen' })] }));
    expect(result).toMatchObject({ invoice: null, nextDueDates: [{ nextDueOn: '2026-03-15', skipped: true }] });
  });
  it('keeps annual memberships on their own anniversary', () => {
    const result = calculateCycleInvoice(cycle({ billingDay: 1, dueOn: '2026-03-10',
      memberships: [priced({ interval: 'annual', startsOn: '2025-03-10', nextDueOn: '2026-03-10', amountCents: 36_500 })] }));
    expect(result.nextDueDates[0]?.nextDueOn).toBe('2027-03-10');
    expect(result.invoice?.amountCents).toBe(36_500);
  });
});

describe('prorated first periods', () => {
  it.each([
    { name: 'partial month', startsOn: '2026-03-16', nextDueOn: '2026-04-01', amount: 3100, days: 16, period: 31, total: 1600 },
    { name: 'one day', startsOn: '2026-03-31', nextDueOn: '2026-04-01', amount: 3100, days: 1, period: 31, total: 100 },
    { name: 'spring DST month', startsOn: '2026-03-01', nextDueOn: '2026-04-01', amount: 3100, days: 31, period: 31, total: 3100 },
    { name: 'fall DST month', startsOn: '2026-11-01', nextDueOn: '2026-12-01', amount: 3000, days: 30, period: 30, total: 3000 },
    { name: 'half-cent rounds up', startsOn: '2026-04-16', nextDueOn: '2026-05-01', amount: 1, days: 15, period: 30, total: 1 },
    { name: 'below half-cent rounds down', startsOn: '2026-04-17', nextDueOn: '2026-05-01', amount: 1, days: 14, period: 30, total: 0 },
  ])('$name', ({ startsOn, nextDueOn, amount, days, period, total }) => {
    const result = calculateFirstPeriod(first({ ...priced({ startsOn, nextDueOn, amountCents: amount, status: 'pending' }) }));
    expect(result).toMatchObject({ billedDays: days, periodDays: period });
    expect(result.invoice).toMatchObject({ kind: 'one_off', dueOn: startsOn, amountCents: total, periodStartsOn: null, periodEndsOn: null });
    checkContract(result.invoice!);
  });
  it('uses the clamped previous cycle for a 31st anchor', () => {
    const result = calculateFirstPeriod(first({ billingDay: 31,
      ...priced({ startsOn: '2026-03-16', nextDueOn: '2026-03-31', amountCents: 3100 }) }));
    expect(result).toMatchObject({ periodStartsOn: '2026-02-28', periodEndsOn: '2026-03-31', periodDays: 31, billedDays: 15 });
    expect(result.invoice?.amountCents).toBe(1500);
  });
  it('prorates an annual interval by calendar days, including leap day', () => {
    const result = calculateFirstPeriod(first({
      ...priced({ interval: 'annual', startsOn: '2024-02-29', nextDueOn: '2025-01-01', amountCents: 36_600 }),
    }));
    expect(result).toMatchObject({ periodStartsOn: '2024-01-01', periodDays: 366, billedDays: 307 });
    expect(result.invoice?.amountCents).toBe(30_700);
  });
  it('applies the family discount and both tax treatments to the prorated price', () => {
    const result = calculateFirstPeriod(first({ familyDiscountBasisPoints: 1_000,
      ...priced({ startsOn: '2026-04-16', nextDueOn: '2026-05-01', amountCents: 11_300 }, [tax(130_000, true), tax(50_000, false, 51)]) }));
    expect(result.invoice?.lineItems.map((line) => line.amountCents)).toEqual([5000, -500, 585, 225]);
    expect(result.invoice?.amountCents).toBe(5310);
    checkContract(result.invoice!);
  });
  it('does not charge when staff choose the next billing date', () => {
    expect(calculateFirstPeriod(first({ firstPeriod: 'next_billing_date' })).invoice).toBeNull();
  });
  it('does not create a zero-length first-period invoice on the billing date', () => {
    expect(calculateFirstPeriod(first({ ...priced({ startsOn: '2026-04-01', nextDueOn: '2026-04-01' }) }))).toMatchObject({ billedDays: 0, invoice: null });
  });
  it('does not throw for a trial longer than one billing interval', () => {
    const result = calculateFirstPeriod(first({ ...priced({ status: 'trial', startsOn: '2026-01-10', nextDueOn: '2026-03-11', trialEndsOn: '2026-03-11' }) }));
    expect(result).toMatchObject({ invoice: null, billedDays: 0, periodEndsOn: '2026-03-11' });
  });
  it.each(['trial', 'frozen', 'cancelled'] as const)('does not prorate a %s membership', (status) => {
    expect(calculateFirstPeriod(first({ ...priced({ startsOn: '2026-03-16', nextDueOn: '2026-04-01', status }) })).invoice).toBeNull();
  });
});

describe('one-off charges', () => {
  it.each(['charge', 'signup_fee'] as const)('calculates a separate %s invoice', (kind) => {
    const result = calculateOneOffInvoice({ householdId, currency: 'CAD', dueOn: '2026-03-16', charges: [
      { kind, description: 'Sign-up or drop-in', amountCents: 2000, currency: 'CAD', taxRates: [tax(50_000)] },
    ] });
    expect(result).toMatchObject({ kind: 'one_off', amountCents: 2100, periodStartsOn: null, periodEndsOn: null });
    expect(result.lineItems[0]?.kind).toBe(kind);
    checkContract(result);
  });
  it('extends quantities before rounding taxes and produces additive line totals', () => {
    const result = calculateOneOffInvoice({ householdId, currency: 'CAD', dueOn: '2026-03-16', charges: [
      { kind: 'charge', chargeTypeId: id(40), description: 'Three items', amountCents: 1, quantity: 3, currency: 'CAD', taxRates: [tax(500_000)] },
    ] });
    expect(result.lineItems.map((line) => line.amountCents)).toEqual([3, 2]);
    expect(result.lineItems[0]).toMatchObject({ chargeTypeId: id(40), quantity: 1 });
    expect(result.amountCents).toBe(5);
    checkContract(result);
  });
});

describe('invalid billing inputs fail closed', () => {
  it.each([
    ['currency mismatch', cycle({ memberships: [priced({ currency: 'USD' })] })],
    ['household mismatch', cycle({ memberships: [priced({ householdId: id(2) })] })],
    ['duplicate membership', cycle({ memberships: [priced(), priced()] })],
    ['fractional amount', cycle({ memberships: [priced({ amountCents: 1.1 })] })],
    ['negative amount', cycle({ memberships: [priced({ amountCents: -1 })] })],
    ['unsafe amount', cycle({ memberships: [priced({ amountCents: Number.MAX_SAFE_INTEGER })] })],
    ['nonfinite amount', cycle({ memberships: [priced({ amountCents: NaN })] })],
    ['excessive discount', cycle({ familyDiscountBasisPoints: 10_001 })],
    ['negative discount', cycle({ familyDiscountBasisPoints: -1 })],
    ['fractional discount', cycle({ familyDiscountBasisPoints: 0.5 })],
    ['invalid currency', cycle({ currency: 'cad' })],
    ['invalid billing day', cycle({ billingDay: 32 })],
    ['invalid due date', cycle({ dueOn: '2026-02-30' })],
    ['due before start', cycle({ memberships: [priced({ startsOn: '2026-04-01' })] })],
    ['empty description', cycle({ memberships: [{ ...priced(), description: '' }] })],
    ['negative tax', cycle({ memberships: [priced({}, [tax(-1)])] })],
    ['fractional tax', cycle({ memberships: [priced({}, [tax(0.5)])] })],
    ['tax over 100 percent', cycle({ memberships: [priced({}, [tax(1_000_001)])] })],
    ['duplicate tax', cycle({ memberships: [priced({}, [tax(50_000), tax(50_000)])] })],
    ['conflicting tax snapshot', cycle({ memberships: [priced({}, [tax(50_000)]), priced({ id: id(11) }, [tax(60_000)])] })],
    ['tax overflows invoice', cycle({ memberships: [priced({ amountCents: 2_147_483_647 }, [tax(1_000_000)])] })],
    ['household total overflows', cycle({ memberships: [priced({ amountCents: 2_147_483_647 }), priced({ id: id(11) })] })],
  ] as const)('rejects %s', (_name, input) => { expect(() => calculateCycleInvoice(input)).toThrow(); });
  it('rejects a first period longer than the preceding billing interval', () => {
    expect(() => calculateFirstPeriod(first({ ...priced({ startsOn: '2026-01-01', nextDueOn: '2026-04-01' }) }))).toThrow(/before its billing interval/);
  });
  it.each([
    ['2026-04-01', '2026-03-01'], ['2025-01-01', '2027-01-01'], ['2026-02-30', '2026-03-01'],
  ])('rejects invalid calendar difference %s to %s', (start, end) => {
    expect(() => calendarDaysBetween(start, end)).toThrow();
  });
  it('rejects a mismatched annual anchor month', () => {
    expect(() => nextBillingDate({ dueOn: '2026-03-01', interval: 'annual', billingDay: 1, annualAnchorOn: '2025-04-01' })).toThrow();
  });
  it.each([0, -1, 1.5, NaN])('rejects invalid one-off quantity %s', (quantity) => {
    expect(() => calculateOneOffInvoice({ householdId, currency: 'CAD', dueOn: '2026-03-01', charges: [
      { kind: 'charge', description: 'Item', amountCents: 10, currency: 'CAD', quantity, taxRates: [] },
    ] })).toThrow();
  });
  it('rejects one-off invoices without any charges', () => {
    expect(() => calculateOneOffInvoice({ householdId, currency: 'CAD', dueOn: '2026-03-01', charges: [] })).toThrow();
  });
});
