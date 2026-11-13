// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import { announcementRecipients, emailDeliveries, type Transaction } from '@plaingym/db';
import { cancellationNoticeKeyPrefix } from './cancellation.js';
import { commandDigest } from '../../infra/email/deliveries.js';
import { recipientDeliveryKey } from './erasure.sql.js';

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
  // The caller reads the stored PostgreSQL normalization before clearing the member, matching the send digest exactly.
  const address = erasedAddress || undefined;
  // Walk only the indexed cancellation-key range, with bounded memory. A shared address can be keyed by another member.
  let cursor: string | undefined;
  for (;;) {
    const rows = await tx.select({ id: emailDeliveries.id, key: emailDeliveries.key, digest: emailDeliveries.commandDigest })
      .from(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId),
        // Bound with the next letter: locale collations can sort a semicolon before the prefix's colon.
        gte(emailDeliveries.key, cancellationNoticeKeyPrefix), lt(emailDeliveries.key, 'schedule-cancel-noticf'),
        cursor ? gt(emailDeliveries.key, cursor) : undefined, isNotNull(emailDeliveries.commandDigest)))
      .orderBy(asc(emailDeliveries.key)).limit(500);
    const ids = rows.filter(row => row.key.endsWith(':' + memberId.toLowerCase()) ||
      (address && row.digest === commandDigest([row.key.split(':')[1], address]))).map(row => row.id);
    if (ids.length) await tx.update(emailDeliveries).set({ commandDigest: null })
      .where(and(eq(emailDeliveries.gymId, gymId), inArray(emailDeliveries.id, ids)));
    if (rows.length < 500) break;
    cursor = rows.at(-1)!.key;
  }
}
