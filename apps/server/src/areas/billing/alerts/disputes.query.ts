// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, ne, not, notExists, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The scoped Drizzle anti-join needs one isolated JSON text extraction to match the recorded dispute ID.
import { sql } from 'drizzle-orm';
import { auditEvents, invoices, payments, type Transaction } from '@plaingym/db';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';

/**
 * Called inside forGym, in a query on `invoices`: the invoice's dispute is a Stripe test-mode one, which the live account
 * never has. Either a switch from test to live closed it (its `billing.invoice.disputed` audit has `reason:
 * 'stripe_test_cleared'`), or every payment on the invoice is a card payment a switch marked as test (a dispute that was
 * already final when the switch ran). The isolated SQL fragments only extract the audit JSON's dispute ID and reason.
 */
export function testModeDispute(tx: Transaction, gymId: string) {
  const closed = tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'billing.invoice.disputed'), eq(auditEvents.targetType, 'invoice'),
    eq(auditEvents.targetId, invoices.id), eq(sql<string>`${auditEvents.after}->>'disputeId'`, invoices.disputeId),
    eq(sql<string>`${auditEvents.after}->>'reason'`, 'stripe_test_cleared')));
  const marked = tx.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.invoiceId, invoices.id), eq(payments.reference, stripeTestPaymentReference)));
  const other = tx.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.invoiceId, invoices.id), or(isNull(payments.reference), ne(payments.reference, stripeTestPaymentReference))));
  return or(exists(closed), and(exists(marked), notExists(other)))!;
}

/** Called inside forGym. The isolated SQL fragment only extracts the audit JSON's dispute identity. */
export function unalertedDisputes(tx: Transaction, gymId: string, cursor?: string) {
  // A notice that may have been delivered (uncertain) is never resent, so it counts as alerted too.
  const sent = tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), inArray(auditEvents.action, ['billing.alert.dispute.sent', 'billing.alert.dispute.uncertain']),
    eq(auditEvents.targetType, 'invoice'), eq(auditEvents.targetId, invoices.id),
    eq(sql<string>`${auditEvents.after}->>'disputeId'`, invoices.disputeId)));
  // A test-mode dispute is never alerted: the owner can't act on it with the live account.
  return tx.select({ id: invoices.id, disputeId: invoices.disputeId }).from(invoices).where(and(
    isNotNull(invoices.disputeId), cursor ? gt(invoices.id, cursor) : undefined, notExists(sent), not(testModeDispute(tx, gymId))))
    .orderBy(asc(invoices.id)).limit(100);
}
