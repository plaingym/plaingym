// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { auditEvents, forGym, uuidv7, type payments, type refunds, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';
import { notFound, type MutationContext } from '../../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import { logError } from '../../../core/log.js';
import type { Payments, Refund } from '../../../infra/payments/index.js';
import { paymentConflict } from '../payments.errors.js';
import { audit, lockInvoice } from './store.js';

type PaymentRow = typeof payments.$inferSelect;
type RefundRow = typeof refunds.$inferSelect;

/** Stripe keeps an idempotency key for 24 hours. A staff retry reuses its reservation's key only inside this window. */
export const refundRetryWindowMs = 23 * 3600_000;
export const pastRefundWindow = (row: { createdAt: Date }, clock: Clock) => clock.now().getTime() - row.createdAt.getTime() >= refundRetryWindowMs;

/** A staff request records `sending` in the locked transaction that checks its window, before it calls Stripe, and `sent`
 * once the call has returned or failed. Both name the request's own `sendId`. */
export const refundSending = 'billing.refund.sending', refundSent = 'billing.refund.sent';
/** Only a crash leaves a send unfinished. Its reservation is held this long, many times the provider's 20-second timeout,
 * so a crashed sender can't hold it forever. A live request always finishes first. */
export const refundSendLeaseMs = 3600_000;

/** Records that a staff request is about to send this reservation. The caller holds the invoice lock and has checked the
 * window with the current time. */
export async function markRefundSending(tx: Transaction, context: MutationContext, clock: Clock, refundId: string) {
  const sendId = uuidv7();
  await audit(tx, context, clock, refundSending, 'refund', refundId, { sendId });
  return sendId;
}
/** Records that the send has finished. A failed write is logged: the lease then frees the reservation. */
export async function markRefundSent(scope: typeof forGym, context: MutationContext, clock: Clock, refundId: string, sendId: string) {
  try {
    await scope(context.gymId, tx => audit(tx, context, clock, refundSent, 'refund', refundId, { sendId }));
  } catch (error) { logError('billing.refund.sent_mark_failed', { gymId: context.gymId, refundId }, error); }
}

/** Whether a processor refund is this gym's refund of this payment, for this amount and currency. */
export function sameRefund(refund: Refund, expected: { amountCents: number; currency: string }, payment: PaymentRow, gymId: string) {
  return refund.amount === expected.amountCents && refund.currency.toUpperCase() === expected.currency
    && refund.metadata.gymId === gymId && [payment.paymentIntentId, payment.chargeId].includes(refund.chargeId);
}

export interface LapsedRefundOptions {
  scope: typeof forGym;
  clock: Clock;
  transitions: Pick<InvoiceTransitions, 'refund'>;
}
/** The reservations a staff request may still be sending. Read under the invoice lock, past the window: a request that
 * hasn't recorded its send by then never will, since it checks the window under the same lock. */
async function sending(options: LapsedRefundOptions, gymId: string, invoiceId: string, ids: readonly string[]) {
  return options.scope(gymId, async tx => {
    await lockInvoice(tx, invoiceId);
    const events = await tx.select({ action: auditEvents.action, targetId: auditEvents.targetId, after: auditEvents.after,
      occurredAt: auditEvents.occurredAt }).from(auditEvents)
      .where(and(eq(auditEvents.targetType, 'refund'), inArray(auditEvents.action, [refundSending, refundSent]), inArray(auditEvents.targetId, [...ids])));
    const sendId = (event: typeof events[number]) => (event.after as { sendId?: string } | null)?.sendId;
    const finished = new Set(events.filter(event => event.action === refundSent).map(sendId));
    const leased = options.clock.now().getTime() - refundSendLeaseMs;
    return new Set(events.filter(event => event.action === refundSending && !finished.has(sendId(event))
      && event.occurredAt.getTime() > leased).map(event => event.targetId));
  });
}

/**
 * Past the retry window no new request may use a reservation's expired key, so each lapsed tagged reservation of this
 * payment takes the refund that names it, or is released. Stripe is listed once, after every send a staff request
 * started has finished: a refund Stripe is still making wouldn't be listed yet. A payment a switch to live marked as test
 * is released without calling Stripe: the live key can't read it, and the staff path never sends on it. Every row is
 * tried; the first failure is thrown after the rest. Returns the rows left pending because a send hasn't finished.
 */
export async function settleLapsed(options: LapsedRefundOptions, context: MutationContext, provider: () => Promise<Payments>,
  payment: PaymentRow, rows: readonly RefundRow[]): Promise<RefundRow[]> {
  const eligible = rows.filter(row => row.gymId === context.gymId && row.paymentId === payment.id && row.status === 'pending'
    && row.taggedAt !== null && row.processorId === null && pastRefundWindow(row, options.clock));
  if (!eligible.length) return [];
  if (payment.gymId !== context.gymId || !payment.paymentIntentId) notFound();
  const release = (row: RefundRow, own?: Refund) => options.transitions.refund(context, { invoiceId: payment.invoiceId, paymentId: payment.id,
    refundId: row.id, amountCents: row.amountCents, currency: row.currency, ...(own ? { processorId: own.id, status: own.status } : { status: 'failed' as const }) });
  if (payment.method === 'card' && payment.reference === stripeTestPaymentReference) {
    await settleEach(eligible, row => release(row));
    return [];
  }
  const busy = await sending(options, context.gymId, payment.invoiceId, eligible.map(row => row.id));
  const ready = eligible.filter(row => !busy.has(row.id));
  if (ready.length) {
    const found = await (await provider()).listRefunds(payment.paymentIntentId);
    await settleEach(ready, async row => {
      const named = found.filter(refund => refund.reservationId === row.id);
      if (new Set(named.map(refund => refund.id)).size > 1)
        paymentConflict('refund_reconciliation', 'Ambiguous refund reservation; staff resolution required');
      await release(row, named.find(refund => sameRefund(refund, row, payment, context.gymId)));
    });
  }
  return eligible.filter(row => busy.has(row.id));
}
/** Settles every row, so one that fails doesn't hold back the others, then throws the first failure. */
async function settleEach(rows: readonly RefundRow[], settle: (row: RefundRow) => Promise<unknown>) {
  let failure: { error: unknown } | undefined;
  for (const row of rows) {
    try { await settle(row); } catch (error) { failure ??= { error }; }
  }
  if (failure) throw failure.error;
}
