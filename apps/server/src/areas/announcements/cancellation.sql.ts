// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed JSON member ID projection from an imported gym-owned audit column, used inside forGym only.
import { sql } from 'drizzle-orm';
import { auditEvents } from '@plaingym/db';

/** Filter recovery decisions in PostgreSQL rather than loading the session's audit history. */
export const cancellationDecisionMemberId = sql<string>`${auditEvents.after}->>'memberId'`;
