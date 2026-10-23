// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, localDate, weekday, zonedInstant } from '@plaingym/shared/time';

/** Calendar arithmetic is deliberately independent of the server's timezone. */
export { addDays, localDate };
/** Skip gaps; choose the earlier instant in a repeated wall-clock minute. */
export function wallTime(date: string, time: string, timezone: string): Date | null {
  return zonedInstant(date, time, timezone, { gap: 'skip' });
}
export function occurrences(template: { weekday: number; localStartTime: string }, now: Date, timezone: string): Date[] {
  const today = localDate(now, timezone), result: Date[] = [];
  for (let day = 0; day < 56; day++) {
    const date = addDays(today, day);
    if (weekday(date) !== template.weekday) continue;
    const start = wallTime(date, template.localStartTime, timezone);
    if (start && start >= now) result.push(start);
  }
  return result;
}
