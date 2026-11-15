// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { formatCount } from './count.js';

it.each([['en', '1,200'], ['de-DE', '1.200'], ['en-IN', '1,200']])('formats receipt quantities in %s', (locale, expected) => {
  expect(formatCount(1200, locale)).toBe(expected);
});
