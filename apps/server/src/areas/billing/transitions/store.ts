// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte } from 'drizzle-orm';
import { auditEvents, invoices, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { MutationContext } from '../../../core/interfaces/common.js';
import { notFound } from '../../../core/interfaces/common.js';
import type { BankFailureCode, InvoiceSnapshot, InvoiceTransitionResult } from '../../../core/interfaces/invoice-transitions.js';

export const effectCreated = 'billing.transition.effect.created';
export const effectPublished = 'billing.transition.effect.published';
export const effectCompleted = 'billing.transition.effect.completed';
export const paymentRecorded = 'billing.payment.recorded';
export const systemContext = (gymId: string): MutationContext => ({ gymId, actor: { kind: 'system' } });
export type InvoiceRow = typeof invoices.$inferSelect;
export interface TransitionEffect {
  kind: 'receipt' | 'activate_memberships' | 'reverse_credits' | 'dunning' | 'retry' | 'refund_duplicate' | 'staff_notice';
  invoiceId: string;
  paymentId?: string;
  attemptId?: string;
  refundId?: string;
  retryDay?: number;
  bankCode?: BankFailureCode;
  checkoutBankFailure?: true;
  /** A staff notice's subject; absent on older notices, which all report a duplicate payment. */
  notice?: 'refund_canceled' | 'refund_failed' | 'refund_released' | 'refund_missing' | 'refund_found' | 'refund_found_failed'
    | 'refund_arrived' | 'duplicate_released' | 'credits_not_granted';
}
/** A refund released as missing that Stripe later reported succeeded, and the failure Stripe reported after that. */
export const missingFound = 'billing.refund.missing_found', missingFoundFailed = 'billing.refund.missing_found_failed';
/** The app gave up on these attempts before the member's card was charged: neither a decline nor a collection. */
export const createAbandoned = 'create_abandoned', confirmAbandoned = 'confirm_abandoned';
export const testCleared = 'test_cleared';
export const abandonedAttempt = (row: { declineCode: string | null }) =>
  row.declineCode === createAbandoned || row.declineCode === confirmAbandoned || row.declineCode === testCleared;
/** A cancelled intent never pays, whether or not its cancellation was a decline. */
export const canceledAttempt = (row: { declineCode: string | null }) =>
  row.declineCode === 'intent_canceled' || row.declineCode === confirmAbandoned;
export const terminalInvoiceStatuses = ['paid', 'partially_refunded', 'refunded', 'void'];
export const terminal = (invoice: InvoiceRow) => terminalInvoiceStatuses.includes(invoice.status);
export function snapshot(row: InvoiceRow): InvoiceSnapshot {
  if (row.status === 'draft' || row.number === null) throw new Error('Invoice must be issued before payment');
  return { id: row.id, householdId: row.householdId, number: row.number, kind: row.kind as InvoiceSnapshot['kind'],
    status: row.status as InvoiceSnapshot['status'], amountCents: row.amountCents, currency: row.currency as InvoiceSnapshot['currency'],
    paidAt: row.paidAt?.toISOString() ?? null };
}
export function result(outcome: InvoiceTransitionResult['outcome'], row: InvoiceRow): InvoiceTransitionResult {
  return { outcome, invoice: snapshot(row) };
}
export async function lockInvoice(tx: Transaction, id: string): Promise<InvoiceRow> {
  const row = (await tx.select().from(invoices).where(eq(invoices.id, id)).for('update'))[0] ?? notFound();
  snapshot(row);
  return row;
}
export async function audit(tx: Transaction, context: MutationContext, clock: Clock, action: string,
  targetType: string, targetId: string, after: unknown, before?: unknown) {
  await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType, targetId, after, ...(before === undefined ? {} : { before }), occurredAt: clock.now(), createdAt: clock.now() });
}
export async function recorded(tx: Transaction, action: string, targetId: string) {
  return (await tx.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId))))[0];
}
export async function accepted(tx: Transaction, paymentId: string): Promise<boolean> {
  const event = await recorded(tx, paymentRecorded, paymentId);
  // Payments from an older release are normal payments unless explicitly identified as duplicates.
  return (event?.after as { accepted?: boolean } | undefined)?.accepted !== false;
}
export async function effect(tx: Transaction, context: MutationContext, clock: Clock, work: TransitionEffect) {
  // TODO: replace the append-only audit outbox with a dedicated effect table.
  await audit(tx, context, clock, effectCreated, 'invoice_effect', uuidv7(), work);
}
/** Durable reversal command, independent of the human-readable refund audit snapshot. */
export async function hasCreditReversal(tx: Transaction, invoiceId: string) {
  const [refunded] = await tx.select({ at: auditEvents.occurredAt }).from(auditEvents)
    .where(and(eq(auditEvents.action, 'billing.invoice.refunded'), eq(auditEvents.targetId, invoiceId)))
    .orderBy(asc(auditEvents.occurredAt)).limit(1);
  if (!refunded) return false;
  const work: TransitionEffect = { kind: 'reverse_credits', invoiceId };
  return (await tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(gte(auditEvents.occurredAt, refunded.at), eq(auditEvents.action, effectCreated), eq(auditEvents.after, work))).limit(1)).length > 0;
}
/** New duplicate reservations have their own durable marker. Older rows predate it: only the worker can have set
 * this reason without a staff-request audit on a payment explicitly recorded as a duplicate. */
export async function duplicateReservation(tx: Transaction, row: { id: string; paymentId: string; reason: string | null }) {
  return Boolean(await recorded(tx, 'billing.refund.duplicate_reserved', row.id))
    || row.reason === 'duplicate_payment' && !await recorded(tx, 'billing.refund.requested', row.id)
      && !await accepted(tx, row.paymentId);
}
