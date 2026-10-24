// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, isCalendarDate } from '@plaingym/shared/time';
import { dateSchema } from '@plaingym/shared/contracts';

/** TODO(CCR): promote clamped month arithmetic to shared/time. No instants or offsets here. */
export function addCalendarMonths(date: string, months: number, anchor = Number(date.slice(8))) {
  dateSchema.parse(date);
  if (!Number.isSafeInteger(months) || !Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new Error('Invalid calendar interval');
  const month = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const prefix = String(Math.floor(month / 12)).padStart(4, '0') + '-' + String(month % 12 + 1).padStart(2, '0') + '-';
  for (let day = anchor; day > 0; day--) {
    const result = prefix + String(day).padStart(2, '0');
    if (isCalendarDate(result)) return result;
  }
  throw new Error('Calendar date out of range');
}
/** Matches the invoice engine: a monthly date off the billing day is a short stub up to that day. */
export function advanceDue(date: string, interval: 'monthly' | 'annual', anchor: number) {
  if (interval === 'annual') return addCalendarMonths(date, 12, anchor);
  const aligned = householdNextDate(date, anchor);
  return aligned !== date ? aligned : addCalendarMonths(date, 1, anchor);
}
export function householdNextDate(startsOn: string, billingDay: number) {
  const candidate = addCalendarMonths(startsOn, 0, billingDay);
  return candidate >= startsOn ? candidate : addCalendarMonths(startsOn, 1, billingDay);
}
export function trialEnd(startsOn: string, days: number) { return addDays(startsOn, days); }
