// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed gym-scoped audit projection, used inside forGym only.
import { sql } from 'drizzle-orm';
import { auditEvents } from '@plaingym/db';

/** Filter recovery decisions in PostgreSQL rather than loading the session's audit history. */
export const cancellationDecisionMemberId = sql<string>`${auditEvents.after}->>'memberId'`;
