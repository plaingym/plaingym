// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addDays, isCalendarDate, localDate, localMidnight, monthStart, nextMonth, sqlInstant, startOfWeek, timeZoneId, weekday, zonedInstant } from '@plaingym/shared/time';

describe('shared time conversions', () => {
  it.each([
    ['2024-01-31', '2024-01-01', '2024-02-01', '2023-12-01'],
    ['2024-02-29', '2024-02-01', '2024-03-01', '2024-01-01'],
    ['2026-12-31', '2026-12-01', '2027-01-01', '2026-11-01'],
  ])('steps whole months from %s', (date, first, next, previous) => {
    expect(monthStart(date)).toBe(first); expect(nextMonth(date)).toBe(next); expect(nextMonth(date, -1)).toBe(previous);
  });
  it.each([['2026-01-01', '2025-12-29'], ['2026-11-01', '2026-10-26'], ['2026-11-02', '2026-11-02']])('starts the Monday week containing %s', (date, monday) => {
    expect(startOfWeek(date)).toBe(monday);
  });
  it('uses local midnight across DST and a skipped midnight', () => {
    expect(localMidnight('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(localMidnight('2018-11-04', 'America/Sao_Paulo').toISOString()).toBe('2018-11-04T03:00:00.000Z');
  });
  it('serializes ordinary and expanded years for SQL without changing their instants', () => {
    expect(sqlInstant(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(sqlInstant(new Date('+010000-01-01T00:00:00Z'))).toBe('10000-01-01T00:00:00.000Z');
  });
  it('names a zone in its canonical case without resolving links', () => {
    for (const [zone, id] of [['asia/kolkata', 'Asia/Kolkata'], ['EUROPE/KYIV', 'Europe/Kyiv'], ['us/pacific', 'US/Pacific'], ['utc', 'UTC']] as const)
      expect(timeZoneId(zone)).toBe(id);
    expect(() => timeZoneId('Mars/Olympus')).toThrow();
  });
  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    for (const value of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-4-1', '2026-04-01T00:00', '']) expect(isCalendarDate(value)).toBe(false);
  });
  it('numbers weekdays as Date#getUTCDay does', () => {
    for (let day = 0; day < 7; day++) {
      const date = addDays('2026-10-18', day);
      expect(weekday(date)).toBe(new Date(date + 'T12:00:00Z').getUTCDay());
    }
  });
  it('reads the gym-local calendar date of an instant', () => {
    expect(localDate(new Date('2026-10-23T03:30:00Z'), 'America/Toronto')).toBe('2026-10-22');
    expect(localDate(new Date('2026-10-23T03:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-23');
  });
  it('converts wall times, taking the earlier instant when clocks go back', () => {
    expect(zonedInstant('2026-07-14', '18:00', 'America/Toronto', { gap: 'skip' })?.toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(zonedInstant('2026-01-14', '18:00', 'America/Toronto', { gap: 'skip' })?.toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(zonedInstant('2026-11-01', '01:30', 'America/Toronto', { gap: 'shift' })?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
  it('skips or shifts a time that clocks jump over', () => {
    expect(zonedInstant('2026-03-08', '02:30', 'America/Toronto', { gap: 'skip' })).toBeNull();
    expect(zonedInstant('2026-03-08', '02:30', 'America/Toronto', { gap: 'shift' })?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('rejects impossible dates and times instead of rolling them over', () => {
    expect(() => zonedInstant('2026-02-30', '10:00', 'UTC', { gap: 'skip' })).toThrow(RangeError);
    expect(() => zonedInstant('2026-02-10', '24:30', 'UTC', { gap: 'skip' })).toThrow(RangeError);
  });
});
