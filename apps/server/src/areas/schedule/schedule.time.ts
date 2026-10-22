// SPDX-License-Identifier: AGPL-3.0-only
/** Calendar arithmetic is deliberately independent of the server's timezone. */
export function localDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (name: string) => parts.find((value) => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function addDays(date: string, days: number): string {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Skip gaps; choose the earlier instant in a repeated wall-clock minute. */
export function wallTime(date: string, time: string, timezone: string): Date | null {
  const naive = Date.parse(`${date}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wall = (value: number) => {
    const parts = formatter.formatToParts(new Date(value));
    const part = (name: string) => parts.find((item) => item.type === name)!.value;
    return Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
  };
  // Sample both sides of an offset transition, including half-hour DST changes.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 3_600_000;
    offsets.add(wall(sample) - sample);
  }
  const candidates = [...offsets].map((offset) => naive - offset).filter((instant) => wall(instant) === naive);
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}
export function occurrences(template: { weekday: number; localStartTime: string }, now: Date, timezone: string): Date[] {
  const today = localDate(now, timezone), result: Date[] = [];
  for (let day = 0; day < 56; day++) {
    const date = addDays(today, day);
    if (new Date(date + 'T12:00:00Z').getUTCDay() !== template.weekday) continue;
    const start = wallTime(date, template.localStartTime, timezone);
    if (start && start >= now) result.push(start);
  }
  return result;
}
