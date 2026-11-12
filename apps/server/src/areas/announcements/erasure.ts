// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNotNull, like } from 'drizzle-orm';
import { announcementRecipients, emailDeliveries, type Transaction } from '@plaingym/db';
import { cancellationNoticeKeyPrefix } from './cancellation.js';
import { announcementDeliveryKey } from './send.delivery.js';

const chunk = 500;

/**
 * Called inside a member's erasure transaction. Announcement and cancellation notice records keep a digest of the
 * address they went to, so one address gets each message once; the erased member's records lose theirs, so no delivery
 * record holds a value derived from the address. Their keys (member and recipient IDs) and outcomes stay. Another member
 * still at that address could then get a copy of an announcement that is still being sent.
 */
export async function forgetErasedAddressDigests(tx: Transaction, gymId: string, memberId: string): Promise<void> {
  const recipients = await tx.select({ id: announcementRecipients.id, announcementId: announcementRecipients.announcementId })
    .from(announcementRecipients).where(and(eq(announcementRecipients.gymId, gymId), eq(announcementRecipients.memberId, memberId)));
  const keys = recipients.map(row => announcementDeliveryKey(row.announcementId, row.id));
  for (let start = 0; start < keys.length; start += chunk)
    await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
      inArray(emailDeliveries.key, keys.slice(start, start + chunk)), isNotNull(emailDeliveries.commandDigest)));
  // A cancellation notice is keyed by session and member; member IDs are UUIDs, so the pattern has no wildcard of its own.
  await tx.update(emailDeliveries).set({ commandDigest: null }).where(and(eq(emailDeliveries.gymId, gymId),
    like(emailDeliveries.key, cancellationNoticeKeyPrefix + '%:' + memberId.toLowerCase()), isNotNull(emailDeliveries.commandDigest)));
}
