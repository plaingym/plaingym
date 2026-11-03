// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addDays, classStart, localDate, mondayOf, wall, weekStartOf, weekday } from './dates.js';

// Instants below are written with their UTC offset, which `Date` parses without `Intl`, so the expectations
// don't rest on the code under test. The zones are the ones the specs use (the gym's UTC, the schedule spec's
// New York and Tokyo, its browser's Honolulu) plus a southern and a European zone for their own DST changes.
const at = (text: string) => new Date(text);
const zones = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Honolulu', 'Australia/Sydney', 'Europe/London'];

describe('calendar dates', () => {
  it('numbers the weekdays from Sunday', () => {
    expect(['2026-11-01', '2026-11-02', '2026-11-07'].map(weekday)).toEqual([0, 1, 6]);
  });

  it('moves across month, year and leap-day ends', () => {
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('finds the Monday on or before a date', () => {
    expect(mondayOf('2026-11-02')).toBe('2026-11-02'); // A Monday is its own week's start.
    expect(mondayOf('2026-11-01')).toBe('2026-10-26'); // A Sunday ends the week before.
    expect(mondayOf('2026-05-31')).toBe('2026-05-25'); // Sunday at a month end.
    expect(mondayOf('2026-06-01')).toBe('2026-06-01'); // Monday at a month start.
    expect(mondayOf('2026-03-01')).toBe('2026-02-23'); // Into the previous month.
    expect(mondayOf('2025-12-31')).toBe('2025-12-29');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28'); // Into the previous year.
    expect(mondayOf('2028-02-29')).toBe('2028-02-28'); // Leap day.
  });
});

describe('the week of an instant', () => {
  // Sunday 2026-11-01 23:59 and Monday 2026-11-02 00:00 on the zone's own wall clock.
  const edges: [string, string][] = [
    ['UTC', '+00:00'], ['America/New_York', '-05:00'], ['Asia/Tokyo', '+09:00'], ['Pacific/Honolulu', '-10:00'], ['Australia/Sydney', '+11:00'],
  ];
  for (const [zone, offset] of edges) {
    it(`changes weeks at Sunday 23:59 to Monday 00:00 in ${zone}`, () => {
      const sunday = at(`2026-11-01T23:59:00${offset}`), monday = at(`2026-11-02T00:00:00${offset}`);
      expect(monday.getTime() - sunday.getTime()).toBe(60_000);
      expect(wall(sunday, zone)).toEqual({ date: '2026-11-01', time: '23:59' });
      expect(wall(monday, zone)).toEqual({ date: '2026-11-02', time: '00:00' });
      expect(weekStartOf(sunday, zone)).toBe('2026-10-26');
      expect(weekStartOf(monday, zone)).toBe('2026-11-02');
    });
  }

  it('reads one instant as different days and weeks in different zones', () => {
    const instant = at('2026-11-01T23:59:00Z'); // Sunday in UTC and New York, already Monday in Tokyo and Sydney.
    expect(zones.map((zone) => [zone, localDate(instant, zone), weekStartOf(instant, zone)])).toEqual([
      ['UTC', '2026-11-01', '2026-10-26'], ['America/New_York', '2026-11-01', '2026-10-26'], ['Asia/Tokyo', '2026-11-02', '2026-11-02'],
      ['Pacific/Honolulu', '2026-11-01', '2026-10-26'], ['Australia/Sydney', '2026-11-02', '2026-11-02'], ['Europe/London', '2026-11-01', '2026-10-26'],
    ]);
  });

  it('keeps the week across a month end', () => {
    expect(weekStartOf(at('2026-05-31T23:59:00Z'), 'UTC')).toBe('2026-05-25');
    expect(weekStartOf(at('2026-06-01T00:00:00Z'), 'UTC')).toBe('2026-06-01');
    expect(weekStartOf(at('2026-12-31T23:30:00-05:00'), 'America/New_York')).toBe('2026-12-28');
  });
});

describe('daylight saving changes', () => {
  // [zone, instant, wall time]: each pair straddles the change, on the day of the change.
  const changes: [string, string, string, string][] = [
    ['America/New_York', '2026-03-08T06:59:00Z', '2026-03-08', '01:59'], ['America/New_York', '2026-03-08T07:00:00Z', '2026-03-08', '03:00'],
    ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01', '01:30'], ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01', '01:30'],
    ['America/New_York', '2026-11-01T07:00:00Z', '2026-11-01', '02:00'],
    ['Australia/Sydney', '2026-04-04T15:59:00Z', '2026-04-05', '02:59'], ['Australia/Sydney', '2026-04-04T16:00:00Z', '2026-04-05', '02:00'],
    ['Australia/Sydney', '2026-10-03T15:59:00Z', '2026-10-04', '01:59'], ['Australia/Sydney', '2026-10-03T16:00:00Z', '2026-10-04', '03:00'],
    ['Europe/London', '2026-03-29T00:59:00Z', '2026-03-29', '00:59'], ['Europe/London', '2026-03-29T01:00:00Z', '2026-03-29', '02:00'],
    ['Europe/London', '2026-10-25T00:30:00Z', '2026-10-25', '01:30'], ['Europe/London', '2026-10-25T01:30:00Z', '2026-10-25', '01:30'],
  ];
  for (const [zone, instant, date, time] of changes) {
    it(`reads ${instant} in ${zone} as ${date} ${time}`, () => {
      expect(wall(at(instant), zone)).toEqual({ date, time });
    });
  }

  it('keeps the week of a Sunday change day and the Monday after it', () => {
    // 2026-03-08 (New York), 2026-04-05 and 2026-10-04 (Sydney), 2026-03-29 and 2026-10-25 (London) are all Sundays.
    expect(weekStartOf(at('2026-03-08T06:59:00Z'), 'America/New_York')).toBe('2026-03-02');
    expect(weekStartOf(at('2026-03-09T04:00:00Z'), 'America/New_York')).toBe('2026-03-09'); // 00:00 EDT Monday.
    expect(weekStartOf(at('2026-11-02T04:59:00Z'), 'America/New_York')).toBe('2026-10-26'); // 23:59 EST Sunday.
    expect(weekStartOf(at('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02');
    expect(weekStartOf(at('2026-04-05T13:59:00Z'), 'Australia/Sydney')).toBe('2026-03-30'); // 23:59 AEST Sunday.
    expect(weekStartOf(at('2026-04-05T14:00:00Z'), 'Australia/Sydney')).toBe('2026-04-06');
    expect(weekStartOf(at('2026-10-25T23:59:00Z'), 'Europe/London')).toBe('2026-10-19'); // 23:59 GMT Sunday.
    expect(weekStartOf(at('2026-10-26T00:00:00Z'), 'Europe/London')).toBe('2026-10-26');
  });
});

describe('a class start clear of local midnight', () => {
  const minute = 60_000;

  it('is the first 5-minute mark after the lead when the day has room', () => {
    expect(new Date(classStart(at('2026-11-03T12:03:00Z'), 'UTC', { leadMinutes: 30 })).toISOString()).toBe('2026-11-03T12:35:00.000Z');
    expect(new Date(classStart(at('2026-11-03T12:05:00Z'), 'UTC')).toISOString()).toBe('2026-11-03T12:05:00.000Z');
    expect(new Date(classStart(at('2026-11-03T12:00:00Z'), 'UTC', { leadMinutes: 26 * 60 })).toISOString()).toBe('2026-11-04T14:00:00.000Z');
  });

  it('moves a class that would run over Sunday midnight to Monday, a margin after it', () => {
    // 23:30 would end at 00:30 and 23:20 is too close to the midnight that follows; Monday 00:30 is the first start with 30 clear minutes before it.
    const start = classStart(at('2026-11-01T23:00:00Z'), 'UTC', { leadMinutes: 30 });
    expect(new Date(start).toISOString()).toBe('2026-11-02T00:30:00.000Z');
    expect(weekStartOf(start, 'UTC')).toBe('2026-11-02');
    expect(weekStartOf(start + 60 * minute, 'UTC')).toBe('2026-11-02');
  });

  it('keeps a class that starts a margin after midnight and ends a margin before the next', () => {
    expect(new Date(classStart(at('2026-11-03T00:30:00Z'), 'UTC')).toISOString()).toBe('2026-11-03T00:30:00.000Z');
    expect(new Date(classStart(at('2026-11-03T00:25:00Z'), 'UTC')).toISOString()).toBe('2026-11-03T00:30:00.000Z');
    // 22:25 ends at 23:25, and a margin after that is still the same date; 22:30 would reach midnight.
    expect(new Date(classStart(at('2026-11-03T22:25:00Z'), 'UTC')).toISOString()).toBe('2026-11-03T22:25:00.000Z');
    expect(new Date(classStart(at('2026-11-03T22:30:00Z'), 'UTC')).toISOString()).toBe('2026-11-04T00:30:00.000Z');
  });

  it('measures midnight in the zone, not in UTC', () => {
    // 15:10Z is 00:10 on Monday in Tokyo (Sunday 23:59 there is 14:59Z): the class waits for 00:30 Tokyo.
    const start = classStart(at('2026-11-01T15:10:00Z'), 'Asia/Tokyo');
    expect(wall(start, 'Asia/Tokyo')).toEqual({ date: '2026-11-02', time: '00:30' });
    // The same instant is mid-afternoon in New York and needs no move.
    expect(classStart(at('2026-11-01T15:10:00Z'), 'America/New_York')).toBe(at('2026-11-01T15:10:00Z').getTime());
  });

  it('holds from any moment, in every zone, across the daylight saving changes', () => {
    const margin = 30 * minute, duration = 60 * minute;
    // Every 13 minutes over the days that hold each change, which makes every clock time and every offset appear.
    const starts = ['2026-03-07T00:00:00Z', '2026-03-28T00:00:00Z', '2026-04-03T12:00:00Z', '2026-10-02T12:00:00Z', '2026-10-24T00:00:00Z', '2026-10-31T00:00:00Z', '2026-11-01T00:00:00Z'];
    for (const zone of zones) for (const from of starts) for (let offset = 0; offset < 4 * 24 * 60; offset += 13) {
      const now = at(from).getTime() + offset * minute;
      for (const leadMinutes of [0, 30, 26 * 60]) {
        const start = classStart(now, zone, { leadMinutes });
        const where = `${zone} from ${new Date(now).toISOString()} lead ${leadMinutes}`;
        expect(start % (5 * minute), where).toBe(0);
        expect(start, where).toBeGreaterThanOrEqual(now + leadMinutes * minute);
        // Far from midnight on both sides: one calendar date, so the week is one too.
        const day = localDate(start, zone);
        expect(localDate(start - margin, zone), where).toBe(day);
        expect(localDate(start + duration + margin, zone), where).toBe(day);
        expect(weekStartOf(start - margin, zone), where).toBe(weekStartOf(start + duration + margin, zone));
        // It waits only as long as it must: at most to the next window, well under a day.
        expect(start - (now + leadMinutes * minute), where).toBeLessThan(24 * 60 * minute);
      }
    }
  });

  it('refuses a class that no day can hold', () => {
    expect(() => classStart(at('2026-11-03T12:00:00Z'), 'UTC', { durationMinutes: 24 * 60 })).toThrow(/clear of midnight/);
  });
});
