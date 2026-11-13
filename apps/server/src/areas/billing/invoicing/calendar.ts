// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, isCalendarDate, monthStart, nextMonth } from '@plaingym/shared/time';
import type { BillingInterval, IsoDate } from '@plaingym/shared/contracts';

export function calendarDate(value: IsoDate): IsoDate {
  if (!isCalendarDate(value)) throw new RangeError('Expected a calendar date');
  return value;
}

export function billingDay(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new RangeError('Invalid billing day');
  return value;
}

function anchoredMonth(date: IsoDate, months: number, anchor: number): IsoDate {
  let first = monthStart(date);
  for (let index = 0; index < Math.abs(months); index++) first = nextMonth(first, months > 0 ? 1 : -1);
  const last = addDays(nextMonth(first), -1);
  const candidate = addDays(first, anchor - 1);
  return calendarDate(candidate > last ? last : candidate);
}

/** The household's billing day on or after `date`, clamped to short months. */
export function householdDateOnOrAfter(date: IsoDate, day: number): IsoDate {
  calendarDate(date); billingDay(day);
  const sameMonth = anchoredMonth(date, 0, day);
  return sameMonth >= date ? sameMonth : anchoredMonth(date, 1, day);
}

/** Whether a due date is off the household's billing day, including short-month clamps. */
export function isOffDay(dueOn: IsoDate, day: number): boolean {
  return householdDateOnOrAfter(dueOn, day) !== dueOn;
}

/** Use the due date's own day unless a cycle bill resolves a short month-end's original anchor. */
export function offDayPeriodStart(dueOn: IsoDate, billedPeriodStartsOn?: IsoDate): IsoDate {
  calendarDate(dueOn);
  const day = Number(dueOn.slice(8));
  const start = previousBillingDate({ dueOn, interval: 'monthly', billingDay: day });
  if (billedPeriodStartsOn === undefined) return start;
  calendarDate(billedPeriodStartsOn);
  const monthEnd = addDays(nextMonth(monthStart(dueOn)), -1);
  const previousEnd = addDays(monthStart(dueOn), -1);
  const latest = dueOn === monthEnd && day < 31 ? previousEnd : start;
  if (billedPeriodStartsOn < start || billedPeriodStartsOn > latest)
    throw new RangeError('Billed period start does not match the billing interval');
  return billedPeriodStartsOn;
}

export interface BillingCalendar {
  readonly dueOn: IsoDate;
  readonly interval: BillingInterval;
  readonly billingDay: number;
  /** Stable annual anniversary, including Feb 29; defaults to dueOn. */
  readonly annualAnchorOn?: IsoDate;
}
function stepBillingDate(input: BillingCalendar, direction: 1 | -1): IsoDate {
  calendarDate(input.dueOn);
  billingDay(input.billingDay);
  if (input.interval === 'monthly') return anchoredMonth(input.dueOn, direction, input.billingDay);
  if (input.interval !== 'annual') throw new RangeError('Invalid billing interval');
  const anchor = calendarDate(input.annualAnchorOn ?? input.dueOn);
  if (anchor.slice(5, 7) !== input.dueOn.slice(5, 7)) throw new RangeError('Annual anchor month must match the due date');
  return anchoredMonth(input.dueOn, 12 * direction, Number(anchor.slice(8)));
}
export function nextBillingDate(input: BillingCalendar): IsoDate { return stepBillingDate(input, 1); }
export function previousBillingDate(input: BillingCalendar): IsoDate { return stepBillingDate(input, -1); }

/** Start inclusive, end exclusive. Only first-period spans (at most a year). */
export function calendarDaysBetween(start: IsoDate, end: IsoDate): number {
  calendarDate(start); calendarDate(end);
  if (end < start) throw new RangeError('Calendar period is reversed');
  let days = 0;
  for (let date = start; date < end; date = addDays(date, 1)) {
    if (++days > 366) throw new RangeError('First period exceeds one year');
  }
  return days;
}
