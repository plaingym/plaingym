// SPDX-License-Identifier: AGPL-3.0-only
import { useBootstrap } from '../app/context.js';

type Style = 'instant' | 'date' | 'time' | 'month';
const options: Record<Style, Intl.DateTimeFormatOptions> = {
  instant: { dateStyle: 'medium', timeStyle: 'short' }, date: { dateStyle: 'medium' },
  time: { hour: 'numeric', minute: '2-digit' }, month: { month: 'long', year: 'numeric' },
};
const cache = new Map<string, Intl.DateTimeFormat>();
/** Reuse formatters across renders, with a bounded cache for locale and gym changes. */
export function dateFormatter(style: Style, timezone?: string, locale = 'en') {
  const key = JSON.stringify([style, timezone, locale]);
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options[style], timeZone: timezone });
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, formatter);
  }
  return formatter;
}
function label(value: string, style: Style, timezone?: string, locale?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter(style, timezone, locale).format(date);
}
/** An instant in the supplied zone; visitor-only callers can omit it for the browser's zone. Gym screens pass their zone. */
export const instantLabel = (value: string, timezone?: string, locale?: string) => label(value, 'instant', timezone, locale);
export const dateLabel = (value: string, timezone?: string, locale?: string) => label(value, 'date', timezone, locale);
export const timeLabel = (value: string, timezone?: string, locale?: string) => label(value, 'time', timezone, locale);
/** A wall-clock time has no offset: use a fixed UTC anchor only to format its hour and minute. */
export const wallTimeLabel = (value: string, locale?: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  ? label('2000-01-01T' + value + ':00Z', 'time', 'UTC', locale) : value;
/** A calendar date names a day, so no timezone moves it. */
export const calendarDateLabel = (value: string, locale?: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? label(value + 'T00:00:00Z', 'date', 'UTC', locale) : value;
export const monthLabel = (value: string, locale?: string) => /^\d{4}-\d{2}$/.test(value)
  ? label(value + '-01T00:00:00Z', 'month', 'UTC', locale) : value;
/** Observe bootstrap so a timezone edit also updates displayed instants. */
export function useGymTime() {
  const timezone = useBootstrap().data?.gym.timezone ?? 'UTC';
  return {
    instantLabel: (value: string) => instantLabel(value, timezone),
    dateLabel: (value: string) => dateLabel(value, timezone),
    timeLabel: (value: string) => timeLabel(value, timezone),
  };
}
