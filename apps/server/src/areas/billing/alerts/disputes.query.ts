// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, ne, not, notExists, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The scoped Drizzle anti-join needs one isolated JSON text extraction to match the recorded dispute ID, and one derived row to read the latest dispute audit once.
import { sql } from 'drizzle-orm';
import { auditEvents, invoices, payments, type Transaction } from '@plaingym/db';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';

/**
 * Called inside forGym, in a query on `invoices`: the invoice's dispute is a Stripe test-mode one, which the live account
 * never has. Either a switch from test to live closed it (its `billing.invoice.disputed` audit has `reason:
 * 'stripe_test_cleared'`), or its latest dispute audit names a payment a switch marked as test. For older audits without
 * a payment ID, every payment on the invoice must be marked. Alerts and restore share this condition.
 */
export function testModeDispute(tx: Transaction, gymId: string) {
  const closed = tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'billing.invoice.disputed'), eq(auditEvents.targetType, 'invoice'),
    eq(auditEvents.targetId, invoices.id), eq(sql<string>`${auditEvents.after}->>'disputeId'`, invoices.disputeId),
    eq(sql<string>`${auditEvents.after}->>'reason'`, 'stripe_test_cleared')));
  const marked = tx.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.invoiceId, invoices.id), eq(payments.reference, stripeTestPaymentReference)));
  const recorded = tx.select({ paymentId: sql<string>`${auditEvents.after}->>'paymentId'` }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'billing.invoice.disputed'), eq(auditEvents.targetType, 'invoice'),
    eq(auditEvents.targetId, invoices.id), eq(sql<string>`${auditEvents.after}->>'disputeId'`, invoices.disputeId)))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  // The latest audit's payment ID is read once per invoice, as the one row of `latest` (null when it has none, or when
  // the invoice has no dispute audit). `offset 0` keeps PostgreSQL from pulling the row up into the condition, which
  // would copy the subquery into each use.
  const latest = sql<string | null>`latest.payment_id`;
  const recordedTest = tx.select({ id: payments.id }).from(payments).where(and(eq(payments.invoiceId, invoices.id),
    eq(sql<string>`${payments.id}::text`, latest), eq(payments.reference, stripeTestPaymentReference)));
  const other = tx.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.invoiceId, invoices.id), or(isNull(payments.reference), ne(payments.reference, stripeTestPaymentReference))));
  const fromLatest = sql`(select 1 from (select ${recorded} as payment_id offset 0) latest
    where ${or(exists(recordedTest), and(isNull(latest), exists(marked), notExists(other)))})`;
  return or(exists(closed), exists(fromLatest))!;
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
