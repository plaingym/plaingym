// SPDX-License-Identifier: AGPL-3.0-only
/**
 * An instant as a medium date and short time ("Nov 11, 2026, 7:20 PM") in the given IANA timezone (the browser's when none
 * is given), as the admin shows times; never raw ISO. A value that isn't a date is shown as it is.
 */
export function instantLabel(value: string, timezone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(date);
}
/** An instant's calendar date as a medium date ("Nov 11, 2026") in the given timezone (the browser's when none is given). */
export function dateLabel(value: string, timezone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: timezone }).format(date);
}
/** A calendar date (YYYY-MM-DD, such as a due date) as a medium date. It names a day, not an instant, so no timezone moves it. */
export function calendarDateLabel(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value + 'T00:00:00Z')) : value;
}
