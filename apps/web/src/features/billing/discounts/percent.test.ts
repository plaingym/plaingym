// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { basisPointsToPercent, percentToBasisPoints } from './percent.js';

it.each([['0.01', 1], ['0.1', 10], ['1', 100], ['12.5', 1250], ['99.99', 9999], ['100', 10_000]] as const)('preserves %s percent exactly', (input, expected) => {
  expect(percentToBasisPoints(input)).toBe(expected);
  expect(basisPointsToPercent(expected)).toBe(input);
});
it.each(['0', '100.01', '0.001', '12.345', '-1', '1e2', 'NaN'])('rejects unsupported percentage %s', input => {
  expect(() => percentToBasisPoints(input)).toThrow();
});
