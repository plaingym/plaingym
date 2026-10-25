// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, localDate, weekday, zonedInstant } from '@plaingym/shared/time';
export function calendarDate(instant: Date, timezone: string): string {
  return localDate(instant, timezone);
}
export function shiftDate(date: string, days: number): string {
  return addDays(date, days);
}
/** Resolve an explicitly chosen wall time (`YYYY-MM-DDTHH:MM`), rejecting gaps and choosing the first fold. */
export function calendarInstant(value: string, timezone: string): string {
  const [date = '', time = ''] = value.split('T');
  const instant = zonedInstant(date, time, timezone, { gap: 'skip' });
  if (!instant) throw new Error('Invalid local time');
  return instant.toISOString();
}
/** The local `HH:MM` wall time of an instant in `timezone` (display formatting). */
export function localTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  return `${parts.find((part) => part.type === 'hour')!.value}:${parts.find((part) => part.type === 'minute')!.value}`;
}
export function weekStart(date: string): string {
  return shiftDate(date, -(weekday(date) + 6) % 7);
}
