// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseInstant } from './mat.js';

describe('historical mat timestamps', () => {
  it.each([
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['2024-03-01T18:30', '2024-03-01T18:30:00.000Z'],
    ['2024-03-01 18:30:59.123456789', '2024-03-01T18:30:59.123Z'],
    ['2024-03-01T18:30:00-08:00', '2024-03-02T02:30:00.000Z'],
    ['2024-03-01T18:30:00+0530', '2024-03-01T13:00:00.000Z'],
    ['2024-03-01T18:30Z', '2024-03-01T18:30:00.000Z'],
  ])('parses %s explicitly in a UTC gym', (input, expected) => expect(parseInstant(input, 'UTC')?.toISOString()).toBe(expected));
  it.each([
    // Offset-free values are wall times at the gym, across standard and daylight time.
    ['2024-01-15T18:00', '2024-01-15T23:00:00.000Z'],
    ['2024-07-15 18:00:05.250', '2024-07-15T22:00:05.250Z'],
    // A date alone is the start of the gym's local day.
    ['2024-07-15', '2024-07-15T04:00:00.000Z'],
    // A time skipped when clocks go forward moves forward; a repeated one is the earlier instant.
    ['2024-03-10T02:30', '2024-03-10T07:30:00.000Z'],
    ['2024-11-03T01:30', '2024-11-03T05:30:00.000Z'],
    // An explicit offset or Z is an absolute instant whatever the gym's timezone.
    ['2024-07-15T18:00:00+02:00', '2024-07-15T16:00:00.000Z'],
    ['2024-07-15T18:00Z', '2024-07-15T18:00:00.000Z'],
  ])('reads %s in the gym timezone', (input, expected) => expect(parseInstant(input, 'America/Toronto')?.toISOString()).toBe(expected));
  it('starts a local day at its first instant where midnight is skipped', () => {
    // Santiago moved clocks from 00:00 to 01:00 on 2024-09-08.
    expect(parseInstant('2024-09-08', 'America/Santiago')?.toISOString()).toBe('2024-09-08T04:00:00.000Z');
  });
  it.each(['2023-02-29', '2024-04-31', '2024-00-01', '2024-13-01', '2024-01-00',
    '2024-01-01T24:00', '2024-01-01T00:60', '2024-01-01T00:00:60', '2024-01-01T00:00+15:00',
    '2024-01-01T00:00+01:60', '03/01/2024', '1899-12-31', '', 'yesterday'])('rejects %s', (input) => {
    expect(parseInstant(input, 'America/Toronto')).toBeNull();
  });
});
