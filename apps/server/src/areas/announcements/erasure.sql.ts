// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed expression only concatenates recipient IDs from imported gym-owned columns; no raw table access.
import { sql } from 'drizzle-orm';
import { announcementRecipients, emailDeliveries } from '@plaingym/db';

/** Same ID-only key as announcementDeliveryKey, evaluated in the erasure's UPDATE subquery. */
export const recipientDeliveryKey = sql<string>`'announcement:' || ${announcementRecipients.announcementId}::text || ':' || ${announcementRecipients.id}::text`;

/** commandDigest([message ID, address]): JSON string escaping without the spaces json_build_array adds. */
export function erasedAddressDigest(address: string) {
  return sql<string>`encode(sha256(convert_to('[' || to_json(split_part(${emailDeliveries.key}, ':', 2))::text || ',' || to_json(${address}::text)::text || ']', 'UTF8')), 'hex')`;
}
/** Cancellation keys contain IDs only. Kept in SQL so erasure never loads the gym's notice history. */
export const noticeMemberId = sql<string>`split_part(${emailDeliveries.key}, ':', 3)`;
export const announcementMessageId = sql<string>`split_part(${emailDeliveries.key}, ':', 2)`;
export const recipientAnnouncementId = sql<string>`${announcementRecipients.announcementId}::text`;
