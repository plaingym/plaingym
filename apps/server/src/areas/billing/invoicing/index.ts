// SPDX-License-Identifier: AGPL-3.0-only
import { currencySchema, idSchema } from '@plaingym/shared/contracts';
import type { Currency, Id, IsoDate } from '@plaingym/shared/contracts';
import type { AssignMembership } from '../../../core/interfaces/membership-lifecycle.js';
import { calendarDate, calendarDaysBetween, householdDateOnOrAfter, nextBillingDate, previousBillingDate } from './calendar.js';
import {
  calculatePrices, calendar, compareIds, membershipPrice, prorate, validateHousehold, validateMembership,
} from './pricing.js';
import type { AppliedTaxRate, CalculatedInvoice, HouseholdPricing, Price, PricedMembership } from './pricing.js';

export { calendarDaysBetween, nextBillingDate, previousBillingDate } from './calendar.js';
export type { BillingCalendar } from './calendar.js';
export type { AppliedTaxRate, CalculatedInvoice, CalculatedLineItem, PricedMembership } from './pricing.js';
export { calculatePlanChange } from './plan-change.js';
export type { PlanChangeInput, PlanChangeResult, PlanChangeTarget } from './plan-change.js';

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
  /** The plan a signup fee belongs to, recorded on its line; a charge has none. */
  readonly planId?: Id;
  readonly taxRates: readonly AppliedTaxRate[];
}
export interface OneOffInvoiceInput {
  readonly householdId: Id;
  readonly currency: Currency;
  readonly dueOn: IsoDate;
  readonly charges: readonly OneOffCharge[];
}

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
      return { nextDueOn: householdDate, amountCents: prorate(input.currency, membership.amountCents, billedDays, periodDays) };
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
  const amount = prorate(input.currency, input.membership.amountCents, billedDays, periodDays);
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
    if (charge.kind === 'charge' && charge.planId !== undefined) throw new RangeError('Only a signup fee records a plan');
    return { ...charge, quantity: charge.quantity ?? 1, membershipId: charge.membershipId ?? null,
      chargeTypeId: charge.chargeTypeId ?? null, planId: charge.planId ?? null };
  });
  return { householdId: input.householdId, kind: 'one_off', dueOn: input.dueOn, periodStartsOn: null, periodEndsOn: null,
    ...calculatePrices(input.currency, prices, 0, '') };
}
