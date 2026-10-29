// SPDX-License-Identifier: AGPL-3.0-only
/** One promotion with its rank's position in the rank-system ordering. */
export interface RankedPromotion {
  readonly rankId: string; readonly subRank: number; readonly position: number;
  readonly promotedAt: Date; readonly createdAt: Date; readonly id: string;
}
export interface RankStep { readonly id: string; readonly position: number; readonly subRanks: readonly unknown[] }

/** Latest first: the order staff eligibility and the portal both use to find a member's current rank. */
export function promotionOrder(a: RankedPromotion, b: RankedPromotion) {
  return b.promotedAt.getTime() - a.promotedAt.getTime() || b.position - a.position || b.subRank - a.subRank
    || b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
/** A member can still receive a rank unless they hold a later rank or this rank's last sub-rank. */
export function canReceive(previous: Pick<RankedPromotion, 'rankId' | 'subRank' | 'position'> | undefined, target: RankStep) {
  return !previous || !(previous.position > target.position
    || (previous.rankId === target.id && previous.subRank >= target.subRanks.length));
}
/** The sub-rank a promotion to this rank would award. */
export function nextSubRank(previous: Pick<RankedPromotion, 'rankId' | 'subRank'> | undefined, target: Pick<RankStep, 'id'>) {
  return previous?.rankId === target.id ? previous.subRank + 1 : 0;
}
/** The first step the member can still receive, in rank-system order; the current rank's next sub-rank comes first. */
export function nextPromotion<T extends RankStep>(previous: Pick<RankedPromotion, 'rankId' | 'subRank' | 'position'>, ranks: readonly T[]) {
  const ordered = [...ranks].sort((a, b) => a.position - b.position
    || Number(b.id === previous.rankId) - Number(a.id === previous.rankId) || a.id.localeCompare(b.id));
  const rank = ordered.find(item => canReceive(previous, item));
  return rank ? { rank, subRank: nextSubRank(previous, rank) } : null;
}
