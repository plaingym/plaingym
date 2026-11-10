// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { auditEvents, households, invoices, paymentAttempts, payments, signedLinks, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { audit, snapshot } from './store.js';

/** Join cleanup holds the household lock for this whole transaction. Keep accounting rows;
 * an unresolved Checkout reservation is unsafe even when its local expiry has passed. */
export async function voidAbandonedJoinInvoice(tx: Transaction, gymId: string, householdId: string, invoiceId: string, clock: Clock) {
  const [home] = await tx.select({ id: households.id }).from(households).where(and(eq(households.id, householdId), eq(households.gymId, gymId))).for('update');
  if (!home || !(await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId),
    eq(auditEvents.action, 'public.join.admitted'))).limit(1)).length) return false;
  const actions = ['public.join.submitting', 'public.join.received', 'public.join.completed'];
  if ((await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId),
    inArray(auditEvents.action, actions))).limit(1)).length) return false;
  const [issued] = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
    eq(auditEvents.targetId, householdId), eq(auditEvents.action, 'public.join.invoiced'))).limit(1);
  if (!issued?.after || typeof issued.after !== 'object' || !('invoiceId' in issued.after) || issued.after.invoiceId !== invoiceId) return false;
  // Checkout takes the link lock before the invoice lock. Preserve card-setup links even if creation has not returned.
  const links = await tx.select().from(signedLinks).where(eq(signedLinks.householdId, householdId)).for('update');
  if (links.some(link => link.purpose !== 'pay_invoice' || link.invoiceId !== invoiceId || link.usedAt)) return false;
  const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.householdId, householdId))).for('update');
  if (!invoice || !['open', 'void'].includes(invoice.status) || invoice.paidAt || invoice.needsReview || invoice.checkoutSessionId || invoice.checkoutExpiresAt) return false;
  if ((await tx.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, invoiceId)).limit(1)).length) return false;
  if ((await tx.select({ id: paymentAttempts.id }).from(paymentAttempts).where(and(eq(paymentAttempts.invoiceId, invoiceId),
    or(isNull(paymentAttempts.resolvedAt), inArray(paymentAttempts.status, ['pending', 'requires_action', 'succeeded'])))).limit(1)).length) return false;
  const starts = await tx.select({ id: auditEvents.id }).from(auditEvents).innerJoin(signedLinks, eq(signedLinks.id, auditEvents.targetId))
    .where(and(eq(signedLinks.householdId, householdId), inArray(auditEvents.action,
      ['billing.checkout.reserved', 'billing.checkout.reservation_renewed', 'billing.checkout.started', 'billing.card_setup.started']))).limit(1);
  if (starts.length) return false;
  if (invoice.status === 'void') return true;
  await tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoiceId));
  await audit(tx, { gymId, actor: { kind: 'system' } }, clock, 'billing.invoice.voided', 'invoice', invoiceId,
    snapshot({ ...invoice, status: 'void' }), snapshot(invoice));
  return true;
}
