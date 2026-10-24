// SPDX-License-Identifier: AGPL-3.0-only
import { currencySchema, idSchema } from '@plaingym/shared/contracts';
import type { Currency, Id, Invoice, InvoiceLineItem, IsoDate, TaxRate } from '@plaingym/shared/contracts';
import type { AssignMembership, MembershipSnapshot } from '../../../core/interfaces/membership-lifecycle.js';
import { billingDay, calendarDate, calendarDaysBetween, householdDateOnOrAfter, nextBillingDate, previousBillingDate } from './calendar.js';
import { allocate, cents, checkedCents, nonnegativeInteger, roundRatio } from './money.js';

export { calendarDaysBetween, nextBillingDate, previousBillingDate } from './calendar.js';
export type { BillingCalendar } from './calendar.js';

type WithoutIdentity<T> = T extends unknown ? Omit<T, 'id' | 'createdAt' | 'invoiceId' | 'householdId'> : never;
export type CalculatedLineItem = WithoutIdentity<InvoiceLineItem>;
export interface CalculatedInvoice extends Pick<Invoice,
  'householdId' | 'kind' | 'dueOn' | 'periodStartsOn' | 'periodEndsOn' | 'amountCents' | 'currency'> {
  readonly lineItems: readonly CalculatedLineItem[];
}
export type AppliedTaxRate = Readonly<Pick<TaxRate, 'id' | 'name' | 'rateMillionths' | 'inclusive'>>;
export interface PricedMembership {
  readonly membership: MembershipSnapshot;
  /** Already localized by the caller, snapshotted on the invoice. */
  readonly description: string;
  readonly taxRates: readonly AppliedTaxRate[];
  /** Supply an imported annual anniversary when it differs from startsOn. */
  readonly annualAnchorOn?: IsoDate;
}
interface HouseholdPricing {
  readonly householdId: Id;
  readonly currency: Currency;
  readonly billingDay: number;
  readonly familyDiscountBasisPoints: number;
  /** Already localized by the caller. */
  readonly discountDescription: string;
}
export interface CycleInvoiceInput extends HouseholdPricing {
  readonly dueOn: IsoDate;
  readonly memberships: readonly PricedMembership[];
}
export interface DueDateChange {
  readonly membershipId: Id;
  readonly expectedRevision: number;
  readonly previousDueOn: IsoDate;
  readonly nextDueOn: IsoDate;
  readonly skipped: boolean;
}
export interface CycleInvoiceResult {
  readonly invoice: CalculatedInvoice | null;
  readonly nextDueDates: readonly DueDateChange[];
}
export interface FirstPeriodInput extends HouseholdPricing, PricedMembership {
  readonly firstPeriod: AssignMembership['firstPeriod'];
}
export interface FirstPeriodResult {
  readonly invoice: CalculatedInvoice | null;
  readonly periodStartsOn: IsoDate;
  readonly periodEndsOn: IsoDate;
  readonly billedDays: number;
  readonly periodDays: number;
}
export interface OneOffCharge {
  readonly kind: 'charge' | 'signup_fee';
  readonly description: string;
  readonly amountCents: number;
  readonly currency: Currency;
  readonly quantity?: number;
  readonly membershipId?: Id;
  readonly chargeTypeId?: Id;
  readonly taxRates: readonly AppliedTaxRate[];
}
export interface OneOffInvoiceInput {
  readonly householdId: Id;
  readonly currency: Currency;
  readonly dueOn: IsoDate;
  readonly charges: readonly OneOffCharge[];
}
interface Price {
  readonly kind: 'membership' | 'charge' | 'signup_fee';
  readonly description: string;
  readonly amountCents: number;
  readonly quantity: number;
  readonly currency: Currency;
  readonly membershipId: Id | null;
  readonly chargeTypeId: Id | null;
  readonly taxRates: readonly AppliedTaxRate[];
}

