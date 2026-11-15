// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { formatMinorUnits } from '@plaingym/shared/money';
import { formatCount } from './count.js';

describe('display counts', () => {
  it.each([
    [1200, '1,200'], [1234567, '1,234,567'], [-1200, '-1,200'], [0, '0'], [1, '1'],
  ])('formats count %s in English', (count, expected) => {
    expect(formatCount(count)).toBe(expected);
  });
  it('keeps English counts beside English money in a German browser', () => {
    const NativeNumberFormat = Intl.NumberFormat;
    const numbers = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locale, options) {
      return new NativeNumberFormat(locale ?? 'de-DE', options);
    });
    try {
      expect(new Intl.NumberFormat().format(1234)).toBe('1.234');
      expect(`${formatCount(1234)} × ${formatMinorUnits(123400, 'USD')}`).toBe('1,234 × $1,234.00');
    } finally { numbers.mockRestore(); }
  });
});
