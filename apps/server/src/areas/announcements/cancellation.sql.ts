// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed gym-scoped audit projection and billing address normalization, used inside forGym only.
import { sql } from 'drizzle-orm';
import { auditEvents, households } from '@plaingym/db';

/** Filter recovery decisions in PostgreSQL rather than loading the session's audit history. */
export const cancellationDecisionMemberId = sql<string>`${auditEvents.after}->>'memberId'`;

// ECMAScript trim whitespace, matching householdRecipients' trimmed billing address.
const trimCharacters = String.fromCharCode(9, 10, 11, 12, 13, 32, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279);
export const cancellationBillingAddressEquals = (address: string) =>
  sql<boolean>`lower(btrim(${households.email}, ${trimCharacters})) = ${address}`;
