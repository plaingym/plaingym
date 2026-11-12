// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { invoiceDetailSchema } from '@plaingym/shared/contracts';
import type { Currency } from '@plaingym/shared/contracts';
import type { MembershipSnapshot } from '../../../core/interfaces/membership-lifecycle.js';
import { calculateCycleInvoice, calculateFirstPeriod, calculatePlanChange } from './index.js';
import type { AppliedTaxRate, CalculatedInvoice, MembershipDiscount, PlanChangeInput, PricedMembership } from './index.js';

const id = (n: number) => '00000000-0000-7000-8000-' + n.toString().padStart(12, '0');
const household = { householdId: id(1), currency: 'CAD' as Currency, billingDay: 1,
  familyDiscountBasisPoints: 0, discountDescription: 'Family discount' };
const percentage = (basisPoints: number): MembershipDiscount => ({ kind: 'percentage', basisPoints, name: 'Student discount' });
const fixed = (amountCents: number): MembershipDiscount => ({ kind: 'fixed', amountCents, name: 'Loyalty discount' });
const member = (overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot => ({
  id: id(10), householdId: id(1), memberId: id(20), planId: id(30), interval: 'monthly', status: 'active',
  startsOn: '2026-01-01', nextDueOn: '2026-04-01', amountCents: 10_000, currency: 'CAD',
  trialEndsOn: null, commitmentEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, revision: 1,
  ...overrides,
});
const priced = (discount?: MembershipDiscount, overrides: Partial<MembershipSnapshot> = {},
  taxRates: readonly AppliedTaxRate[] = []): PricedMembership => ({
  membership: member(overrides), description: 'Membership', taxRates, ...discount === undefined ? {} : { discount },
});
const tax = (inclusive: boolean, n = 50, rateMillionths = 100_000): AppliedTaxRate => ({
  id: id(n), name: 'Tax ' + n, rateMillionths, inclusive,
});
function checked(invoice: CalculatedInvoice | null): CalculatedInvoice {
  expect(invoice).not.toBeNull();
  const { lineItems, ...fields } = invoice!;
  const createdAt = '2026-04-01T12:00:00Z';
  invoiceDetailSchema.parse({ invoice: { ...fields, id: id(90), createdAt, status: 'draft', number: null,
    paidAt: null, needsReview: false, disputeId: null, disputeStatus: null },
  lineItems: lineItems.map((line, index) => ({ ...line, id: id(100 + index), invoiceId: id(90), householdId: id(1), createdAt })),
  payments: [], refunds: [] });
  expect(lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(invoice!.amountCents);
  expect(invoice!.amountCents).toBeGreaterThanOrEqual(0);
  const balances = new Map<string | null, number>();
  for (const line of lineItems) {
    const balance = (balances.get(line.membershipId) ?? 0) + line.amountCents;
    expect(balance).toBeGreaterThanOrEqual(0);
    balances.set(line.membershipId, balance);
    if (line.kind !== 'discount') expect(line.amountCents).toBeGreaterThanOrEqual(0);
    else expect(line.planId).toBeNull();
  }
  return invoice!;
}
const amounts = (invoice: CalculatedInvoice) => invoice.lineItems.map((line) => line.amountCents);
function cycle(item: PricedMembership, familyDiscountBasisPoints = 0): CalculatedInvoice {
  return checked(calculateCycleInvoice({ ...household, currency: item.membership.currency, familyDiscountBasisPoints,
    dueOn: item.membership.nextDueOn, memberships: [item] }).invoice);
}
const change = (overrides: Partial<PlanChangeInput> = {}): PlanChangeInput => ({
  ...household, membership: member(), changeOn: '2026-03-16',
  newPlan: { id: id(31), amountCents: 13_100, currency: 'CAD', interval: 'monthly', description: 'Upgrade', taxRates: [] },
  ...overrides,
});

describe('membership discount quotes', () => {
  it.each([
    { name: 'percentage', discount: percentage(2_000), price: 10_000, lines: [10_000, -2_000], total: 8_000 },
    { name: 'fixed', discount: fixed(1_500), price: 10_000, lines: [10_000, -1_500], total: 8_500 },
    { name: 'a custom membership price', discount: percentage(2_000), price: 8_000, lines: [8_000, -1_600], total: 6_400 },
    { name: 'a fixed amount above the price', discount: fixed(20_000), price: 10_000, lines: [10_000, -10_000], total: 0 },
    { name: '100 percent', discount: percentage(10_000), price: 10_000, lines: [10_000, -10_000], total: 0 },
    { name: 'zero percent', discount: percentage(0), price: 10_000, lines: [10_000], total: 10_000 },
    { name: 'zero fixed', discount: fixed(0), price: 10_000, lines: [10_000], total: 10_000 },
    { name: 'a free membership', discount: fixed(100), price: 0, lines: [0], total: 0 },
  ])('$name', ({ discount, price, lines, total }) => {
    const item = priced(discount, { amountCents: price });
    const before = structuredClone(item);
    const result = cycle(item);
    expect(amounts(result)).toEqual(lines);
    expect(result.amountCents).toBe(total);
    expect(item).toEqual(before);
    for (const line of result.lineItems.filter((line) => line.kind === 'discount')) {
      expect(line).toMatchObject({ membershipId: id(10), description: discount.name, kind: 'discount', planId: null });
    }
  });

  it.each([
    { name: 'exclusive', price: 10_000, taxes: [tax(false)], lines: [10_000, -2_000, 800], total: 8_800, family: 0 },
    { name: 'inclusive', price: 11_000, taxes: [tax(true)], lines: [10_000, -2_000, 800], total: 8_800, family: 0 },
    { name: 'mixed taxes after both discounts', price: 11_000, taxes: [tax(true), tax(false, 51, 50_000)],
      lines: [10_000, -2_000, -800, 720, 360], total: 8_280, family: 1_000 },
  ])('$name tax uses the reduced price', ({ price, taxes, lines, total, family }) => {
    const result = cycle(priced(percentage(2_000), { amountCents: price }, taxes), family);
    expect(amounts(result)).toEqual(lines);
    expect(result.amountCents).toBe(total);
  });

  it.each([true, false])('a fully discounted price leaves zero tax and no family deduction (inclusive %s)', (inclusive) => {
    const result = cycle(priced(fixed(20_000), {}, [tax(inclusive)]), 1_000);
    expect(result.amountCents).toBe(0);
    expect(result.lineItems.filter((line) => line.kind === 'discount')).toHaveLength(1);
    expect(result.lineItems.find((line) => line.kind === 'tax')!.amountCents).toBe(0);
  });

  it.each([
    { discount: fixed(2_000), lines: [10_000, -2_000, -800, 10_000, -1_000], total: 16_200 },
    { discount: percentage(10_000), lines: [10_000, -10_000, 10_000, -1_000], total: 9_000 },
  ])('allocates the family discount from what each membership has left: $total', ({ discount, lines, total }) => {
    const input = { ...household, familyDiscountBasisPoints: 1_000, dueOn: '2026-04-01',
      memberships: [priced(undefined, { id: id(11) }), priced(discount)] };
    const result = checked(calculateCycleInvoice(input).invoice);
    expect(amounts(result)).toEqual(lines);
    expect(result.amountCents).toBe(total);
    expect(result.lineItems.filter((line) => line.kind === 'discount').map((line) => line.description))
      .toEqual(discount.kind === 'fixed' ? ['Loyalty discount', 'Family discount', 'Family discount']
        : ['Student discount', 'Family discount']);
    expect(calculateCycleInvoice({ ...input, memberships: [...input.memberships].reverse() }).invoice).toEqual(result);
  });

  it.each([
    { currency: 'JPY', price: 101, discount: percentage(1_250), lines: [101, -13], step: 1 },
    { currency: 'JPY', price: 101, discount: fixed(13), lines: [101, -13], step: 1 },
    { currency: 'KWD', price: 25_000, discount: percentage(1_250), lines: [25_000, -3_130], step: 10 },
    { currency: 'KWD', price: 25_000, discount: fixed(3_333), lines: [25_000, -3_330], step: 10 },
    { currency: 'ISK', price: 10_000, discount: percentage(1_250), lines: [10_000, -1_300], step: 100 },
    { currency: 'ISK', price: 10_000, discount: fixed(650), lines: [10_000, -700], step: 100 },
  ] as const)('$currency rounds $discount.kind to its charge step', ({ currency, price, discount, lines, step }) => {
    const result = cycle(priced(discount, { currency, amountCents: price }));
    expect(amounts(result)).toEqual(lines);
    for (const line of result.lineItems) expect(Math.abs(line.amountCents % step)).toBe(0);
  });

  it('preserves minor-unit calculations for legacy prices stored off the currency step', () => {
    const result = cycle(priced(percentage(5_000), { currency: 'ISK', amountCents: 190 }, [tax(true)]), 5_000);
    expect(amounts(result)).toEqual([173, -87, -43, 4]);
    expect(result.amountCents).toBe(47);
  });
});

describe('membership discounts on partial periods', () => {
  it.each([
    { name: 'fixed', discount: fixed(620), firstLines: [1_600, -320], stubLines: [2_200, -440] },
    { name: 'percentage', discount: percentage(2_000), firstLines: [1_600, -320], stubLines: [2_200, -440] },
    { name: 'fixed above price', discount: fixed(6_200), firstLines: [1_600, -1_600], stubLines: [2_200, -2_200] },
    { name: '100 percent', discount: percentage(10_000), firstLines: [1_600, -1_600], stubLines: [2_200, -2_200] },
  ])('$name on a first period and off-day stub', ({ discount, firstLines, stubLines }) => {
    const first = calculateFirstPeriod({ ...household, firstPeriod: 'prorate_now',
      ...priced(discount, { startsOn: '2026-03-16', amountCents: 3_100, status: 'pending' }) });
    expect(first).toMatchObject({ billedDays: 16, periodDays: 31 });
    expect(amounts(checked(first.invoice))).toEqual(firstLines);
    const stub = calculateCycleInvoice({ ...household, dueOn: '2026-03-10',
      memberships: [priced(discount, { nextDueOn: '2026-03-10', amountCents: 3_100 })] });
    expect(stub.nextDueDates).toMatchObject([{ nextDueOn: '2026-04-01' }]);
    expect(amounts(checked(stub.invoice))).toEqual(stubLines);
  });

  it.each([
    { currency: 'JPY', price: 3_100, discount: 620, lines: [1_600, -320], step: 1 },
    { currency: 'KWD', price: 25_000, discount: 5_000, lines: [12_900, -2_580], step: 10 },
    { currency: 'ISK', price: 10_000, discount: 2_000, lines: [5_200, -1_000], step: 100 },
  ] as const)('prorates a $currency fixed amount onto the step', ({ currency, price, discount, lines, step }) => {
    const result = checked(calculateFirstPeriod({ ...household, currency, firstPeriod: 'prorate_now',
      ...priced(fixed(discount), { currency, amountCents: price, startsOn: '2026-03-16', status: 'pending' }) }).invoice);
    expect(amounts(result)).toEqual(lines);
    for (const line of result.lineItems) expect(Math.abs(line.amountCents % step)).toBe(0);
  });

  it('prorates an annual fixed amount by the annual period, before family discount and tax', () => {
    const result = calculateFirstPeriod({ ...household, familyDiscountBasisPoints: 1_000, firstPeriod: 'prorate_now',
      ...priced(fixed(3_650), { interval: 'annual', amountCents: 36_500, startsOn: '2026-03-16', status: 'pending' }, [tax(false)]) });
    expect(result).toMatchObject({ billedDays: 16, periodDays: 365 });
    expect(amounts(checked(result.invoice))).toEqual([1_600, -160, -144, 130]);
  });
});

describe('plan changes with membership discounts', () => {
  it.each([
    { name: 'absent', currentDiscount: undefined, newDiscount: undefined, lines: [1_600] },
    { name: 'percentage kept', currentDiscount: percentage(2_000), newDiscount: percentage(2_000), lines: [2_632, -1_352] },
    { name: 'fixed kept', currentDiscount: fixed(620), newDiscount: fixed(620), lines: [1_920, -320] },
    { name: 'percentage ended', currentDiscount: percentage(2_000), newDiscount: undefined, lines: [2_632] },
    { name: 'fixed ended', currentDiscount: fixed(620), newDiscount: undefined, lines: [1_920] },
    { name: 'percentage added', currentDiscount: undefined, newDiscount: percentage(2_000), lines: [1_600, -1_352] },
    { name: 'fixed added', currentDiscount: undefined, newDiscount: fixed(620), lines: [1_600, -320] },
    { name: 'fixed changed', currentDiscount: fixed(620), newDiscount: fixed(1_240), lines: [1_920, -640] },
    { name: 'oversized old fixed ended', currentDiscount: fixed(20_000), newDiscount: undefined, lines: [6_761] },
  ])('$name uses the two sides and prorates the new discount', ({ currentDiscount, newDiscount, lines }) => {
    const input = change({ ...currentDiscount === undefined ? {} : { currentDiscount },
      ...newDiscount === undefined ? {} : { newDiscount } });
    const before = structuredClone(input);
    const result = calculatePlanChange(input);
    expect(result).toMatchObject({ billedDays: 16, periodDays: 31 });
    const invoice = checked(result.invoice);
    expect(amounts(invoice)).toEqual(lines);
    expect(invoice.lineItems[0]).toMatchObject({ membershipId: id(10), planId: id(31), kind: 'membership' });
    for (const line of invoice.lineItems.filter((line) => line.kind === 'discount')) expect(line.description).toBe(newDiscount!.name);
    expect(input).toEqual(before);
  });

  it.each([
    { name: 'a fixed new discount above the new price', currentDiscount: undefined, newDiscount: fixed(20_000) },
    { name: 'a 100 percent new discount', currentDiscount: undefined, newDiscount: percentage(10_000) },
    { name: 'both sides free', currentDiscount: percentage(10_000), newDiscount: percentage(10_000) },
    { name: 'a larger new percentage', currentDiscount: percentage(2_000), newDiscount: percentage(5_000) },
  ])('does not bill $name', ({ currentDiscount, newDiscount }) => {
    expect(calculatePlanChange(change({ ...currentDiscount === undefined ? {} : { currentDiscount }, newDiscount })))
      .toMatchObject({ billedDays: 0, invoice: null });
  });

  it('does not bill an equal effective price', () => {
    const input = change({ newDiscount: percentage(5_000) });
    expect(calculatePlanChange({ ...input, newPlan: { ...input.newPlan, amountCents: 20_000 } }).invoice).toBeNull();
  });

  it('bills a lower sticker price when ending the old discount makes the effective price higher', () => {
    const input = change({ currentDiscount: percentage(2_000) });
    const result = calculatePlanChange({ ...input, newPlan: { ...input.newPlan, amountCents: 9_000 } });
    expect(amounts(checked(result.invoice))).toEqual([516]);
  });

  it('applies the family discount and new taxes after the new membership discount', () => {
    const input = change({ changeOn: '2026-03-01', currentDiscount: percentage(2_000), newDiscount: percentage(2_000),
      familyDiscountBasisPoints: 1_000 });
    const result = checked(calculatePlanChange({ ...input,
      newPlan: { ...input.newPlan, amountCents: 20_000, taxRates: [tax(false)] } }).invoice);
    expect(amounts(result)).toEqual([12_000, -4_000, -800, 720]);
    expect(result.amountCents).toBe(7_920);
  });

  it('does not bill an upgrade from a legacy off-step price that the new discount rounds to nothing', () => {
    const input = change({ currency: 'ISK', changeOn: '2026-03-01', membership: member({ currency: 'ISK', amountCents: 190 }),
      newDiscount: percentage(2_000) });
    expect(calculatePlanChange({ ...input, newPlan: { ...input.newPlan, currency: 'ISK', amountCents: 300 } }).invoice).toBeNull();
  });

  it.each([
    { currency: 'JPY', price: 3_100, discount: 620, lines: [1_920, -320], step: 1 },
    { currency: 'KWD', price: 31_000, discount: 6_200, lines: [19_200, -3_200], step: 10 },
    { currency: 'ISK', price: 31_000, discount: 6_200, lines: [19_200, -3_200], step: 100 },
  ] as const)('keeps a fixed discount on a $currency upgrade', ({ currency, price, discount, lines, step }) => {
    const input = change({ currency, membership: member({ currency, amountCents: price }), currentDiscount: fixed(discount), newDiscount: fixed(discount) });
    const result = checked(calculatePlanChange({ ...input, newPlan: { ...input.newPlan, currency, amountCents: price * 2 } }).invoice);
    expect(amounts(result)).toEqual(lines);
    for (const line of result.lineItems) expect(Math.abs(line.amountCents % step)).toBe(0);
  });
});

describe('invalid membership discounts fail closed', () => {
  it.each([
    percentage(-1), percentage(10_001), percentage(0.5), percentage(Number.NaN),
    fixed(-1), fixed(0.5), fixed(2_147_483_648), fixed(Number.POSITIVE_INFINITY),
    { ...fixed(10), name: ' ' }, { kind: 'unknown', name: 'Invalid discount' } as unknown as MembershipDiscount,
  ])('rejects $kind $name $basisPoints $amountCents', (discount) => {
    expect(() => cycle(priced(discount))).toThrow();
    expect(() => calculateFirstPeriod({ ...household, firstPeriod: 'prorate_now',
      ...priced(discount, { startsOn: '2026-03-16', status: 'pending' }) })).toThrow();
    expect(() => calculatePlanChange(change({ currentDiscount: discount }))).toThrow();
    expect(() => calculatePlanChange(change({ newDiscount: discount }))).toThrow();
  });
});