function description(value: string): void {
  if (!value.trim()) throw new RangeError('Invoice descriptions must not be empty');
}
function validateHousehold(input: HouseholdPricing): void {
  idSchema.parse(input.householdId); currencySchema.parse(input.currency);
  billingDay(input.billingDay);
  nonnegativeInteger(input.familyDiscountBasisPoints, 10_000, 'family discount');
  description(input.discountDescription);
}
function validateMembership(input: HouseholdPricing, item: PricedMembership): void {
  const membership = item.membership;
  idSchema.parse(membership.id); idSchema.parse(membership.memberId); idSchema.parse(membership.planId);
  if (membership.householdId !== input.householdId) throw new RangeError('Membership household does not match');
  if (membership.currency !== input.currency) throw new RangeError('Membership currency does not match');
  cents(membership.amountCents); calendarDate(membership.startsOn); calendarDate(membership.nextDueOn);
  if (membership.nextDueOn < membership.startsOn) throw new RangeError('Membership is due before it starts');
  if (!['pending', 'trial', 'active', 'frozen', 'cancelled'].includes(membership.status)) throw new RangeError('Invalid membership status');
  if (!['monthly', 'annual'].includes(membership.interval)) throw new RangeError('Invalid billing interval');
  if (!Number.isInteger(membership.revision) || membership.revision < 1) throw new RangeError('Invalid membership revision');
  description(item.description);
}
function annualAnchor(item: PricedMembership): IsoDate {
  const { startsOn, nextDueOn } = item.membership;
  const clampedLeapAnniversary = startsOn.slice(5) === '02-29' && nextDueOn.slice(5) === '02-28';
  return item.annualAnchorOn ?? (clampedLeapAnniversary ? startsOn : nextDueOn);
}
function calendar(input: HouseholdPricing, item: PricedMembership) {
  return { dueOn: item.membership.nextDueOn, interval: item.membership.interval,
    billingDay: input.billingDay, annualAnchorOn: annualAnchor(item) };
}
function membershipPrice(item: PricedMembership, amountCents = item.membership.amountCents): Price {
  return { kind: 'membership', description: item.description, amountCents, currency: item.membership.currency,
    quantity: 1, membershipId: item.membership.id, chargeTypeId: null, taxRates: item.taxRates };
}
function compareIds(a: { id: Id }, b: { id: Id }): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

/** One exact due date at a time; older dates are separate invocations, oldest first. */
export function calculateCycleInvoice(input: CycleInvoiceInput): CycleInvoiceResult {
  validateHousehold(input); calendarDate(input.dueOn);
  const ids = new Set<Id>();
  for (const item of input.memberships) {
    validateMembership(input, item);
    if (ids.has(item.membership.id)) throw new RangeError('Duplicate membership');
    ids.add(item.membership.id);
  }
  // A frozen membership whose scheduled resume has arrived owes this cycle: leave it (no skip, no charge)
  // for the lifecycle's resume, after which it is billed as active.
  const due = input.memberships.filter(({ membership }) => membership.nextDueOn === input.dueOn &&
    (membership.status === 'active' || membership.status === 'frozen' &&
      (membership.resumesOn === null || membership.resumesOn > input.dueOn)))
    .toSorted((a, b) => compareIds(a.membership, b.membership))
    .map((item) => ({ item, ...cycleTerms(input, item) }));
  const nextDueDates = due.map(({ item, nextDueOn }): DueDateChange => ({
    membershipId: item.membership.id, expectedRevision: item.membership.revision,
    previousDueOn: item.membership.nextDueOn, nextDueOn, skipped: item.membership.status === 'frozen',
  }));
  const active = due.filter(({ item }) => item.membership.status === 'active');
  if (!active.length) return { invoice: null, nextDueDates };
  const periodEndsOn = nextDueDates.filter((change) => !change.skipped)
    .reduce((end, change) => change.nextDueOn > end ? change.nextDueOn : end, input.dueOn);
  return { invoice: { householdId: input.householdId, kind: 'cycle', dueOn: input.dueOn,
    periodStartsOn: input.dueOn, periodEndsOn,
    ...calculatePrices(input.currency, active.map(({ item, amountCents }) => membershipPrice(item, amountCents)),
      input.familyDiscountBasisPoints, input.discountDescription) }, nextDueDates };
}

