// SPDX-License-Identifier: AGPL-3.0-only
// The only module that imports the Temporal polyfill; switch to the built-in
// Temporal here once the pinned Node.js release ships it.
import { Temporal } from 'temporal-polyfill';

/**
 * Time handling: instants are stored in UTC (`timestamptz`), the gym keeps its IANA
 * timezone, and local wall times and calendar dates are converted only here.
 * Dates are `YYYY-MM-DD`; times are `HH:MM` or `HH:MM:SS`.
 */

/** Whether `value` is a real `YYYY-MM-DD` calendar date. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { Temporal.PlainDate.from(value, { overflow: 'reject' }); return true; }
  catch { return false; }
}
/** The calendar date an instant falls on in `timezone`. */
export function localDate(instant: Date, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(timezone).toPlainDate().toString();
}
export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date, { overflow: 'reject' }).add({ days }).toString();
}
/** Day of the week, 0 (Sunday) to 6 (Saturday), as `Date#getUTCDay` numbers them. */
export function weekday(date: string): number {
  return Temporal.PlainDate.from(date, { overflow: 'reject' }).dayOfWeek % 7;
}
/**
 * The instant a local wall time names in `timezone`. A time repeated when clocks go back is
 * the earlier instant. A time skipped when clocks go forward is `null` with `gap: 'skip'`, or
 * moved forward by the length of the gap with `gap: 'shift'` (02:30 becomes 03:30).
 */
export function zonedInstant(date: string, time: string, timezone: string, options: { gap: 'skip' | 'shift' }): Date | null {
  const wall = Temporal.PlainDate.from(date, { overflow: 'reject' }).toPlainDateTime(Temporal.PlainTime.from(time, { overflow: 'reject' }));
  const zoned = wall.toZonedDateTime(timezone, { disambiguation: 'compatible' });
  if (options.gap === 'skip' && Temporal.PlainDateTime.compare(zoned.toPlainDateTime(), wall) !== 0) return null;
  return new Date(zoned.epochMilliseconds);
}
