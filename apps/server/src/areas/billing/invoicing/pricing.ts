// SPDX-License-Identifier: AGPL-3.0-only
// Validation, calendar and pricing internals shared by this directory's calculators. Consumers import `index.ts`.
import { currencySchema, idSchema } from '@plaingym/shared/contracts';
import type { Currency, Id, Invoice, InvoiceLineItem, IsoDate, TaxRate } from '@plaingym/shared/contracts';
import { minorUnitStep } from '@plaingym/shared/money';
import type { MembershipSnapshot } from '../../../core/interfaces/membership-lifecycle.js';
import { billingDay, calendarDate } from './calendar.js';
import { allocate, cents, checkedCents, nonnegativeInteger, roundRatio } from './money.js';

type WithoutIdentity<T> = T extends unknown ? Omit<T, 'id' | 'createdAt' | 'invoiceId' | 'householdId'> : never;
export type CalculatedLineItem = WithoutIdentity<InvoiceLineItem>;
export interface CalculatedInvoice extends Pick<Invoice,
  'householdId' | 'kind' | 'dueOn' | 'periodStartsOn' | 'periodEndsOn' | 'amountCents' | 'currency'> {
  readonly lineItems: readonly CalculatedLineItem[];
}
export type AppliedTaxRate = Readonly<Pick<TaxRate, 'id' | 'name' | 'rateMillionths' | 'inclusive'>>;
/** A resolved membership discount; the caller supplies the source's invoice name. */
export type MembershipDiscount = { readonly name: string } & (
  { readonly kind: 'percentage'; readonly basisPoints: number }
  | { readonly kind: 'fixed'; readonly amountCents: number }
);
export interface Proration {
  readonly billedDays: number;
  readonly periodDays: number;
}
export interface PricedMembership {
  readonly membership: MembershipSnapshot;
  /** Already localized by the caller, snapshotted on the invoice. */
  readonly description: string;
  readonly taxRates: readonly AppliedTaxRate[];
  readonly discount?: MembershipDiscount;
  /** Supply an imported annual anniversary when it differs from startsOn. */
  readonly annualAnchorOn?: IsoDate;
}
export interface HouseholdPricing {
  readonly householdId: Id;
  readonly currency: Currency;
  readonly billingDay: number;
  readonly familyDiscountBasisPoints: number;
  /** Already localized by the caller. */
  readonly discountDescription: string;
}
export interface Price {
  readonly kind: 'membership' | 'charge' | 'signup_fee';
  readonly description: string;
  readonly amountCents: number;
  readonly quantity: number;
  readonly currency: Currency;
  readonly membershipId: Id | null;
  readonly chargeTypeId: Id | null;
  /** Recorded on membership and signup-fee lines only. */
  readonly planId: Id | null;
  readonly taxRates: readonly AppliedTaxRate[];
  /** Unrounded so the invoice's currency step also governs the discount. */
  readonly membershipDiscount?: { readonly name: string; readonly numerator: bigint; readonly denominator: bigint };
}

export function description(value: string): void {
  if (!value.trim()) throw new RangeError('Invoice descriptions must not be empty');
}
export function validateHousehold(input: HouseholdPricing): void {
  idSchema.parse(input.householdId); currencySchema.parse(input.currency);
  billingDay(input.billingDay);
  nonnegativeInteger(input.familyDiscountBasisPoints, 10_000, 'family discount');
  description(input.discountDescription);
}
export function validateDiscount(discount: MembershipDiscount | undefined): void {
  if (discount === undefined) return;
  description(discount.name);
  if (discount.kind === 'percentage') nonnegativeInteger(discount.basisPoints, 10_000, 'membership discount');
  else if (discount.kind === 'fixed') cents(discount.amountCents);
  else throw new RangeError('Invalid membership discount kind');
}
export function validateMembership(input: HouseholdPricing, item: PricedMembership): void {
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
  validateDiscount(item.discount);
}
export function validateTaxRates(rates: readonly AppliedTaxRate[], snapshots = new Map<Id, string>()): void {
  const ids = new Set<Id>();
  for (const tax of rates) {
    idSchema.parse(tax.id); description(tax.name);
    nonnegativeInteger(tax.rateMillionths, 1_000_000, 'tax rate');
    if (typeof tax.inclusive !== 'boolean') throw new RangeError('Invalid tax treatment');
    if (ids.has(tax.id)) throw new RangeError('Duplicate tax rate on a charge');
    ids.add(tax.id);
    const snapshot = JSON.stringify([tax.name, tax.rateMillionths, tax.inclusive]);
    if (snapshots.has(tax.id) && snapshots.get(tax.id) !== snapshot) throw new RangeError('Conflicting tax snapshots');
    snapshots.set(tax.id, snapshot);
  }
}
function annualAnchor(item: PricedMembership): IsoDate {
  const { startsOn, nextDueOn } = item.membership;
  const clampedLeapAnniversary = startsOn.slice(5) === '02-29' && nextDueOn.slice(5) === '02-28';
  return item.annualAnchorOn ?? (clampedLeapAnniversary ? startsOn : nextDueOn);
}
export function calendar(input: HouseholdPricing, item: PricedMembership) {
  return { dueOn: item.membership.nextDueOn, interval: item.membership.interval,
    billingDay: input.billingDay, annualAnchorOn: annualAnchor(item) };
}
export function membershipPrice(item: PricedMembership, amountCents = item.membership.amountCents, period?: Proration): Price {
  const discount = item.discount;
  const membershipDiscount = discount === undefined ? undefined : { name: discount.name,
    numerator: discount.kind === 'percentage' ? BigInt(amountCents) * BigInt(discount.basisPoints)
      : BigInt(discount.amountCents) * BigInt(period?.billedDays ?? 1),
    denominator: discount.kind === 'percentage' ? 10_000n : BigInt(period?.periodDays ?? 1) };
  return { kind: 'membership', description: item.description, amountCents, currency: item.membership.currency,
    quantity: 1, membershipId: item.membership.id, chargeTypeId: null, planId: item.membership.planId, taxRates: item.taxRates,
    ...membershipDiscount === undefined ? {} : { membershipDiscount } };
}
/** The currency's charge step: every amount the engine rounds lands on it, so a card charge in ISK or KWD is never refused. */
export function step(currency: Currency): bigint { return BigInt(minorUnitStep(currency)); }
export function compareIds(a: { id: Id }, b: { id: Id }): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

