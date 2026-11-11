// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { invoiceDetailSchema } from '@plaingym/shared/contracts';
import type { BillingInterval, Currency } from '@plaingym/shared/contracts';
import { localDate, zonedInstant } from '@plaingym/shared/time';
import type { MembershipSnapshot } from '../../../core/interfaces/membership-lifecycle.js';
import { calculateFirstPeriod, calculatePlanChange } from './index.js';
import type { AppliedTaxRate, CalculatedInvoice, PlanChangeInput, PlanChangeTarget } from './index.js';

const id = (n: number) => '00000000-0000-7000-8000-' + n.toString().padStart(12, '0');
const householdId = id(1);
const membershipId = id(10);
const currentPlanId = id(30);
const newPlanId = id(31);
const membership = (overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot => ({
  id: membershipId, householdId, memberId: id(20), planId: currentPlanId, interval: 'monthly', status: 'active',
  startsOn: '2026-01-01', nextDueOn: '2026-04-01', amountCents: 10_000, currency: 'CAD',
  trialEndsOn: null, commitmentEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, revision: 3,
  ...overrides,
});
const plan = (overrides: Partial<PlanChangeTarget> = {}): PlanChangeTarget => ({
  id: newPlanId, amountCents: 13_100, currency: 'CAD', interval: 'monthly', description: 'Gold, rest of this period',
  taxRates: [], ...overrides,
});
type ChangeOverrides = Partial<Omit<PlanChangeInput, 'membership' | 'newPlan'>> & {
  readonly membership?: Partial<MembershipSnapshot>;
  readonly plan?: Partial<PlanChangeTarget>;
};
const change = ({ membership: current = {}, plan: next = {}, ...overrides }: ChangeOverrides = {}): PlanChangeInput => ({
  householdId, currency: 'CAD', billingDay: 1, familyDiscountBasisPoints: 0, discountDescription: 'Family discount',
  changeOn: '2026-03-16', ...overrides, membership: membership(current), newPlan: plan(next),
});
const tax = (rateMillionths: number, inclusive = false, n = 50): AppliedTaxRate => ({
  id: id(n), name: 'Tax ' + n, rateMillionths, inclusive,
});
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
  for (const line of lineItems) expect(Number.isSafeInteger(line.amountCents)).toBe(true);
  expect(lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(calculated.amountCents);
}
function charged(input: PlanChangeInput): CalculatedInvoice {
  const result = calculatePlanChange(input);
  expect(result.invoice).not.toBeNull();
  checkContract(result.invoice!);
  return result.invoice!;
}
const amounts = (calculated: CalculatedInvoice) => calculated.lineItems.map((line) => line.amountCents);

describe('the days a plan change prorates', () => {
  // The current price is 10,000; the difference is chosen so one day is a round amount where it can be.
  it.each([
    { name: 'day 29 of a 31-day month', nextDueOn: '2026-04-01', changeOn: '2026-03-29', difference: 3_100,
      periodStartsOn: '2026-03-01', days: 3, period: 31, total: 300 },
    { name: 'day 30 of a 31-day month', nextDueOn: '2026-04-01', changeOn: '2026-03-30', difference: 3_100,
      periodStartsOn: '2026-03-01', days: 2, period: 31, total: 200 },
    { name: 'day 31 of a 31-day month, the period\'s last day', nextDueOn: '2026-04-01', changeOn: '2026-03-31', difference: 3_100,
      periodStartsOn: '2026-03-01', days: 1, period: 31, total: 100 },
    { name: 'the period\'s first day, the whole difference', nextDueOn: '2026-04-01', changeOn: '2026-03-01', difference: 3_100,
      periodStartsOn: '2026-03-01', days: 31, period: 31, total: 3_100 },
    { name: 'February 28 in a non-leap year', nextDueOn: '2026-03-01', changeOn: '2026-02-28', difference: 2_800,
      periodStartsOn: '2026-02-01', days: 1, period: 28, total: 100 },
    { name: 'February 28 in a leap year', startsOn: '2027-01-01', nextDueOn: '2028-03-01', changeOn: '2028-02-28', difference: 2_900,
      periodStartsOn: '2028-02-01', days: 2, period: 29, total: 200 },
    { name: 'February 29 in a leap year', startsOn: '2027-01-01', nextDueOn: '2028-03-01', changeOn: '2028-02-29', difference: 2_900,
      periodStartsOn: '2028-02-01', days: 1, period: 29, total: 100 },
    { name: 'day 28 of a 30-day month', nextDueOn: '2026-05-01', changeOn: '2026-04-28', difference: 3_000,
      periodStartsOn: '2026-04-01', days: 3, period: 30, total: 300 },
    { name: 'day 29 of a 30-day month', nextDueOn: '2026-05-01', changeOn: '2026-04-29', difference: 3_000,
      periodStartsOn: '2026-04-01', days: 2, period: 30, total: 200 },
    { name: 'day 30 of a 30-day month', nextDueOn: '2026-05-01', changeOn: '2026-04-30', difference: 3_000,
      periodStartsOn: '2026-04-01', days: 1, period: 30, total: 100 },
    { name: 'billing day 31 due on February 28', billingDay: 31, startsOn: '2025-12-31', nextDueOn: '2026-02-28',
      changeOn: '2026-02-27', difference: 2_800, periodStartsOn: '2026-01-31', days: 1, period: 28, total: 100 },
    { name: 'billing day 31 from a clamped February 28', billingDay: 31, nextDueOn: '2026-03-31', changeOn: '2026-03-16',
      difference: 3_100, periodStartsOn: '2026-02-28', days: 15, period: 31, total: 1_500 },
    { name: 'billing day 31 in a 30-day month', billingDay: 31, nextDueOn: '2026-04-30', changeOn: '2026-04-29',
      difference: 3_000, periodStartsOn: '2026-03-31', days: 1, period: 30, total: 100 },
    { name: 'billing day 31 from a leap February 29', billingDay: 31, startsOn: '2027-01-01', nextDueOn: '2028-03-31',
      changeOn: '2028-02-29', difference: 3_100, periodStartsOn: '2028-02-29', days: 31, period: 31, total: 3_100 },
    // Due off the household's billing day (left by a changed billing day): the month before closes on its own day.
    { name: 'an off-day monthly membership', nextDueOn: '2026-04-10', changeOn: '2026-03-25', difference: 3_100,
      periodStartsOn: '2026-03-10', days: 16, period: 31, total: 1_600 },
    { name: 'an off-day monthly membership clamped into February', nextDueOn: '2026-03-30', changeOn: '2026-03-20',
      difference: 3_000, periodStartsOn: '2026-02-28', days: 10, period: 30, total: 1_000 },
    { name: 'an annual February 29 anniversary renewed on February 28', interval: 'annual' as const, startsOn: '2024-02-29',
      nextDueOn: '2026-02-28', changeOn: '2026-01-29', difference: 36_500, periodStartsOn: '2025-02-28', days: 30, period: 365, total: 3_000 },
    { name: 'an annual February 29 anniversary in a leap year, its last day', interval: 'annual' as const, startsOn: '2024-02-29',
      nextDueOn: '2028-02-29', changeOn: '2028-02-28', difference: 36_600, periodStartsOn: '2027-02-28', days: 1, period: 366, total: 100 },
    { name: 'an annual February 29 anniversary in a leap year, its first day', interval: 'annual' as const, startsOn: '2024-02-29',
      nextDueOn: '2028-02-29', changeOn: '2027-02-28', difference: 36_600, periodStartsOn: '2027-02-28', days: 366, period: 366, total: 36_600 },
  ])('$name', ({ billingDay = 1, interval = 'monthly' as BillingInterval, startsOn = '2026-01-01', nextDueOn, changeOn,
    difference, periodStartsOn, days, period, total }) => {
    const result = calculatePlanChange(change({ billingDay, changeOn,
      membership: { interval, startsOn, nextDueOn }, plan: { interval, amountCents: 10_000 + difference } }));
    expect(result).toMatchObject({ periodStartsOn, periodEndsOn: nextDueOn, billedDays: days, periodDays: period });
    expect(result.invoice).toMatchObject({ householdId, kind: 'one_off', dueOn: changeOn, periodStartsOn: null, periodEndsOn: null,
      amountCents: total, currency: 'CAD' });
    checkContract(result.invoice!);
  });
  it('uses an imported annual anniversary when one is supplied', () => {
    // From 2024-02-29 the period before 2025-02-28 has 365 days; from 2024-02-28 it would have 366 (199 a day, not 200).
    const terms: ChangeOverrides = { changeOn: '2025-02-27',
      membership: { interval: 'annual', startsOn: '2023-06-01', nextDueOn: '2025-02-28' }, plan: { interval: 'annual', amountCents: 83_000 } };
    const input = change({ ...terms, annualAnchorOn: '2024-02-29' });
    expect(calculatePlanChange(input)).toMatchObject({ periodStartsOn: '2024-02-29', periodDays: 365, billedDays: 1 });
    expect(charged(input).amountCents).toBe(200);
    const defaulted = change(terms);
    expect(calculatePlanChange(defaulted)).toMatchObject({ periodStartsOn: '2024-02-28', periodDays: 366, billedDays: 1 });
    expect(charged(defaulted).amountCents).toBe(199);
  });
  it('counts the days from the start of a membership that starts after the change', () => {
    const result = calculatePlanChange(change({ changeOn: '2026-03-10', membership: { status: 'pending', startsOn: '2026-03-16' } }));
    expect(result).toMatchObject({ billedDays: 16, periodDays: 31 });
    expect(result.invoice).toMatchObject({ dueOn: '2026-03-10', amountCents: 1_600 });
  });
  it('charges the difference from a custom current price, not from the current plan\'s price', () => {
    expect(charged(change({ changeOn: '2026-03-01', membership: { amountCents: 9_000 } })).amountCents).toBe(4_100);
  });
  it('rounds the prorated difference once, half a cent upward', () => {
    // 15 of 30 days of 1 cent is half a cent: 1. 14 of 30 days is less than half: nothing to charge.
    const input = (changeOn: string) => change({ changeOn, membership: { nextDueOn: '2026-05-01' }, plan: { amountCents: 10_001 } });
    expect(charged(input('2026-04-16')).amountCents).toBe(1);
    expect(calculatePlanChange(input('2026-04-17'))).toMatchObject({ billedDays: 0, periodDays: 30, invoice: null });
  });
});

describe('plan changes that charge nothing', () => {
  it.each([
    { name: 'a change on the due date', changeOn: '2026-04-01', amountCents: 13_100 },
    { name: 'a change after the due date', changeOn: '2026-04-15', amountCents: 13_100 },
    { name: 'an equal price', changeOn: '2026-03-16', amountCents: 10_000 },
    { name: 'a lower price', changeOn: '2026-03-16', amountCents: 9_999 },
    { name: 'a free plan', changeOn: '2026-03-16', amountCents: 0 },
  ])('$name', ({ changeOn, amountCents }) => {
    expect(calculatePlanChange(change({ changeOn, plan: { amountCents } }))).toEqual({
      periodStartsOn: '2026-03-01', periodEndsOn: '2026-04-01', periodDays: 31, billedDays: 0, invoice: null });
  });
  it.each(['trial', 'frozen', 'cancelled'] as const)('a %s membership', (status) => {
    expect(calculatePlanChange(change({ membership: { status } }))).toMatchObject({ billedDays: 0, invoice: null });
  });
  it('a trial longer than one billing interval', () => {
    const input = change({ changeOn: '2026-01-20', membership: { status: 'trial', startsOn: '2026-01-10', nextDueOn: '2026-03-11' } });
    expect(calculatePlanChange(input)).toMatchObject({ billedDays: 0, invoice: null });
  });
});

describe('plan changes across daylight saving time', () => {
  // The caller takes changeOn from the clock with localDate; 23:30 and 00:30 on a transition day are both that day,
  // and the proration counts calendar days, never hours.
  it.each([
    { timezone: 'America/New_York', date: '2026-03-08', early: '2026-03-08T05:30:00Z', late: '2026-03-09T03:30:00Z',
      nextDueOn: '2026-04-01', difference: 3_100, days: 24, period: 31, total: 2_400 },
    { timezone: 'America/New_York', date: '2026-11-01', early: '2026-11-01T04:30:00Z', late: '2026-11-02T04:30:00Z',
      nextDueOn: '2026-12-01', difference: 3_000, days: 30, period: 30, total: 3_000 },
    { timezone: 'Europe/Berlin', date: '2026-03-29', early: '2026-03-28T23:30:00Z', late: '2026-03-29T21:30:00Z',
      nextDueOn: '2026-04-01', difference: 3_100, days: 3, period: 31, total: 300 },
    { timezone: 'Europe/Berlin', date: '2026-10-25', early: '2026-10-24T22:30:00Z', late: '2026-10-25T22:30:00Z',
      nextDueOn: '2026-11-01', difference: 3_100, days: 7, period: 31, total: 700 },
  ])('$timezone on $date', ({ timezone, date, early, late, nextDueOn, difference, days, period, total }) => {
    expect(zonedInstant(date, '00:30', timezone, { gap: 'skip' })?.toISOString()).toBe(new Date(early).toISOString());
    expect(zonedInstant(date, '23:30', timezone, { gap: 'skip' })?.toISOString()).toBe(new Date(late).toISOString());
    for (const instant of [early, late]) {
      const changeOn = localDate(new Date(instant), timezone);
      expect(changeOn).toBe(date);
      const result = calculatePlanChange(change({ changeOn, membership: { startsOn: '2026-01-01', nextDueOn },
        plan: { amountCents: 10_000 + difference } }));
      expect(result).toMatchObject({ billedDays: days, periodDays: period });
      expect(result.invoice).toMatchObject({ dueOn: date, amountCents: total });
    }
  });
});

describe('plan change discount and taxes', () => {
  // A difference of 11,300 for 15 of 30 days is 5,650, as in the first-period quote of the same amount.
  const quote = (overrides: ChangeOverrides = {}) => change({ changeOn: '2026-04-16', ...overrides,
    membership: { nextDueOn: '2026-05-01', ...overrides.membership }, plan: { amountCents: 21_300, ...overrides.plan } });
  it.each([
    { name: 'no tax', taxRates: [], discount: 0, lines: [5_650], total: 5_650 },
    { name: 'an exclusive tax', taxRates: [tax(130_000)], discount: 0, lines: [5_650, 735], total: 6_385 },
    { name: 'an inclusive tax', taxRates: [tax(130_000, true)], discount: 0, lines: [5_000, 650], total: 5_650 },
    { name: 'two exclusive taxes, never compounded', taxRates: [tax(99_750, false, 52), tax(50_000, false, 51)], discount: 0,
      lines: [5_650, 283, 564], total: 6_497 },
    { name: 'the household discount', taxRates: [], discount: 1_500, lines: [5_650, -848], total: 4_802 },
    { name: 'the household discount, an inclusive and an exclusive tax', taxRates: [tax(130_000, true), tax(50_000, false, 51)],
      discount: 1_000, lines: [5_000, -500, 585, 225], total: 5_310 },
  ])('$name', ({ taxRates, discount, lines, total }) => {
    const calculated = charged(quote({ familyDiscountBasisPoints: discount, plan: { taxRates } }));
    expect(amounts(calculated)).toEqual(lines);
    expect(calculated.amountCents).toBe(total);
  });
  it('quotes the difference exactly as a first period of the new plan, but due on the change date', () => {
    const taxRates = [tax(130_000, true), tax(50_000, false, 51)];
    const calculated = charged(quote({ familyDiscountBasisPoints: 1_000, plan: { taxRates } }));
    const first = calculateFirstPeriod({ householdId, currency: 'CAD', billingDay: 1, familyDiscountBasisPoints: 1_000,
      discountDescription: 'Family discount', firstPeriod: 'prorate_now', description: 'Gold, rest of this period', taxRates,
      membership: membership({ status: 'pending', startsOn: '2026-04-16', nextDueOn: '2026-05-01', amountCents: 11_300, planId: newPlanId }) });
    expect(calculated).toEqual({ ...first.invoice, dueOn: '2026-04-16' });
  });
  it('records the membership and the new plan on the priced line, and no plan on its discount and tax lines', () => {
    const calculated = charged(quote({ familyDiscountBasisPoints: 1_000, plan: { taxRates: [tax(130_000, true), tax(50_000, false, 51)] } }));
    expect(calculated.lineItems.map((line) => [line.kind, line.membershipId, line.planId, line.description])).toEqual([
      ['membership', membershipId, newPlanId, 'Gold, rest of this period'],
      ['discount', membershipId, null, 'Family discount'],
      ['tax', membershipId, null, 'Tax 50'],
      ['tax', membershipId, null, 'Tax 51'],
    ]);
    expect(calculated.lineItems.find((line) => line.kind === 'tax' && line.taxRateId === id(50))).toMatchObject({
      taxRateMillionths: 130_000, taxInclusive: true });
  });
});

describe('plan change currencies', () => {
  const onStep = (calculated: CalculatedInvoice, step: number) => {
    for (const line of calculated.lineItems) expect(Math.abs(line.amountCents % step), line.kind + ' ' + line.amountCents).toBe(0);
    expect(calculated.amountCents % step).toBe(0);
  };
  const inCurrency = (currency: Currency, current: number, next: number, overrides: ChangeOverrides = {}) => change({
    currency, ...overrides, membership: { currency, amountCents: current, ...overrides.membership },
    plan: { currency, amountCents: next, ...overrides.plan } });
  it.each([
    // JPY has no minor unit: 10 of 31 days of 1,000 yen is 322.58, so 323; 10 % on top is 32.3, so 32.
    { currency: 'JPY' as const, step: 1, current: 8_000, next: 9_000, lines: [323, 32], total: 355 },
    // ISK charges in whole krónur written with two decimals: 10 of 31 days of 5,000 ISK is 1,612.90, so 1,613 ISK;
    // 11 % of it is 177.43, so 177 ISK.
    { currency: 'ISK' as const, step: 100, current: 1_000_000, next: 1_500_000, lines: [161_300, 17_700], total: 179_000 },
    // KWD charges with a last digit of 0: 10 of 31 days of 25.000 KWD is 8.0645, so 8.060; 11 % of it is 0.8866, so 0.890.
    { currency: 'KWD' as const, step: 10, current: 25_000, next: 50_000, lines: [8_060, 890], total: 8_950 },
  ])('$currency lands every line on its step of $step', ({ currency, step, current, next, lines, total }) => {
    const calculated = charged(inCurrency(currency, current, next, { changeOn: '2026-03-22', plan: { taxRates: [tax(currency === 'JPY' ? 100_000 : 110_000)] } }));
    expect(amounts(calculated)).toEqual(lines);
    expect(calculated.amountCents).toBe(total);
    onStep(calculated, step);
  });
  it('lands a KWD household discount and tax on the step', () => {
    // 16 of 31 days of 25.000 KWD is 12.9032, so 12.900; 12.5 % of it is 1.6125, so 1.610; 5 % of 11.290 is 0.5645, so 0.560.
    const calculated = charged(inCurrency('KWD', 25_000, 50_000, { familyDiscountBasisPoints: 1_250, plan: { taxRates: [tax(50_000)] } }));
    expect(amounts(calculated)).toEqual([12_900, -1_610, 560]);
    expect(calculated.amountCents).toBe(11_850);
    onStep(calculated, 10);
  });
  it('lands an ISK difference from a custom price stored off the step on the step', () => {
    // 20,000.00 − 12,345.67 ISK is 7,654.33 ISK for the whole period, charged as 7,654 ISK.
    const calculated = charged(inCurrency('ISK', 1_234_567, 2_000_000, { changeOn: '2026-03-01' }));
    expect(amounts(calculated)).toEqual([765_400]);
    onStep(calculated, 100);
  });
});

describe('plan change amounts stay within integer cents', () => {
  it('prorates the largest price with integer arithmetic', () => {
    // 2,147,483,647 for 1 of 365 days is 5,883,516.84, so 5,883,517.
    const input = change({ changeOn: '2026-02-27', membership: { interval: 'annual', startsOn: '2025-02-28', nextDueOn: '2026-02-28', amountCents: 0 },
      plan: { interval: 'annual', amountCents: 2_147_483_647 } });
    expect(charged(input).amountCents).toBe(5_883_517);
    expect(charged({ ...input, changeOn: '2025-02-28' }).amountCents).toBe(2_147_483_647);
  });
  it('refuses a total past the integer cents limit', () => {
    expect(() => calculatePlanChange(change({ changeOn: '2026-03-01', membership: { amountCents: 0 },
      plan: { amountCents: 2_147_483_647, taxRates: [tax(10_000)] } }))).toThrow(RangeError);
  });
});

describe('invalid plan changes fail closed', () => {
  it.each([
    { name: 'a change of billing interval with a higher price', overrides: { plan: { interval: 'annual' as const, amountCents: 120_000 } } },
    { name: 'a change of billing interval with a lower price', overrides: { plan: { interval: 'annual' as const, amountCents: 1_000 } } },
    { name: 'an unknown interval', overrides: { plan: { interval: 'weekly' as unknown as BillingInterval } } },
    { name: 'a plan in another currency', overrides: { plan: { currency: 'USD' as const } } },
    { name: 'a negative price', overrides: { plan: { amountCents: -1 } } },
    { name: 'a fractional price', overrides: { plan: { amountCents: 10_000.5 } } },
    { name: 'a price past the integer cents limit', overrides: { plan: { amountCents: 2_147_483_648 } } },
    { name: 'an invalid plan ID', overrides: { plan: { id: 'plan-1' } } },
    { name: 'an empty description', overrides: { plan: { description: ' ' } } },
    { name: 'a February 29 in a non-leap year', overrides: { changeOn: '2026-02-29' } },
    { name: 'a change before the current period', overrides: { changeOn: '2026-02-15' } },
    { name: 'a membership of another household', overrides: { membership: { householdId: id(2) } } },
    { name: 'a membership in another currency', overrides: { membership: { currency: 'USD' as const } } },
    { name: 'an invalid family discount', overrides: { familyDiscountBasisPoints: 10_001 } },
  ])('$name', ({ overrides }) => {
    expect(() => calculatePlanChange(change(overrides as ChangeOverrides))).toThrow();
  });
  it('does not mutate its input', () => {
    const input = change({ familyDiscountBasisPoints: 1_000, plan: { taxRates: [tax(130_000, true), tax(50_000, false, 51)] } });
    const before = structuredClone(input);
    charged(input);
    expect(input).toEqual(before);
  });
});
