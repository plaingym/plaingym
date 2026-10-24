// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addCalendarMonths, advanceDue, householdNextDate, trialEnd } from './memberships.calendar.js';

describe('membership calendar dates', () => {
  it.each([
    ['2027-01-31', 1, '2027-02-28'], ['2028-01-31', 1, '2028-02-29'],
    ['2028-02-29', 12, '2029-02-28'], ['2027-12-31', 2, '2028-02-29'],
    ['2028-03-31', -1, '2028-02-29'], ['2028-01-31', 6, '2028-07-31'],
  ])('clamps %s plus %i months to %s', (date, months, expected) => {
    expect(addCalendarMonths(date, months)).toBe(expected);
  });
  it('recovers the household billing anchor after a short month', () => {
    expect(advanceDue('2028-02-29', 'monthly', 31)).toBe('2028-03-31');
    expect(advanceDue('2028-02-29', 'annual', 29)).toBe('2029-02-28');
  });
  it.each([
    ['2028-02-10', 31, '2028-02-29'], ['2028-02-29', 31, '2028-02-29'],
    ['2028-03-16', 15, '2028-04-15'], ['2028-12-16', 15, '2029-01-15'],
  ])('aligns a household joining on %s to day %i', (date, anchor, expected) => {
    expect(householdNextDate(date, anchor)).toBe(expected);
  });
  it('counts trial days as calendar days across DST and leap days', () => {
    expect(trialEnd('2028-03-10', 7)).toBe('2028-03-17');
    expect(trialEnd('2028-02-28', 2)).toBe('2028-03-01');
  });
  it('rejects invalid dates and intervals', () => {
    expect(() => addCalendarMonths('2028-02-30', 1)).toThrow();
    expect(() => addCalendarMonths('2028-02-29', 0.5)).toThrow();
    expect(() => advanceDue('2028-02-29', 'monthly', 0)).toThrow();
  });
});
