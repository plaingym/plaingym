// SPDX-License-Identifier: AGPL-3.0-only
import { idSchema } from '@plaingym/shared/contracts';
import type { BillingInterval, Currency, Id, IsoDate } from '@plaingym/shared/contracts';
import { createTranslator } from '@plaingym/shared';
import { formatMinorUnits } from '@plaingym/shared/money';
import messages from '../../../../../../locales/en/billing/runner.json' with { type: 'json' };
import type { MembershipSnapshot } from '../../../core/interfaces/membership-lifecycle.js';
import { calendarDate, calendarDaysBetween, isOffDay, offDayPeriodStart, previousBillingDate } from './calendar.js';
import { cents } from './money.js';
import {
  calculatePrices, calendar, membershipPrice, prorate, validateHousehold, validateMembership,
  membershipDiscountAmount, chargeUnit, step, validateDiscount, validateTaxRates,
} from './pricing.js';
import type { AppliedTaxRate, CalculatedInvoice, HouseholdPricing, MembershipDiscount, PricedMembership } from './pricing.js';
const t = createTranslator({ 'billing/runner': messages });

/** The plan a membership switches to. */
export interface PlanChangeTarget {
  readonly id: Id;
  readonly amountCents: number;
  readonly currency: Currency;
  readonly interval: BillingInterval;
  /** Already localized by the caller, snapshotted on the invoice. */
  readonly description: string;
  readonly taxRates: readonly AppliedTaxRate[];
}
export interface PlanChangeInput extends HouseholdPricing {
  /** The membership before the change: its amount (a custom price counts) is the current price. */
  readonly membership: MembershipSnapshot;
  readonly currentDiscount?: MembershipDiscount;
  /** Pass the discount again to keep it; omit it when the discount ends. */
  readonly newDiscount?: MembershipDiscount;
  /** Supply an imported annual anniversary when it differs from startsOn. */
  readonly annualAnchorOn?: IsoDate;
  /** Actual cycle bill's due date, resolving an off-day short month-end's ambiguous billing day. */
  readonly billedPeriodStartsOn?: IsoDate;
  readonly newPlan: PlanChangeTarget;
  /** The gym-local date the change takes effect, from `localDate(clock.now(), timezone)`. */
  readonly changeOn: IsoDate;
}
export interface PlanChangeResult {
  readonly invoice: CalculatedInvoice | null;
  readonly periodStartsOn: IsoDate;
  readonly periodEndsOn: IsoDate;
  /** Zero whenever there is no invoice. */
  readonly billedDays: number;
  readonly periodDays: number;
}

/**
 * The current period: the monthly or annual interval immediately before the next due date, as for a first
 * period. A monthly due date off the household's billing day (left by a changed billing day) closes a full
 * month on its own day. A cycle bill can resolve a short month-end's ambiguous original billing day.
 */
export function currentPeriodStart(input: HouseholdPricing, item: PricedMembership, billedPeriodStartsOn?: IsoDate): IsoDate {
  const terms = calendar(input, item);
  if (terms.interval === 'monthly' && isOffDay(terms.dueOn, input.billingDay)) {
    return offDayPeriodStart(terms.dueOn, billedPeriodStartsOn);
  }
  const start = previousBillingDate(terms);
  if (billedPeriodStartsOn !== undefined && calendarDate(billedPeriodStartsOn) !== start)
    throw new RangeError('Billed period start does not match the billing interval');
  return start;
}

/**
 * The prorated charge for upgrading a membership now: credit the current discounted price, prorate the
 * difference, then apply the new membership discount, household discount and new plan's taxes.
 * Returns a `one_off` invoice due on the later of `changeOn` and `startsOn` with one membership line
 * that records the new plan, or no invoice when the effective price isn't higher, no days are left, the rounded
 * proration is zero, or the membership is in a trial, frozen or cancelled. An interval change never prorates
 * and is refused.
 */
export function calculatePlanChange(input: PlanChangeInput): PlanChangeResult {
  const { membership, newPlan, changeOn } = input;
  const item: PricedMembership = { membership, description: newPlan.description, taxRates: newPlan.taxRates,
    ...input.annualAnchorOn === undefined ? {} : { annualAnchorOn: input.annualAnchorOn } };
  validateHousehold(input); validateMembership(input, item);
  validateDiscount(input.currentDiscount); validateDiscount(input.newDiscount);
  validateTaxRates(newPlan.taxRates);
  idSchema.parse(newPlan.id); cents(newPlan.amountCents); calendarDate(changeOn);
  if (newPlan.id === membership.planId) throw new RangeError('The membership is already on this plan');
  if (newPlan.currency !== input.currency) throw new RangeError('Plan currency does not match');
  if (newPlan.interval !== 'monthly' && newPlan.interval !== 'annual') throw new RangeError('Invalid billing interval');
  if (newPlan.interval !== membership.interval) throw new RangeError('A billing interval change is not prorated');
  const periodEndsOn = membership.nextDueOn;
  const periodStartsOn = currentPeriodStart(input, item, input.billedPeriodStartsOn);
  const periodDays = calendarDaysBetween(periodStartsOn, periodEndsOn);
  const none = { periodStartsOn, periodEndsOn, periodDays, billedDays: 0, invoice: null };
  // A trial or frozen period wasn't paid at the old price, so there is no difference to charge, and a
  // cancelled membership doesn't switch.
  if (membership.status === 'trial' || membership.status === 'frozen' || membership.status === 'cancelled') return none;
  const from = changeOn > membership.startsOn ? changeOn : membership.startsOn;
  if (from >= periodEndsOn) return none;
  if (from < periodStartsOn) throw new RangeError('Plan change starts before its billing interval');
  // Credit the current discounted price, then discount the new side for the same remaining days.
  // Keep the undiscounted difference's single rounding when neither side has a discount.
  const current = membershipPrice({ ...item, ...input.currentDiscount === undefined ? {} : { discount: input.currentDiscount } });
  const next = { ...item, ...input.newDiscount === undefined ? {} : { discount: input.newDiscount } };
  const unit = chargeUnit(input.currency, [BigInt(membership.amountCents), BigInt(newPlan.amountCents)]);
  const currentAmount = BigInt(membership.amountCents);
  const currentEffective = currentAmount - membershipDiscountAmount(current, currentAmount, unit);
  const nextAmount = BigInt(newPlan.amountCents);
  const nextEffective = nextAmount - membershipDiscountAmount(membershipPrice(next, newPlan.amountCents), nextAmount, unit);
  if (nextEffective <= currentEffective) return none;
  const difference = newPlan.amountCents - Number(currentEffective);
  const billedDays = calendarDaysBetween(from, periodEndsOn);
  const amount = prorate(input.currency, difference, billedDays, periodDays);
  if (amount === 0) return none;
  const price = { ...membershipPrice(next, amount, { billedDays, periodDays }), planId: newPlan.id,
    discountBaseCents: prorate(input.currency, newPlan.amountCents, billedDays, periodDays),
    description: t('billing/runner:upgradeCredit', { plan: newPlan.description,
      amount: formatMinorUnits(Number(currentEffective), input.currency) }) };
  // `prorate` lands the amount on the step, so the invoice rounds its discount to the step: check with the same unit.
  if (membershipDiscountAmount(price, BigInt(amount), step(input.currency)) === BigInt(amount)) return none;
  return { periodStartsOn, periodEndsOn, periodDays, billedDays, invoice: { householdId: input.householdId,
    kind: 'one_off', dueOn: from, periodStartsOn: null, periodEndsOn: null,
    ...calculatePrices(input.currency, [price],
      input.familyDiscountBasisPoints, input.discountDescription) } };
}
