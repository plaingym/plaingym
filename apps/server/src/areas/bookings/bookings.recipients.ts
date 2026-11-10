// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray } from 'drizzle-orm';
import { classBookings, type Transaction } from '@plaingym/db';

/** Snapshot only. The caller holds the session lock shared by every booking mutation. */
export async function readCancellationRecipients(tx: Transaction, sessionId: string): Promise<string[]> {
  const rows = await tx.select({ memberId: classBookings.memberId }).from(classBookings)
    .where(and(eq(classBookings.sessionId, sessionId), inArray(classBookings.status, ['booked', 'waitlisted'])))
    .orderBy(asc(classBookings.memberId));
  return [...new Set(rows.map(row => row.memberId))];
}
