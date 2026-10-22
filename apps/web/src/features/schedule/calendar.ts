// SPDX-License-Identifier: AGPL-3.0-only
export function calendarDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (name: string) => parts.find((value) => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function shiftDate(date: string, days: number): string {
  const result = new Date(date + 'T12:00:00Z');
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
/** Resolve an explicitly chosen wall time, rejecting gaps and choosing the first fold. */
export function calendarInstant(value: string, timezone: string): string {
  const naive = Date.parse(value + ':00Z');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wall = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (name: string) => parts.find((item) => item.type === name)!.value;
    return Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
  };
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 6) {
    const sample = naive + hour * 3_600_000;
    offsets.add(wall(sample) - sample);
  }
  const candidates = [...offsets].map((offset) => naive - offset).filter((instant) => wall(instant) === naive);
  if (!candidates.length) throw new Error('Invalid local time');
  return new Date(Math.min(...candidates)).toISOString();
}
export function weekStart(date: string): string {
  return shiftDate(date, -(new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7);
}
