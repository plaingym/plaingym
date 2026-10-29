// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { bookingOpensAt } from './bookings.rules.js';

it.each([
  ['2026-03-09T17:00:00Z', 1, '2026-03-08T05:00:00.000Z'],
  ['2026-11-02T18:00:00Z', 1, '2026-11-01T04:00:00.000Z'],
  ['2026-11-02T18:00:00Z', 0, '2026-11-02T05:00:00.000Z'],
])('opens %s at local midnight %s days earlier across DST', (start, days, expected) => {
  expect(bookingOpensAt(new Date(start), { timezone: 'America/New_York', bookingWindowDays: Number(days) }).toISOString()).toBe(expected);
});
