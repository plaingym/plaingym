// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { auditEvents, invoices, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { MutationContext } from '../../../core/interfaces/common.js';
import { notFound } from '../../../core/interfaces/common.js';
import type { InvoiceSnapshot, InvoiceTransitionResult } from '../../../core/interfaces/invoice-transitions.js';

export const effectCreated = 'billing.transition.effect.created';
export const effectPublished = 'billing.transition.effect.published';
export const effectCompleted = 'billing.transition.effect.completed';
export const paymentRecorded = 'billing.payment.recorded';
export type InvoiceRow = typeof invoices.$inferSelect;
export interface TransitionEffect {
  kind: 'receipt' | 'activate_memberships' | 'dunning' | 'retry' | 'refund_duplicate' | 'staff_notice';
  invoiceId: string;
  paymentId?: string;
  attemptId?: string;
  refundId?: string;
  retryDay?: number;
}
export const terminal = (invoice: InvoiceRow) => ['paid', 'partially_refunded', 'refunded', 'void'].includes(invoice.status);
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
