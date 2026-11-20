// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed expressions use imported gym-owned columns.
import { sql } from 'drizzle-orm';
import { announcementRecipients, announcementSmsRecipients, emailDeliveries, smsDeliveries } from '@plaingym/db';

/** Same ID-only key as announcementDeliveryKey, evaluated in the erasure's UPDATE subquery. */
export const recipientDeliveryKey = sql<string>`'announcement:' || ${announcementRecipients.announcementId}::text || ':' || ${announcementRecipients.id}::text`;

/** Compute once per known announcement, so the UPDATE probes the command digest index. */
export function recipientAddressDigest(address: string) {
  return sql<string>`encode(sha256(convert_to('[' || to_json(${announcementRecipients.announcementId}::text)::text || ',' || to_json(${address}::text)::text || ']', 'UTF8')), 'hex')`;
}

/** commandDigest([message ID, address]): JSON string escaping without the spaces json_build_array adds. */
export function erasedAddressDigest(address: string) {
  return sql<string>`encode(sha256(convert_to('[' || to_json(split_part(${emailDeliveries.key}, ':', 2))::text || ',' || to_json(${address}::text)::text || ']', 'UTF8')), 'hex')`;
}
/** Cancellation keys contain IDs only. Kept in SQL so erasure never loads the gym's notice history. */
export const noticeMemberId = sql<string>`split_part(${emailDeliveries.key}, ':', 3)`;
export const smsRecipientIncludes = (memberId: string) => sql<boolean>`${announcementSmsRecipients.memberIds} @> ${JSON.stringify([memberId])}::jsonb`;
export const thirdSmsKeyPart = sql<string>`split_part(${smsDeliveries.key}, ':', 3)`;

// Legacy campaign keys have a household ID and a k1 HMAC suffix, but no member attribution.
const legacyCampaignSmsSuffix = ':k1:[A-Za-z0-9_-]{43}$';
export const legacyCampaignSmsKey = sql<boolean>`${smsDeliveries.key} ~ ${legacyCampaignSmsSuffix}`;
export const erasedCampaignSmsKey = sql<string>`regexp_replace(${smsDeliveries.key}, ${legacyCampaignSmsSuffix}, ':erased:' || ${smsDeliveries.id}::text)`;
