// SPDX-License-Identifier: AGPL-3.0-only
// Date helpers for specs. They depend on nothing but `Intl`: this independent suite never loads application modules,
// and `dates.test.ts` runs them under the repository's unit tests with no browser or stack.
//
// The server has no test clock, so a spec can't freeze time. It holds whenever it runs by deriving every day and week
// it reads back from the instant it created (a class's own start), never from the day it happens to run on.

const formatters = new Map<string, Intl.DateTimeFormat>();
/** One formatter per zone: building one costs far more than using it. */
function formatter(timeZone: string) {
  let known = formatters.get(timeZone);
  if (!known) {
    known = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, known);
  }
  return known;
}

/** The wall-clock date (`YYYY-MM-DD`) and time (`HH:MM`) of an instant in a zone. Built from `Intl` parts, not a locale's output format. */
export function wall(instant: Date | number, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** The calendar date (`YYYY-MM-DD`) of an instant in a zone. */
export const localDate = (instant: Date | number, timeZone: string) => wall(instant, timeZone).date;

/** Day of the week of a `YYYY-MM-DD` date, 0 (Sunday) to 6 (Saturday). */
export const weekday = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();

/** A calendar date moved by whole days (negative moves back); month, year and leap-day ends roll over. */
export function addDays(date: string, days: number) {
  const day = new Date(date + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** The Monday on or before a calendar date: the day the admin schedule's **Week of** field moves to. */
export const mondayOf = (date: string) => addDays(date, -((weekday(date) + 6) % 7));

/** The Monday that starts the schedule week holding an instant, as the zone sees it. */
export const weekStartOf = (instant: Date | number, timeZone: string) => mondayOf(localDate(instant, timeZone));

const minute = 60_000;

export interface ClassStartOptions {
  /** The earliest the class may start, after `from`. Default 0. */
  leadMinutes?: number;
  /** How long the class runs. Default 60. */
  durationMinutes?: number;
  /** How far the class stays from a local midnight, before it starts and after it ends. Default 30. */
  marginMinutes?: number;
}

/**
 * A class start, in epoch milliseconds, on a 5-minute mark at least `leadMinutes` after `from`, that stays clear of the
 * zone's local midnight: a margin before the start and after the end all fall on the start's calendar date. A class created
 * now and read later then shows on one day and one week however the reader rounds, and a clock that is a little off
 * can't move it across a day or week boundary. The search moves in instants, so a day of 23 or 25 hours is handled.
 */
export function classStart(from: Date | number, timeZone: string, options: ClassStartOptions = {}) {
  const { leadMinutes = 0, durationMinutes = 60, marginMinutes = 30 } = options, step = 5 * minute;
  let start = Math.ceil((Number(from) + leadMinutes * minute) / step) * step;
  // Two days of 5-minute marks always hold a window: the day is at least 23 hours and a class needs far less.
  for (let tries = 0; tries < 2 * 24 * 12; tries++, start += step) {
    const day = localDate(start, timeZone);
    if (localDate(start - marginMinutes * minute, timeZone) === day && localDate(start + (durationMinutes + marginMinutes) * minute, timeZone) === day) return start;
  }
  throw new Error(`No ${durationMinutes}-minute class clear of midnight in ${timeZone} within two days of ${new Date(Number(from)).toISOString()}`);
}
