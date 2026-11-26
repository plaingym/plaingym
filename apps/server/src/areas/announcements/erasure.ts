// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, inArray, isNotNull, like, lt, or } from 'drizzle-orm';
import { announcementRecipients, announcementSmsRecipients, emailDeliveries, members, smsDeliveries, type Transaction } from '@plaingym/db';
import { cancellationNoticeKeyPrefix } from './cancellation.js';
import { cancellationSmsKeyPrefix } from './cancellation.sms.js';
import { restoreNoticeKeyPrefix } from './restored.js';
import { restoreSmsKeyPrefix } from './restored.sms.js';
import { announcementSmsKey } from './send.sms.js';
import { erasedAddressDigest, erasedCampaignSmsKey, erasedRestoreDigest, legacyCampaignSmsKey,
  noticeMemberId, recipientAddressDigest, recipientDeliveryKey, smsRecipientIncludes, thirdSmsKeyPart } from './erasure.sql.js';

async function forgetAnnouncementSms(tx: Transaction, gymId: string, memberId: string, deleting: boolean) {
  const rows = await tx.select().from(announcementSmsRecipients).where(and(eq(announcementSmsRecipients.gymId, gymId),
    or(eq(announcementSmsRecipients.memberId, memberId), smsRecipientIncludes(memberId))))
    .orderBy(asc(announcementSmsRecipients.id)).for('update');
  for (const row of rows) {
    const memberIds = row.memberIds.filter(id => id !== memberId);
    const key = announcementSmsKey(row.announcementId, row.id), legacyKey = announcementSmsKey(row.announcementId, row.memberId);
    const deliveryWhere = eq(smsDeliveries.gymId, gymId);
    const deliveries = await tx.update(smsDeliveries).set({ commandDigest: null }).where(and(deliveryWhere,
      or(inArray(smsDeliveries.key, [key, legacyKey]),
        row.phoneDigest ? eq(smsDeliveries.commandDigest, `announcement-sms:${row.announcementId}:${row.phoneDigest}`) : undefined)))
      .returning({ key: smsDeliveries.key });
    const hasKey = deliveries.some(delivery => delivery.key === key || delivery.key === legacyKey);
    const anchorLeaving = row.memberId === memberId;
    const rowWhere = and(eq(announcementSmsRecipients.gymId, gymId), eq(announcementSmsRecipients.id, row.id));
    if (deleting && !memberIds.length) {
      await tx.delete(announcementSmsRecipients).where(rowWhere);
      continue;
    }
    // Hard deletion must move the foreign key. A legacy reservation follows the group by its row ID.
    if (deleting && anchorLeaving && deliveries.some(delivery => delivery.key === legacyKey))
      await tx.update(smsDeliveries).set({ key }).where(and(deliveryWhere, eq(smsDeliveries.key, legacyKey)));
    // A soft-erased singleton remains as anonymous history with a required member FK and nonempty snapshot.
    await tx.update(announcementSmsRecipients).set(memberIds.length ? {
      memberIds, ...(anchorLeaving && (deleting || (row.state === 'pending' && !hasKey)) ? { memberId: memberIds[0]! } : {}),
    } : { phoneDigest: null, memberIds: [row.memberId] }).where(rowWhere);
  }
}

/**
 * Called inside a member's erasure or deletion transaction. Announcement, cancellation and restore notice emails keep a digest of
 * the address they went to, so one address gets each message once; the erased member's records lose theirs, so no
 * delivery record holds a value derived from the address. Their keys (member and recipient IDs) and outcomes stay.
 * Another member still at that email address could then get a copy of an announcement that is still being sent.
 *
 * Texts: the member leaves shared announcement groups, and a pending group keeps its phone digest for the members who
 * remain, so their text still goes once. Announcement and member-keyed cancellation and restore text records lose their digests.
 * Older card campaign keys that end in a phone digest are rewritten to an ID-only key that still prevents replay.
 */
export async function forgetErasedAddressDigests(tx: Transaction, gymId: string, memberId: string, erasedAddress?: string | null, deleting = false): Promise<void> {
  memberId = memberId.toLowerCase();
  await forgetAnnouncementSms(tx, gymId, memberId, deleting);
  // A class notice text is keyed by its group's first member, with `.<n>` when that member was regrouped after a retry.
  const memberKeyed = or(eq(thirdSmsKeyPart, memberId), like(thirdSmsKeyPart, `${memberId}.%`));
  await tx.update(smsDeliveries).set({ commandDigest: null }).where(and(eq(smsDeliveries.gymId, gymId),
    gte(smsDeliveries.key, cancellationSmsKeyPrefix), lt(smsDeliveries.key, 'schedule-cancel-smt'),
    isNotNull(smsDeliveries.commandDigest), memberKeyed));
  await tx.update(smsDeliveries).set({ commandDigest: null }).where(and(eq(smsDeliveries.gymId, gymId),
    gte(smsDeliveries.key, restoreSmsKeyPrefix), lt(smsDeliveries.key, 'schedule-restore-smt'),
    isNotNull(smsDeliveries.commandDigest), memberKeyed));
  const [member] = await tx.select({ householdId: members.householdId }).from(members)
    .where(and(eq(members.gymId, gymId), eq(members.id, memberId)));
  if (member) await tx.update(smsDeliveries).set({ key: erasedCampaignSmsKey }).where(and(eq(smsDeliveries.gymId, gymId),
    gte(smsDeliveries.key, 'links.campaign.sms:'), lt(smsDeliveries.key, 'links.campaign.smt'),
    eq(thirdSmsKeyPart, member.householdId), legacyCampaignSmsKey));
  const keys = tx.select({ key: recipientDeliveryKey }).from(announcementRecipients)
    .where(and(eq(announcementRecipients.gymId, gymId), eq(announcementRecipients.memberId, memberId)));
  await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
    inArray(emailDeliveries.key, keys), isNotNull(emailDeliveries.commandDigest)));
  // Use the stored PostgreSQL normalization. A shared address may be keyed
  // by another member, including an announcement recipient that sent while this member was skipped as a duplicate.
  const digest = erasedAddress ? erasedAddressDigest(erasedAddress) : undefined;
  if (digest) {
    const digests = tx.selectDistinct({ digest: recipientAddressDigest(erasedAddress!) }).from(announcementRecipients)
      .where(and(eq(announcementRecipients.gymId, gymId), eq(announcementRecipients.memberId, memberId)));
    // Restrict to announcements this member received; other announcements' unrelated history stays intact.
    await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
      inArray(emailDeliveries.commandDigest, digests)));
  }
  await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
    // Bound with the next letter: locale collations can sort a semicolon before the prefix's colon.
    gte(emailDeliveries.key, cancellationNoticeKeyPrefix), lt(emailDeliveries.key, 'schedule-cancel-noticf'),
    isNotNull(emailDeliveries.commandDigest), or(eq(noticeMemberId, memberId.toLowerCase()),
      digest ? eq(emailDeliveries.commandDigest, digest) : undefined)));
  await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
    gte(emailDeliveries.key, restoreNoticeKeyPrefix), lt(emailDeliveries.key, 'schedule-restore-noticf'),
    isNotNull(emailDeliveries.commandDigest), or(eq(noticeMemberId, memberId),
      erasedAddress ? eq(emailDeliveries.commandDigest, erasedRestoreDigest(erasedAddress)) : undefined)));
}