/**
 * A monthly membership due off the household's billing day (a trial that ended mid-cycle, or a changed
 * billing day) pays only the days up to that day, prorated like a first period, and then joins it.
 */
function cycleTerms(input: HouseholdPricing, item: PricedMembership): { nextDueOn: IsoDate; amountCents: number } {
  const { membership } = item;
  if (membership.interval === 'monthly') {
    const householdDate = householdDateOnOrAfter(membership.nextDueOn, input.billingDay);
    if (householdDate !== membership.nextDueOn) {
      const periodStartsOn = previousBillingDate({ dueOn: householdDate, interval: 'monthly', billingDay: input.billingDay });
      const billedDays = calendarDaysBetween(membership.nextDueOn, householdDate);
      const periodDays = calendarDaysBetween(periodStartsOn, householdDate);
      return { nextDueOn: householdDate,
        amountCents: checkedCents(roundRatio(BigInt(membership.amountCents) * BigInt(billedDays), BigInt(periodDays))) };
    }
  }
  return { nextDueOn: nextBillingDate(calendar(input, item)), amountCents: membership.amountCents };
}

/** A separate first-period invoice, ending exclusively at the existing household's next bill. */
export function calculateFirstPeriod(input: FirstPeriodInput): FirstPeriodResult {
  validateHousehold(input); validateMembership(input, input);
  if (input.firstPeriod !== 'prorate_now' && input.firstPeriod !== 'next_billing_date') throw new RangeError('Invalid first-period policy');
  const periodEndsOn = input.membership.nextDueOn;
  const periodStartsOn = previousBillingDate(calendar(input, input));
  const periodDays = calendarDaysBetween(periodStartsOn, periodEndsOn);
  // Nothing is billed now, so the paid-period limits don't apply. A trial is free until it ends, however long;
  // its first bill is the cycle on its (trial-end) due date.
  if (input.firstPeriod === 'next_billing_date' || input.membership.status === 'trial' ||
    input.membership.status === 'frozen' || input.membership.status === 'cancelled') {
    return { periodStartsOn, periodEndsOn, periodDays, billedDays: 0, invoice: null };
  }
  if (input.membership.startsOn < periodStartsOn) throw new RangeError('First period starts before its billing interval');
  const billedDays = calendarDaysBetween(input.membership.startsOn, periodEndsOn);
  const result = { periodStartsOn, periodEndsOn, periodDays, billedDays };
  if (billedDays === 0) return { ...result, invoice: null };
  const amount = checkedCents(roundRatio(BigInt(input.membership.amountCents) * BigInt(billedDays), BigInt(periodDays)));
  return { ...result, invoice: { householdId: input.householdId, kind: 'one_off', dueOn: input.membership.startsOn,
    periodStartsOn: null, periodEndsOn: null,
    ...calculatePrices(input.currency, [membershipPrice(input, amount)], input.familyDiscountBasisPoints, input.discountDescription) } };
}

/** Sign-up fees and other one-off charges do not join a cycle or receive its discount. */
export function calculateOneOffInvoice(input: OneOffInvoiceInput): CalculatedInvoice {
  idSchema.parse(input.householdId); currencySchema.parse(input.currency); calendarDate(input.dueOn);
  if (!input.charges.length) throw new RangeError('An invoice needs a charge');
  const prices = input.charges.map((charge): Price => {
    if (charge.kind !== 'charge' && charge.kind !== 'signup_fee') throw new RangeError('Invalid one-off charge kind');
    return { ...charge, quantity: charge.quantity ?? 1, membershipId: charge.membershipId ?? null, chargeTypeId: charge.chargeTypeId ?? null };
  });
  return { householdId: input.householdId, kind: 'one_off', dueOn: input.dueOn, periodStartsOn: null, periodEndsOn: null,
    ...calculatePrices(input.currency, prices, 0, '') };
}

