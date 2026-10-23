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
  ])('parses %s explicitly', (input, expected) => expect(parseInstant(input)?.toISOString()).toBe(expected));
  it.each(['2023-02-29', '2024-04-31', '2024-00-01', '2024-13-01', '2024-01-00',
    '2024-01-01T24:00', '2024-01-01T00:60', '2024-01-01T00:00:60', '2024-01-01T00:00+15:00',
    '2024-01-01T00:00+01:60', '03/01/2024', '1899-12-31', '', 'yesterday'])('rejects %s', (input) => {
    expect(parseInstant(input)).toBeNull();
  });
});
