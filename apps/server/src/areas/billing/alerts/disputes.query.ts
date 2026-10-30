// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNotNull, notExists } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The scoped Drizzle anti-join needs one isolated JSON text extraction to match the recorded dispute ID.
import { sql } from 'drizzle-orm';
import { auditEvents, invoices, type Transaction } from '@plaingym/db';

/** Called inside forGym. The isolated SQL fragment only extracts the audit JSON's dispute identity. */
export function unalertedDisputes(tx: Transaction, gymId: string, cursor?: string) {
  // A notice that may have been delivered (uncertain) is never resent, so it counts as alerted too.
  const sent = tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), inArray(auditEvents.action, ['billing.alert.dispute.sent', 'billing.alert.dispute.uncertain']),
    eq(auditEvents.targetType, 'invoice'), eq(auditEvents.targetId, invoices.id),
    eq(sql<string>`${auditEvents.after}->>'disputeId'`, invoices.disputeId)));
  return tx.select({ id: invoices.id, disputeId: invoices.disputeId }).from(invoices).where(and(
    isNotNull(invoices.disputeId), cursor ? gt(invoices.id, cursor) : undefined, notExists(sent)))
    .orderBy(asc(invoices.id)).limit(100);
}
