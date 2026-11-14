// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { auditEvents, households, invoices, paymentAttempts, paymentMethods, payments, signedLinks, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { revokeSignedLinkIn } from '../../links/service.js';
import { audit, snapshot, systemContext, type InvoiceRow } from './store.js';

/** A submitted join's first invoice and the undisclosed link the join made for it (`public.join.received`). */
export interface SubmittedJoin { readonly householdId: string; readonly invoiceId: string; readonly linkId: string }
/**
 * `ready`: nothing was paid or can still be paid, so the invoice may be voided. `wait`: a payment may still arrive or be
 * recorded (a Checkout not confirmed closed, a paid invoice whose join is completing), so a later run checks again.
 * `keep`: staff or the visitor did more than the join (another link or invoice, a used link, a payment, an attempt, a saved
 * card, a review hold staff released), so the join is left as it is.
 */
export type SubmittedJoinCheck = { readonly outcome: 'wait' | 'keep' } | { readonly outcome: 'ready'; readonly invoice: InvoiceRow };
const checkoutStarts = ['billing.checkout.started', 'billing.card_setup.started'];
type LinkState = { readonly id: string; readonly revokedAt: Date | null; readonly usedAt: Date | null };
/** Any link but a spare revoked before use (a concurrent submission's, or one whose delivery failed) is staff following
 * up. A spare can start nothing, and a session it started before its revocation is still confirmed with the provider. */
const followUp = (join: SubmittedJoin) => (link: LinkState) => link.id !== join.linkId && (!link.revokedAt || link.usedAt !== null);

/** Whether the household has a link other than the join's that counts as staff following up. Read before asking the
 * provider about any session, so the cleanup never expires the Checkout of a join it will keep. */
export async function joinFollowedUp(tx: Transaction, join: SubmittedJoin) {
  const links = await tx.select({ id: signedLinks.id, revokedAt: signedLinks.revokedAt, usedAt: signedLinks.usedAt }).from(signedLinks)
    .where(eq(signedLinks.householdId, join.householdId));
  return links.some(followUp(join));
}

/** Every Checkout session started through the household's links, and the one the invoice holds. Read before asking the
 * provider to confirm each one closed; {@link checkSubmittedJoin} then refuses any session it didn't confirm. */
export async function submittedJoinSessions(tx: Transaction, join: SubmittedJoin) {
  const rows = await tx.select({ after: auditEvents.after }).from(auditEvents).innerJoin(signedLinks, eq(signedLinks.id, auditEvents.targetId))
    .where(and(eq(auditEvents.targetType, 'signed_link'), eq(signedLinks.householdId, join.householdId), inArray(auditEvents.action, checkoutStarts)));
  const [invoice] = await tx.select({ sessionId: invoices.checkoutSessionId }).from(invoices)
    .where(and(eq(invoices.id, join.invoiceId), eq(invoices.householdId, join.householdId)));
  const ids = new Set(rows.flatMap(({ after }) => after !== null && typeof after === 'object' && 'sessionId' in after
    && typeof after.sessionId === 'string' ? [after.sessionId] : []));
  if (invoice?.sessionId) ids.add(invoice.sessionId);
  return [...ids].sort();
}

/**
 * Caller holds the household lock. Locks the household's links, then its invoices (Checkout's order), and decides whether
 * the join's invoice may be voided. `closed` holds the sessions the provider confirmed expired since they were read.
 * Writes nothing.
 */
export async function checkSubmittedJoin(tx: Transaction, join: SubmittedJoin, closed: ReadonlySet<string>, clock: Clock): Promise<SubmittedJoinCheck> {
  const now = clock.now(), wait = { outcome: 'wait' } as const, keep = { outcome: 'keep' } as const;
  const links = await tx.select().from(signedLinks).where(eq(signedLinks.householdId, join.householdId)).for('update');
  // The join's own link is the only one it keeps. Any other but a spare is staff following up; a used one finished its Checkout.
  const link = links.find(l => l.id === join.linkId);
  if (!link || links.some(followUp(join)) || link.usedAt) return keep;
  // While the link can start a Checkout, a session could open after the provider's answer.
  if (!link.revokedAt && link.expiresAt > now) return wait;
  const bills = await tx.select().from(invoices).where(eq(invoices.householdId, join.householdId)).for('update');
  const invoice = bills.length === 1 && bills[0]!.id === join.invoiceId ? bills[0]! : undefined;
  if (!invoice) return keep;
  // Paid: the join completes through the paid-invoice effect. Never void a paid invoice.
  if (invoice.paidAt || ['paid', 'partially_refunded', 'refunded'].includes(invoice.status)) return wait;
  if (invoice.status !== 'open') return keep;
  const audited = async (action: string) => (await tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.targetId, invoice.id), eq(auditEvents.action, action))).limit(1)).length > 0;
  // The runner's overdue hold doesn't protect it; a hold from anything else, or staff releasing one to collect, does.
  if (invoice.needsReview) {
    const [hold] = await tx.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.targetId, invoice.id),
      inArray(auditEvents.action, ['billing.runner.overdue_held', 'billing.invoice.held'])))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
    if (hold?.action !== 'billing.runner.overdue_held') return keep;
  } else if (await audited('billing.invoice.review_released')) return keep;
  // An unconfirmed reservation never disclosed a URL, but it must have ended.
  if (invoice.checkoutExpiresAt && invoice.checkoutExpiresAt > now) return wait;
  if ((await tx.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, invoice.id)).limit(1)).length
    || (await tx.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoice.id)).limit(1)).length
    || (await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.householdId, join.householdId)).limit(1)).length) return keep;
  // Expiry alone never proves a Checkout unpaid: only a session the provider confirmed expired counts as closed.
  if ((await submittedJoinSessions(tx, join)).some(id => !closed.has(id))) return wait;
  return { outcome: 'ready', invoice };
}

/** Voids the invoice {@link checkSubmittedJoin} found ready, in the same transaction, and revokes the join's link.
 * The invoice keeps its lines and number; a payment recorded later is refused as for any void invoice. */
export async function voidSubmittedJoin(tx: Transaction, gymId: string, join: SubmittedJoin, invoice: InvoiceRow, clock: Clock) {
  const context = systemContext(gymId);
  await tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoice.id));
  await audit(tx, context, clock, 'billing.invoice.voided', 'invoice', invoice.id, snapshot({ ...invoice, status: 'void' }), snapshot(invoice));
  await revokeSignedLinkIn(tx, context, join.linkId, clock.now());
}

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