function calculatePrices(currency: Currency, prices: readonly Price[], discountBasisPoints: number, discountDescription: string) {
  const taxSnapshots = new Map<Id, string>();
  const gross = prices.map((price) => {
    description(price.description); cents(price.amountCents);
    if (price.currency !== currency) throw new RangeError('Charge currency does not match');
    if (!Number.isInteger(price.quantity) || price.quantity < 1 || price.quantity > 2_147_483_647) throw new RangeError('Invalid quantity');
    if (price.membershipId !== null) idSchema.parse(price.membershipId);
    if (price.chargeTypeId !== null) idSchema.parse(price.chargeTypeId);
    const ids = new Set<Id>();
    for (const tax of price.taxRates) {
      idSchema.parse(tax.id); description(tax.name);
      nonnegativeInteger(tax.rateMillionths, 1_000_000, 'tax rate');
      if (typeof tax.inclusive !== 'boolean') throw new RangeError('Invalid tax treatment');
      if (ids.has(tax.id)) throw new RangeError('Duplicate tax rate on a charge');
      ids.add(tax.id);
      const snapshot = JSON.stringify([tax.name, tax.rateMillionths, tax.inclusive]);
      if (taxSnapshots.has(tax.id) && taxSnapshots.get(tax.id) !== snapshot) throw new RangeError('Conflicting tax snapshots');
      taxSnapshots.set(tax.id, snapshot);
    }
    const amount = BigInt(price.amountCents) * BigInt(price.quantity);
    checkedCents(amount);
    return amount;
  });
  const grossTotal = gross.reduce((sum, amount) => sum + amount, 0n);
  const discount = roundRatio(grossTotal * BigInt(discountBasisPoints), 10_000n);
  const discounts = allocate(discount, gross);
  const lineItems: CalculatedLineItem[] = [];
  for (const [index, price] of prices.entries()) {
    const amount = gross[index]!;
    const discounted = amount - discounts[index]!;
    const taxes = price.taxRates.toSorted(compareIds);
    const included = taxes.filter((tax) => tax.inclusive);
    const includedRate = included.reduce((sum, tax) => sum + BigInt(tax.rateMillionths), 0n);
    const net = (value: bigint) => roundRatio(value * 1_000_000n, 1_000_000n + includedRate);
    const beforeDiscount = net(amount);
    const taxable = net(discounted);
    const fields = { currency, membershipId: price.membershipId, chargeTypeId: price.chargeTypeId, quantity: 1 };
    // Amounts are extended totals; unit-price multiplication has already happened.
    lineItems.push({ ...fields, kind: price.kind, description: price.description, amountCents: checkedCents(beforeDiscount),
      taxRateId: null, taxRateMillionths: null, taxInclusive: null });
    if (beforeDiscount !== taxable) lineItems.push({ ...fields, kind: 'discount', description: discountDescription,
      amountCents: -checkedCents(beforeDiscount - taxable), taxRateId: null, taxRateMillionths: null, taxInclusive: null });
    const inclusiveAmounts = allocate(discounted - taxable, included.map((tax) => BigInt(tax.rateMillionths)));
    const amountsById = new Map(included.map((tax, i) => [tax.id, inclusiveAmounts[i]!]));
    for (const tax of taxes) lineItems.push({ ...fields, kind: 'tax', description: tax.name,
      amountCents: checkedCents(tax.inclusive ? amountsById.get(tax.id)! : roundRatio(taxable * BigInt(tax.rateMillionths), 1_000_000n)),
      taxRateId: tax.id, taxRateMillionths: tax.rateMillionths, taxInclusive: tax.inclusive });
  }
  const amountCents = checkedCents(lineItems.reduce((sum, line) => sum + BigInt(line.amountCents), 0n));
  return { currency, amountCents, lineItems };
}
