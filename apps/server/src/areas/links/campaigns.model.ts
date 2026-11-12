// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, eq, gt, inArray, isNotNull, isNull, lte, max, ne, or } from 'drizzle-orm';
import { linkCampaignSchema, signedLinkSchema, type CampaignRecipient, type CampaignRecipientState, type LinkCampaignDetail,
  type LinkCampaignProgress } from '@plaingym/shared/contracts';
import { signedLinks, linkCampaigns, writeAudit, type Transaction } from '@plaingym/db';

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
 * Join grouped counts in one statement so all states share a snapshot. Called inside forGym.
 */
export async function campaignTallies(tx: Transaction, gymId: string, campaignIds: string[], now: Date) {
  const tallies = new Map<string, CampaignTally>();
  if (!campaignIds.length) return tallies;
  const scoped = and(eq(signedLinks.gymId, gymId), ne(signedLinks.purpose, 'unsubscribe'), inArray(signedLinks.campaignId, campaignIds));
  const all = tx.select({ campaignId: signedLinks.campaignId, total: count().as('total'), completed: count(signedLinks.usedAt).as('completed'),
    lastUsedAt: max(signedLinks.usedAt).as('last_used_at') }).from(signedLinks).where(scoped).groupBy(signedLinks.campaignId).as('all_links');
  const closed = tx.select({ campaignId: signedLinks.campaignId, closed: count().as('closed'), revoked: count(signedLinks.revokedAt).as('revoked') })
    .from(signedLinks).where(and(scoped, isNull(signedLinks.usedAt), or(isNotNull(signedLinks.revokedAt), lte(signedLinks.expiresAt, now))))
    .groupBy(signedLinks.campaignId).as('closed_links');
  const rows = await tx.select().from(all).leftJoin(closed, eq(all.campaignId, closed.campaignId));
  for (const { all_links: row, closed_links: ended } of rows) {
    const revoked = ended?.revoked ?? 0, expired = (ended?.closed ?? 0) - revoked;
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

/** Serialize the last recipients' completions, so a concurrent final completion sees the preceding commit. */
export async function completeCampaignIn(tx: Transaction, gymId: string, campaignId: string | null, now: Date) {
  if (!campaignId) return;
  const [campaign] = await tx.select().from(linkCampaigns).where(and(eq(linkCampaigns.gymId, gymId), eq(linkCampaigns.id, campaignId))).for('update');
  if (!campaign || campaign.completedAt) return;
  const tally = (await campaignTallies(tx, gymId, [campaignId], now)).get(campaignId);
  if (!tally || tally.progress.total === 0 || tally.progress.completed !== tally.progress.total) return;
  await tx.update(linkCampaigns).set({ completedAt: tally.lastUsedAt }).where(eq(linkCampaigns.id, campaignId));
  await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.completed', targetType: 'link_campaign',
    targetId: campaignId, after: { completedAt: tally.lastUsedAt!.toISOString() }, occurredAt: now });
}
