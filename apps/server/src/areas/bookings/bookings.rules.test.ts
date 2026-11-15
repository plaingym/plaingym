// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { bookingOpensAt, cancellationCutoffAt, cutoffPassed, openPlaces } from './bookings.rules.js';

it.each([
  ['2026-03-09T17:00:00Z', 1, '2026-03-08T05:00:00.000Z'],
  ['2026-11-02T18:00:00Z', 1, '2026-11-01T04:00:00.000Z'],
  ['2026-11-02T18:00:00Z', 0, '2026-11-02T05:00:00.000Z'],
])('opens %s at local midnight %s days earlier across DST', (start, days, expected) => {
  expect(bookingOpensAt(new Date(start), { timezone: 'America/New_York', bookingWindowDays: Number(days) }).toISOString()).toBe(expected);
});
it('allows cancellation through the cutoff instant and not after it', () => {
  const session = { startsAt: new Date('2026-10-30T18:00:00Z') }, settings = { cancellationCutoffMinutes: 90 };
  const cutoff = cancellationCutoffAt(session, settings);
  expect(cutoff.toISOString()).toBe('2026-10-30T16:30:00.000Z');
  expect(cutoffPassed(session, settings, cutoff)).toBe(false);
  expect(cutoffPassed(session, settings, new Date(cutoff.getTime() + 1))).toBe(true);
});
it('reserves only the places promotion can fill before offering remaining capacity', () => {
  const booked = { status: 'booked' as const }, waiting = { status: 'waitlisted' as const };
  expect(openPlaces(3, [booked], 0)).toBe(2);
  expect(openPlaces(2, [booked, booked], 0)).toBe(0);
  expect(openPlaces(3, [booked, waiting], 1)).toBe(1);
  expect(openPlaces(3, [booked, waiting], 0)).toBe(2);
  expect(openPlaces(1, [booked, booked], 0)).toBe(0);
});