export function membershipDiscountAmount(price: Price, amount: bigint, unit: bigint): bigint {
  if (price.membershipDiscount === undefined) return 0n;
  const { numerator, denominator } = price.membershipDiscount;
  const discount = roundRatio(numerator, denominator, unit);
  return discount > amount ? amount : discount;
}

export function calculatePrices(currency: Currency, prices: readonly Price[], discountBasisPoints: number, discountDescription: string) {
  let unit = step(currency);
  const taxSnapshots = new Map<Id, string>();
  const gross = prices.map((price) => {
    description(price.description); cents(price.amountCents);
    if (price.currency !== currency) throw new RangeError('Charge currency does not match');
    if (!Number.isInteger(price.quantity) || price.quantity < 1 || price.quantity > 2_147_483_647) throw new RangeError('Invalid quantity');
    if (price.membershipId !== null) idSchema.parse(price.membershipId);
    if (price.chargeTypeId !== null) idSchema.parse(price.chargeTypeId);
    if (price.planId !== null) idSchema.parse(price.planId);
    validateTaxRates(price.taxRates, taxSnapshots);
    const amount = BigInt(price.amountCents) * BigInt(price.quantity);
    checkedCents(amount);
    return amount;
  });
  // A price stored off the step (from before prices were checked) can't land on it, and rounding it to whole steps
  // could take more discount or net than the line holds, so such an invoice is calculated in single minor units.
  if (gross.some((amount) => amount % unit !== 0n)) unit = 1n;
  const afterMembershipDiscount = prices.map((price, index) => gross[index]! - membershipDiscountAmount(price, gross[index]!, unit));
  const discountBase = afterMembershipDiscount.reduce((sum, amount) => sum + amount, 0n);
  const discount = roundRatio(discountBase * BigInt(discountBasisPoints), 10_000n, unit);
  const discounts = allocate(discount, afterMembershipDiscount, unit);
  const lineItems: CalculatedLineItem[] = [];
  for (const [index, price] of prices.entries()) {
    const amount = gross[index]!;
    const afterMembership = afterMembershipDiscount[index]!;
    const discounted = afterMembership - discounts[index]!;
    const taxes = price.taxRates.toSorted(compareIds);
    const included = taxes.filter((tax) => tax.inclusive);
    const includedRate = included.reduce((sum, tax) => sum + BigInt(tax.rateMillionths), 0n);
    const net = (value: bigint) => roundRatio(value * 1_000_000n, 1_000_000n + includedRate, unit);
    const beforeDiscount = net(amount);
    const afterMembershipNet = net(afterMembership);
    const taxable = net(discounted);
    const fields = { currency, membershipId: price.membershipId, chargeTypeId: price.chargeTypeId, quantity: 1, planId: null };
    // Amounts are extended totals; unit-price multiplication has already happened. Only the priced line
    // itself records a plan; its discount and tax lines never do.
    const priced = { ...fields, description: price.description, amountCents: checkedCents(beforeDiscount),
      taxRateId: null, taxRateMillionths: null, taxInclusive: null };
    lineItems.push(price.kind === 'charge' ? { ...priced, kind: price.kind } : { ...priced, kind: price.kind, planId: price.planId });
    if (beforeDiscount !== afterMembershipNet) lineItems.push({ ...fields, kind: 'discount', description: price.membershipDiscount!.name,
      amountCents: -checkedCents(beforeDiscount - afterMembershipNet), taxRateId: null, taxRateMillionths: null, taxInclusive: null });
    if (afterMembershipNet !== taxable) lineItems.push({ ...fields, kind: 'discount', description: discountDescription,
      amountCents: -checkedCents(afterMembershipNet - taxable), taxRateId: null, taxRateMillionths: null, taxInclusive: null });
    const inclusiveAmounts = allocate(discounted - taxable, included.map((tax) => BigInt(tax.rateMillionths)), unit);
    const amountsById = new Map(included.map((tax, i) => [tax.id, inclusiveAmounts[i]!]));
    for (const tax of taxes) lineItems.push({ ...fields, kind: 'tax', description: tax.name,
      amountCents: checkedCents(tax.inclusive ? amountsById.get(tax.id)! : roundRatio(taxable * BigInt(tax.rateMillionths), 1_000_000n, unit)),
      taxRateId: tax.id, taxRateMillionths: tax.rateMillionths, taxInclusive: tax.inclusive });
  }
  const amountCents = checkedCents(lineItems.reduce((sum, line) => sum + BigInt(line.amountCents), 0n));
  return { currency, amountCents, lineItems };
}

/** `price × billedDays / periodDays`, rounded once to the currency's step: the first-period proration. */
export function prorate(currency: Currency, amountCents: number, billedDays: number, periodDays: number): number {
  return checkedCents(roundRatio(BigInt(amountCents) * BigInt(billedDays), BigInt(periodDays), step(currency)));
}
