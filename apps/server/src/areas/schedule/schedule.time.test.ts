// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addDays, localDate, occurrences, wallTime } from './schedule.time.js';
describe('gym calendar materialization', () => {
  it.each([
    ['2026-03-08', '02:30', 'America/New_York', null],
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe', null],
    ['2026-04-05', '01:45', 'Australia/Lord_Howe', '2026-04-04T14:45:00.000Z'],
    ['2026-10-22', '00:00', 'Asia/Kathmandu', '2026-10-21T18:15:00.000Z'],
    ['2011-12-30', '12:00', 'Pacific/Apia', null],
  ])('resolves %s %s in %s deterministically', (date, time, zone, expected) => {
    expect(wallTime(date, time, zone)?.toISOString() ?? null).toBe(expected);
  });
  it('preserves local start times for eight calendar weeks across spring DST', () => {
    const starts = occurrences({ weekday: 0, localStartTime: '18:00' }, new Date('2026-03-01T00:00:00Z'), 'America/New_York');
    expect(starts).toHaveLength(8);
    expect(starts[0]!.toISOString()).toBe('2026-03-01T23:00:00.000Z');
    expect(starts[1]!.toISOString()).toBe('2026-03-08T22:00:00.000Z');
    expect(starts.map((start) => localDate(start, 'America/New_York'))).toEqual(Array.from({ length: 8 }, (_, index) => addDays('2026-03-01', index * 7)));
  });
  it('creates one occurrence in a fall fold and skips a spring gap', () => {
    const fall = occurrences({ weekday: 0, localStartTime: '01:30' }, new Date('2026-10-25T00:00:00Z'), 'America/New_York');
    expect(fall).toHaveLength(8);
    expect(fall[1]!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(fall[2]!.toISOString()).toBe('2026-11-08T06:30:00.000Z');
    const spring = occurrences({ weekday: 0, localStartTime: '02:30' }, new Date('2026-03-01T00:00:00Z'), 'America/New_York');
    expect(spring).toHaveLength(7);
    expect(spring.map((start) => localDate(start, 'America/New_York'))).not.toContain('2026-03-08');
  });
  it('uses the gym date at the horizon and excludes occurrences that already started', () => {
    const now = new Date('2026-10-22T02:00:00Z');
    expect(localDate(now, 'America/Vancouver')).toBe('2026-10-21');
    expect(occurrences({ weekday: 3, localStartTime: '18:00' }, now, 'America/Vancouver')).toHaveLength(7);
    expect(occurrences({ weekday: 3, localStartTime: '19:00' }, now, 'America/Vancouver')[0]).toEqual(now);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
