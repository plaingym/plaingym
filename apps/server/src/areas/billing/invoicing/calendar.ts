// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, isCalendarDate } from '@plaingym/shared/time';
import type { BillingInterval, IsoDate } from '@plaingym/shared/contracts';

export function calendarDate(value: IsoDate): IsoDate {
  if (!isCalendarDate(value)) throw new RangeError('Expected a calendar date');
  return value;
}

export function billingDay(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new RangeError('Invalid billing day');
  return value;
}

// TODO: move anchored calendar stepping and day differences into shared/time.
// All calendar operations use its addDays; no instant or elapsed-hour arithmetic.
function monthStart(date: IsoDate): IsoDate {
  return addDays(date, 1 - Number(date.slice(8)));
}
function stepMonth(first: IsoDate, direction: 1 | -1): IsoDate {
  return monthStart(addDays(first, direction === 1 ? 32 : -1));
}
function anchoredMonth(date: IsoDate, months: number, anchor: number): IsoDate {
  let first = monthStart(date);
  for (let index = 0; index < Math.abs(months); index++) first = stepMonth(first, months > 0 ? 1 : -1);
  const last = addDays(stepMonth(first, 1), -1);
  const candidate = addDays(first, anchor - 1);
  return calendarDate(candidate > last ? last : candidate);
}

/** The household's billing day on or after `date`, clamped to short months. */
export function householdDateOnOrAfter(date: IsoDate, day: number): IsoDate {
  calendarDate(date); billingDay(day);
  const sameMonth = anchoredMonth(date, 0, day);
  return sameMonth >= date ? sameMonth : anchoredMonth(date, 1, day);
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
