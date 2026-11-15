// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formatCount } from './count.js';

describe('display counts', () => {
  it.each([
    ['en-US', 1200, '1,200'], ['de-DE', 1200, '1.200'],
    ['en-IN', 1234567, '12,34,567'], ['en-US', -1200, '-1,200'],
    ['de-DE', 0, '0'], ['de-DE', 1, '1'],
  ])('formats %s count %s', (locale, count, expected) => {
    expect(formatCount(count, locale)).toBe(expected);
  });
  it('uses the browser locale by default', () => {
    expect(formatCount(1234567)).toBe(new Intl.NumberFormat().format(1234567));
  });
});
