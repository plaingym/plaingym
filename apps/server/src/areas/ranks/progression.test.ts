// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { canReceive, nextPromotion, nextSubRank, promotionOrder } from './progression.js';

const ranks = [
  { id: 'c', position: 2, subRanks: [] },
  { id: 'a', position: 0, subRanks: [{}, {}] },
  { id: 'b', position: 1, subRanks: [] },
];
const held = (rankId: string, subRank: number, position: number) => ({ rankId, subRank, position });

it('selects the first rank without history and prefers the current sub-rank when positions tie', () => {
  expect(nextPromotion(undefined, [])).toBeNull();
  expect(nextPromotion(undefined, ranks)).toMatchObject({ rank: { id: 'a' }, subRank: 0 });
  const tied = [{ id: 'a', position: 0, subRanks: [] }, { id: 'z', position: 0, subRanks: [{}] }];
  expect(nextPromotion(held('z', 0, 0), tied)).toMatchObject({ rank: { id: 'z' }, subRank: 1 });
});

it('moves through sub-ranks before the next rank, and stops at the top', () => {
  expect(nextPromotion(held('a', 0, 0), ranks)).toMatchObject({ rank: { id: 'a' }, subRank: 1 });
  expect(nextPromotion(held('a', 2, 0), ranks)).toMatchObject({ rank: { id: 'b' }, subRank: 0 });
  expect(nextPromotion(held('b', 0, 1), ranks)).toMatchObject({ rank: { id: 'c' }, subRank: 0 });
  expect(nextPromotion(held('c', 0, 2), ranks)).toBeNull();
});
it('matches the eligibility candidate rule', () => {
  expect(canReceive(undefined, ranks[0]!)).toBe(true);
  expect(canReceive(held('c', 0, 2), ranks[1]!)).toBe(false);
  expect(canReceive(held('a', 2, 0), ranks[1]!)).toBe(false);
  expect(nextSubRank(held('a', 1, 0), ranks[1]!)).toBe(2);
  expect(nextSubRank(undefined, ranks[1]!)).toBe(0);
});
it('orders the latest promotion first by date, then rank, sub-rank, creation and ID', () => {
  const entry = (id: string, promotedAt: string, position = 0, subRank = 0) =>
    ({ id, rankId: 'a', subRank, position, promotedAt: new Date(promotedAt), createdAt: new Date('2026-01-01Z') });
  const sorted = [entry('1', '2026-01-01Z'), entry('2', '2026-02-01Z'), entry('3', '2026-02-01Z', 1), entry('4', '2026-02-01Z', 1, 1)].sort(promotionOrder);
  expect(sorted.map(row => row.id)).toEqual(['4', '3', '2', '1']);
});
