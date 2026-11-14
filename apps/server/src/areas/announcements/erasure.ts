// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gte, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { announcementRecipients, emailDeliveries, type Transaction } from '@plaingym/db';
import { cancellationNoticeKeyPrefix } from './cancellation.js';
import { announcementMessageId, erasedAddressDigest, noticeMemberId, recipientAnnouncementId, recipientDeliveryKey } from './erasure.sql.js';

/**
 * Called inside a member's erasure transaction. Announcement and cancellation notice records keep a digest of the
 * address they went to, so one address gets each message once; the erased member's records lose theirs, so no delivery
 * record holds a value derived from the address. Their keys (member and recipient IDs) and outcomes stay. Another member
 * still at that address could then get a copy of an announcement that is still being sent.
 */
export async function forgetErasedAddressDigests(tx: Transaction, gymId: string, memberId: string, erasedAddress?: string | null): Promise<void> {
  const keys = tx.select({ key: recipientDeliveryKey }).from(announcementRecipients)
    .where(and(eq(announcementRecipients.gymId, gymId), eq(announcementRecipients.memberId, memberId)));
  await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
    inArray(emailDeliveries.key, keys), isNotNull(emailDeliveries.commandDigest)));
  // Use the stored PostgreSQL normalization, and hash in SQL over indexed key ranges. A shared address may be keyed
  // by another member, including an announcement recipient that sent while this member was skipped as a duplicate.
  const digest = erasedAddress ? erasedAddressDigest(erasedAddress) : undefined;
  if (digest) {
    const messages = tx.select({ id: recipientAnnouncementId }).from(announcementRecipients)
      .where(and(eq(announcementRecipients.gymId, gymId), eq(announcementRecipients.memberId, memberId)));
    // Restrict to announcements this member received; other announcements' unrelated history stays intact.
    await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
      gte(emailDeliveries.key, 'announcement:'), lt(emailDeliveries.key, 'announcemenu'),
      inArray(announcementMessageId, messages), eq(emailDeliveries.commandDigest, digest)));
  }
  await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
    // Bound with the next letter: locale collations can sort a semicolon before the prefix's colon.
    gte(emailDeliveries.key, cancellationNoticeKeyPrefix), lt(emailDeliveries.key, 'schedule-cancel-noticf'),
    isNotNull(emailDeliveries.commandDigest), or(eq(noticeMemberId, memberId.toLowerCase()),
      digest ? eq(emailDeliveries.commandDigest, digest) : undefined)));
}
