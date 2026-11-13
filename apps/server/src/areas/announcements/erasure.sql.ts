// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed expression only concatenates recipient IDs from imported gym-owned columns; no raw table access.
import { sql } from 'drizzle-orm';
import { announcementRecipients } from '@plaingym/db';

/** Same ID-only key as announcementDeliveryKey, evaluated in the erasure's UPDATE subquery. */
export const recipientDeliveryKey = sql<string>`'announcement:' || ${announcementRecipients.announcementId}::text || ':' || ${announcementRecipients.id}::text`;
