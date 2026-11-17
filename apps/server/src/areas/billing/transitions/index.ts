// SPDX-License-Identifier: AGPL-3.0-only
import { desc, eq, or } from 'drizzle-orm';
import { forGym, invoices, paymentAttempts, payments, refunds, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import { conflict, instant, notFound, requireMoney, type MutationContext } from '../../../core/interfaces/common.js';
import type { CardSuccess, CardFailure, ManualPayment, RefundTransition, ProcessorRefundTransition, InvoiceTransitions, InvoiceTransitionResult } from '../../../core/interfaces/invoice-transitions.js';
import { logError } from '../../../core/log.js';
import { readBillingRules } from '../../settings/settings.js';
import { applyProcessorRefund, applyRefund } from './refunds.js';
import { createInvoiceVoid } from './void.js';
import { stripeWriteScope } from '../stripe-writes.js';
import { accepted, audit, canceledAttempt, confirmAbandoned, effect, lockInvoice, paymentRecorded, recorded, result, snapshot, terminal,
  type InvoiceRow } from './store.js';

export interface TransitionOptions {
  scope?: typeof forGym;
  clock?: Clock;
  /** Runs after every transition commits, outside its transaction: publishes the follow-up work it recorded. */
  afterCommit?: (gymId: string) => Promise<unknown>;
}
type PaymentRow = typeof payments.$inferSelect;
export function createInvoiceTransitions(options: TransitionOptions = {}): InvoiceTransitions {
  const scope = stripeWriteScope(options.scope ?? forGym), clock = options.clock ?? defaultClock;
  async function attempt(tx: Transaction, invoice: InvoiceRow, intentId: string, attemptId?: string) {
    const row = (await tx.select().from(paymentAttempts).where(attemptId === undefined
      ? eq(paymentAttempts.paymentIntentId, intentId) : eq(paymentAttempts.id, attemptId)))[0];
    if (attemptId !== undefined && !row) notFound();
    if (row && (row.invoiceId !== invoice.id || row.paymentIntentId !== intentId)) notFound();
    return row;
  }
  async function pay(context: MutationContext, request: CardSuccess | ManualPayment) {
    idSchema.parse(request.paymentId); idSchema.parse(request.invoiceId); instant(request.paidAt);
    return scope(context.gymId, async tx => {
      const invoice = await lockInvoice(tx, request.invoiceId);
      requireMoney(invoice, request);
      if (request.amountCents <= 0) conflict('Payment must be positive');
      const card = 'paymentIntentId' in request;
      if (card && (!request.paymentIntentId || !request.chargeId)) conflict('Processor payment IDs are required');
      const linkedAttempt = card ? await attempt(tx, invoice, request.paymentIntentId, request.attemptId) : undefined;
      if (linkedAttempt && canceledAttempt(linkedAttempt) && invoice.status !== 'void') return result('ignored', invoice);
      const method = card ? 'card' : request.method;
      const previous = await tx.select().from(payments).where(or(eq(payments.id, request.paymentId),
        ...(card ? [eq(payments.paymentIntentId, request.paymentIntentId), eq(payments.chargeId, request.chargeId)] : [])));
      if (previous.length) {
        if (previous.length !== 1 || !samePayment(previous[0]!, request, method)) conflict('Payment ID reused with different parameters');
        if (linkedAttempt && linkedAttempt.status !== 'succeeded') await resolveAttempt(tx, context, linkedAttempt, 'succeeded', null);
        return result('ignored', invoice);
      }
      if (invoice.status === 'void' && !card) conflict('Void invoice cannot accept payment');
      if (terminal(invoice) && !card) conflict('Invoice is already paid');
      const isAccepted = !terminal(invoice);
      // Unique keys also guard processor/local IDs racing on different invoices.
      const inserted = await tx.insert(payments).values({ id: request.paymentId, gymId: context.gymId,
        invoiceId: invoice.id, method, amountCents: request.amountCents, currency: request.currency,
        paymentIntentId: card ? request.paymentIntentId : null, chargeId: card ? request.chargeId : null,
        reference: card ? null : request.reference ?? null, paidAt: new Date(request.paidAt), createdAt: clock.now() })
        .onConflictDoNothing().returning();
      if (!inserted.length) conflict('Payment identity already recorded');
      await audit(tx, context, clock, paymentRecorded, 'payment', request.paymentId,
        { invoiceId: invoice.id, method, amountCents: request.amountCents, currency: request.currency, accepted: isAccepted });
      if (linkedAttempt) await resolveAttempt(tx, context, linkedAttempt, 'succeeded', null);
      if (!isAccepted) {
        const refundId = uuidv7();
        await tx.insert(refunds).values({ id: refundId, gymId: context.gymId, paymentId: request.paymentId,
          amountCents: request.amountCents, currency: request.currency, reason: 'duplicate_payment', createdAt: clock.now(),
          taggedAt: clock.now() });
        await audit(tx, context, clock, 'billing.refund.recorded', 'refund', refundId,
          { paymentId: request.paymentId, status: 'pending', amountCents: request.amountCents, currency: request.currency });
        await audit(tx, context, clock, 'billing.refund.duplicate_reserved', 'refund', refundId, { paymentId: request.paymentId });
        await effect(tx, context, clock, { kind: 'refund_duplicate', invoiceId: invoice.id, paymentId: request.paymentId, refundId });
        await effect(tx, context, clock, { kind: 'staff_notice', invoiceId: invoice.id, paymentId: request.paymentId, refundId });
        return result('duplicate_payment', invoice);
      }
      const paid = { ...invoice, status: 'paid', paidAt: new Date(request.paidAt) };
      await tx.update(invoices).set({ status: paid.status, paidAt: paid.paidAt }).where(eq(invoices.id, invoice.id));
      await audit(tx, context, clock, 'billing.invoice.paid', 'invoice', invoice.id, snapshot(paid), snapshot(invoice));
      await effect(tx, context, clock, { kind: 'activate_memberships', invoiceId: invoice.id, paymentId: request.paymentId });
      await effect(tx, context, clock, { kind: 'receipt', invoiceId: invoice.id, paymentId: request.paymentId });
      return result('applied', paid);
    });
  }
  async function resolveAttempt(tx: Transaction, context: MutationContext, row: typeof paymentAttempts.$inferSelect,
    status: string, declineCode: string | null) {
    if (row.status === status && row.declineCode === declineCode) return;
    await tx.update(paymentAttempts).set({ status, declineCode, error: null, resolvedAt: clock.now() }).where(eq(paymentAttempts.id, row.id));
    await audit(tx, context, clock, 'billing.attempt.resolved', 'payment_attempt', row.id,
      { status, declineCode }, { status: row.status, declineCode: row.declineCode });
  }
  const service: InvoiceTransitions = {
    voidInvoice: createInvoiceVoid(scope, clock),
    cardSucceeded: pay,
    manualPayment: pay,
    async settleZero(context, request) {
      idSchema.parse(request.invoiceId);
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        if (invoice.amountCents !== 0) conflict('Invoice is not zero value');
        if (invoice.status === 'void') conflict('Void invoice cannot be settled');
        if (terminal(invoice)) return result('ignored', invoice);
        if (!['open', 'past_due'].includes(invoice.status)) conflict('Invoice is not payable');
        const existing = await tx.select().from(payments).where(eq(payments.invoiceId, invoice.id));
        for (const payment of existing) if (await accepted(tx, payment.id)) conflict('Invoice already has an accepted payment');
        const paid = { ...invoice, status: 'paid', paidAt: clock.now() };
        await tx.update(invoices).set({ status: paid.status, paidAt: paid.paidAt }).where(eq(invoices.id, invoice.id));
        await audit(tx, context, clock, 'billing.invoice.settled_zero', 'invoice', invoice.id, snapshot(paid), snapshot(invoice));
        await effect(tx, context, clock, { kind: 'activate_memberships', invoiceId: invoice.id });
        return result('applied', paid);
      });
    },
    async cardFailed(context: MutationContext, request: CardFailure) {
      idSchema.parse(request.attemptId);
      if (!['failed', 'requires_action', 'canceled'].includes(request.outcome)) conflict('Invalid payment outcome');
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        const row = await attempt(tx, invoice, request.paymentIntentId, request.attemptId) ?? notFound();
        // A terminal invoice never moves, and an attempt already resolved on it stays as recorded. One still unresolved
        // (a charge that crossed a manual payment, say) is closed below, so reconciliation stops listing it.
        if (terminal(invoice) && !['pending', 'requires_action'].includes(row.status)) return result('ignored', invoice);
        if (row.status === 'succeeded' || canceledAttempt(row)
          || (row.status === 'requires_action' && request.outcome === 'failed')) return result('ignored', invoice);
        // An intent cancelled before it was confirmed never reached the member's card: close the attempt without
        // touching the invoice, dunning or retries, so the next collection charges it. A cancelled action-needed
        // attempt stays a decline below.
        if (request.outcome === 'canceled' && row.status === 'pending') {
          await resolveAttempt(tx, context, row, 'failed', confirmAbandoned);
          return result('applied', invoice);
        }
        const status = request.outcome === 'canceled' ? 'failed' : request.outcome;
        const declineCode = request.outcome === 'canceled' ? 'intent_canceled'
          : request.outcome === 'requires_action' ? 'authentication_required' : null;
        if (row.status === status && row.declineCode === declineCode) return result('ignored', invoice);
        const alreadyResolved = row.status === status;
        await resolveAttempt(tx, context, row, status, declineCode);
        const latest = (await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoice.id))
          .orderBy(desc(paymentAttempts.attemptNumber)).limit(1))[0]!;
        if (terminal(invoice) || row.attemptNumber < latest.attemptNumber || alreadyResolved) return result('ignored', invoice);
        const next = { ...invoice, status: invoice.kind === 'cycle' ? 'past_due' : 'open' };
        if (next.status !== invoice.status) {
          await tx.update(invoices).set({ status: next.status }).where(eq(invoices.id, invoice.id));
          await audit(tx, context, clock, 'billing.invoice.payment_failed', 'invoice', invoice.id, snapshot(next), snapshot(invoice));
        }
        if (invoice.kind === 'cycle') {
          await effect(tx, context, clock, { kind: 'dunning', invoiceId: invoice.id, attemptId: row.id });
          // One retry schedule per invoice, anchored to its first failure rather than reset on every attempt.
          if (!await recorded(tx, 'billing.invoice.dunning_started', invoice.id)) {
            const { retryDays } = await readBillingRules(tx, context.gymId);
            await audit(tx, context, clock, 'billing.invoice.dunning_started', 'invoice', invoice.id, { attemptId: row.id, retryDays });
            // Effects convert these local calendar days to instants using the gym timezone.
            for (const day of retryDays) await effect(tx, context, clock,
              { kind: 'retry', invoiceId: invoice.id, retryDay: day });
          }
        }
        return result('applied', next);
      });
    },
    async refund(context: MutationContext, request: RefundTransition) {
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        return applyRefund(tx, context, clock, invoice, request);
      });
    },
    async processorRefund(context: MutationContext, request: ProcessorRefundTransition) {
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        return applyProcessorRefund(tx, context, clock, invoice, request);
      });
    },
  };
  // The transition has committed; a failed publish is recovered by the hourly sweep, never by failing the caller.
  async function published(context: MutationContext, work: Promise<InvoiceTransitionResult>) {
    const value = await work;
    try { await options.afterCommit?.(context.gymId); }
    catch (error) { logError('billing.transitions.publish_failed', { gymId: context.gymId }, error); }
    return value;
  }
  return {
    voidInvoice: (context, request) => published(context, service.voidInvoice(context, request)),
    settleZero: (context, request) => published(context, service.settleZero(context, request)),
    cardSucceeded: (context, request) => published(context, service.cardSucceeded(context, request)),
    manualPayment: (context, request) => published(context, service.manualPayment(context, request)),
    cardFailed: (context, request) => published(context, service.cardFailed(context, request)),
    refund: (context, request) => published(context, service.refund(context, request)),
    processorRefund: (context, request) => published(context, service.processorRefund(context, request)),
  };
}
function samePayment(row: PaymentRow, request: CardSuccess | ManualPayment, method: string) {
  return row.invoiceId === request.invoiceId && row.amountCents === request.amountCents && row.currency === request.currency
    && row.method === method && ('paymentIntentId' in request
      ? row.paymentIntentId === request.paymentIntentId && row.chargeId === request.chargeId
      : row.reference === (request.reference ?? null));
}
