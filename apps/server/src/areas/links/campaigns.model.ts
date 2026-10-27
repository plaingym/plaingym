// SPDX-License-Identifier: AGPL-3.0-only
import { linkCampaignSchema, signedLinkSchema, type CampaignRecipient, type LinkCampaignDetail } from '@plaingym/shared/contracts';
import type { linkCampaigns, signedLinks } from '@plaingym/db';

export function campaignRecipient(row: typeof signedLinks.$inferSelect, now: Date): CampaignRecipient {
  return {
    link: signedLinkSchema.parse({ id: row.id, householdId: row.householdId, campaignId: row.campaignId,
      purpose: row.purpose, invoiceId: row.invoiceId, memberId: row.memberId, createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
      usedAt: row.usedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null }),
    state: row.usedAt ? 'completed' : row.revokedAt ? 'revoked' : row.expiresAt <= now ? 'expired' : 'pending',
  };
}

/** Completion is read from the same rows the signed-link completion paths commit, without a polling delay. */
export function campaignDetail(row: typeof linkCampaigns.$inferSelect, recipients: CampaignRecipient[]): LinkCampaignDetail {
  const progress = { total: recipients.length, pending: 0, completed: 0, expired: 0, revoked: 0 };
  for (const recipient of recipients) progress[recipient.state]++;
  const completedAt = progress.total > 0 && progress.completed === progress.total
    ? recipients.map(r => r.link.usedAt!).sort().at(-1)! : null;
  return { campaign: linkCampaignSchema.parse({ id: row.id, name: row.name, purpose: row.purpose,
    createdBy: row.createdBy, reminderSchedule: row.reminderSchedule, createdAt: row.createdAt.toISOString(), completedAt }), progress };
}
