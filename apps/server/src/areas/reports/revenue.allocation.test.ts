// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { allocatePayment, allocateRevenue } from './revenue.allocation.js';

describe('integer revenue allocation', () => {
  it('breaks tied remainders by line ID independently of input order', () => {
    expect(allocateRevenue(2, [{ id: 'c', amount: 1 }, { id: 'b', amount: 1 }, { id: 'a', amount: 1 }]))
      .toEqual([{ id: 'c', amount: 0 }, { id: 'b', amount: 1 }, { id: 'a', amount: 1 }]);
  });
  it('allocates a partial refund over plan, signup fee, signed family discount and tax', () => {
    expect(allocateRevenue(3301, [{ id: 'a', amount: 10000 }, { id: 'b', amount: 2000 },
      { id: 'c', amount: -2000 }, { id: 'd', amount: 1000 }]).map(part => part.amount)).toEqual([3001, 600, -600, 300]);
  });
  it('handles odd payments in whole yen without decimal conversion', () => {
    const paid = allocatePayment(7, 11, [{ id: 'a', amount: 7 }, { id: 'b', amount: 3 }, { id: 'c', amount: 1 }]);
    expect(paid.map(part => part.amount)).toEqual([4, 2, 1, 0]);
    expect(allocateRevenue(3, paid).map(part => part.amount)).toEqual([2, 1, 0, 0]);
  });
  it('keeps excess, zero invoices, missing lines and rejected payments unapplied', () => {
    const lines = [{ id: 'a', amount: 9 }, { id: 'b', amount: 1 }];
    expect(allocatePayment(13, 10, lines).map(part => part.amount)).toEqual([9, 1, 3]);
    expect(allocateRevenue(7, allocatePayment(13, 10, lines)).map(part => part.amount)).toEqual([5, 0, 2]);
    expect(allocatePayment(13, 10, lines, false).map(part => part.amount)).toEqual([0, 0, 13]);
    expect(allocatePayment(13, 0, [])).toEqual([{ id: 'unapplied', amount: 13 }]);
    expect(allocatePayment(13, 10, [])).toEqual([{ id: 'unapplied', amount: 13 }]);
  });
  it('keeps sums exact across signed weights, partial amounts and large integer products', () => {
    for (let amount = 0; amount < 250; amount++) {
      const parts = allocateRevenue(amount, [{ id: 'a', amount: 101 }, { id: 'b', amount: -17 }, { id: 'c', amount: 29 }]);
      expect(parts.reduce((sum, part) => sum + part.amount, 0)).toBe(amount);
      expect(parts.every(part => Number.isSafeInteger(part.amount))).toBe(true);
      expect(parts[1]!.amount).toBeLessThanOrEqual(0);
    }
    expect(allocateRevenue(2147483647, [{ id: 'a', amount: 2147483646 }, { id: 'b', amount: 1 }])
      .map(part => part.amount)).toEqual([2147483646, 1]);
  });
  it('rejects invalid integer inputs, nonpositive weights and duplicate IDs', () => {
    expect(() => allocateRevenue(1.5, [{ id: 'a', amount: 1 }])).toThrow(RangeError);
    expect(() => allocateRevenue(1, [{ id: 'a', amount: -1 }])).toThrow(RangeError);
    expect(() => allocateRevenue(-1, [{ id: 'a', amount: 1 }])).toThrow(RangeError);
    expect(() => allocateRevenue(1, [{ id: 'a', amount: 1 }, { id: 'a', amount: 1 }])).toThrow(RangeError);
    expect(() => allocatePayment(Number.MAX_SAFE_INTEGER + 1, 10, [])).toThrow(RangeError);
  });
});
