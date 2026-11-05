// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, eq, gt, inArray, isNotNull, isNull, lte, max, or } from 'drizzle-orm';
import { linkCampaignSchema, signedLinkSchema, type CampaignRecipient, type CampaignRecipientState, type LinkCampaignDetail,
  type LinkCampaignProgress } from '@plaingym/shared/contracts';
import { signedLinks, type linkCampaigns, type Transaction } from '@plaingym/db';

export function campaignRecipient(row: typeof signedLinks.$inferSelect, now: Date): CampaignRecipient {
  return {
    link: signedLinkSchema.parse({ id: row.id, householdId: row.householdId, campaignId: row.campaignId,
      purpose: row.purpose, invoiceId: row.invoiceId, memberId: row.memberId, createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
      usedAt: row.usedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null }),
    state: row.usedAt ? 'completed' : row.revokedAt ? 'revoked' : row.expiresAt <= now ? 'expired' : 'pending',
  };
}

/** The filter for one recipient state, partitioned as `campaignRecipient` assigns them: used, revoked, expired, then pending. */
export function recipientState(state: CampaignRecipientState, now: Date) {
  if (state === 'completed') return isNotNull(signedLinks.usedAt);
  const unused = isNull(signedLinks.usedAt);
  if (state === 'revoked') return and(unused, isNotNull(signedLinks.revokedAt));
  return and(unused, isNull(signedLinks.revokedAt), state === 'expired' ? lte(signedLinks.expiresAt, now) : gt(signedLinks.expiresAt, now));
}

export interface CampaignTally { progress: LinkCampaignProgress; lastUsedAt: Date | null }
/**
 * Each campaign's progress, counted in the database with two `GROUP BY campaign_id` queries: every link (total, used and
 * the latest use), and the unused links that are closed (revoked or expired). Called inside forGym.
 */
export async function campaignTallies(tx: Transaction, gymId: string, campaignIds: string[], now: Date) {
  const tallies = new Map<string, CampaignTally>();
  if (!campaignIds.length) return tallies;
  const scoped = and(eq(signedLinks.gymId, gymId), inArray(signedLinks.campaignId, campaignIds));
  const all = await tx.select({ campaignId: signedLinks.campaignId, total: count(), completed: count(signedLinks.usedAt),
    lastUsedAt: max(signedLinks.usedAt) }).from(signedLinks).where(scoped).groupBy(signedLinks.campaignId);
  const closed = await tx.select({ campaignId: signedLinks.campaignId, closed: count(), revoked: count(signedLinks.revokedAt) })
    .from(signedLinks).where(and(scoped, isNull(signedLinks.usedAt), or(isNotNull(signedLinks.revokedAt), lte(signedLinks.expiresAt, now))))
    .groupBy(signedLinks.campaignId);
  const closedBy = new Map(closed.map(row => [row.campaignId, row]));
  for (const row of all) {
    const ended = closedBy.get(row.campaignId), revoked = ended?.revoked ?? 0, expired = (ended?.closed ?? 0) - revoked;
    tallies.set(row.campaignId!, { lastUsedAt: row.lastUsedAt, progress: { total: row.total, completed: row.completed, revoked, expired,
      pending: row.total - row.completed - revoked - expired } });
  }
  return tallies;
}

/** Completion is read from the same rows the signed-link completion paths commit, without a polling delay. */
export function campaignDetail(row: typeof linkCampaigns.$inferSelect, tally: CampaignTally | undefined): LinkCampaignDetail {
  const progress = tally?.progress ?? { total: 0, pending: 0, completed: 0, expired: 0, revoked: 0 };
  const completedAt = progress.total > 0 && progress.completed === progress.total ? tally!.lastUsedAt!.toISOString() : null;
  return { campaign: linkCampaignSchema.parse({ id: row.id, name: row.name, purpose: row.purpose,
    createdBy: row.createdBy, reminderSchedule: row.reminderSchedule, createdAt: row.createdAt.toISOString(), completedAt }), progress };
}
