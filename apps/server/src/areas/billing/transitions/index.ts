// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, or } from 'drizzle-orm';
import { forGym, invoices, paymentAttempts, payments, refunds, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema, moneySchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import { conflict, instant, notFound, requireMoney, type MutationContext } from '../../../core/interfaces/common.js';
import type { CardSuccess, CardFailure, ManualPayment, RefundTransition, InvoiceTransitions, InvoiceTransitionResult } from '../../../core/interfaces/invoice-transitions.js';
import { logError } from '../../../core/log.js';
import { accepted, audit, effect, lockInvoice, paymentRecorded, recorded, result, snapshot, terminal, type InvoiceRow } from './store.js';

export interface TransitionOptions {
  scope?: typeof forGym;
  clock?: Clock;
  /** Runs after every transition commits, outside its transaction: publishes the follow-up work it recorded. */
  afterCommit?: (gymId: string) => Promise<unknown>;
}
type PaymentRow = typeof payments.$inferSelect;
export function createInvoiceTransitions(options: TransitionOptions = {}): InvoiceTransitions {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
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
      if (linkedAttempt?.declineCode === 'intent_canceled') return result('ignored', invoice);
      const method = card ? 'card' : request.method;
      const previous = await tx.select().from(payments).where(or(eq(payments.id, request.paymentId),
        ...(card ? [eq(payments.paymentIntentId, request.paymentIntentId), eq(payments.chargeId, request.chargeId)] : [])));
      if (previous.length) {
        if (previous.length !== 1 || !samePayment(previous[0]!, request, method)) conflict('Payment ID reused with different parameters');
        if (linkedAttempt && linkedAttempt.status !== 'succeeded') await resolveAttempt(tx, context, linkedAttempt, 'succeeded', null);
        return result('ignored', invoice);
      }
      if (invoice.status === 'void') conflict('Void invoice cannot accept payment');
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
          amountCents: request.amountCents, currency: request.currency, reason: 'duplicate_payment', createdAt: clock.now() });
        await audit(tx, context, clock, 'billing.refund.recorded', 'refund', refundId,
          { paymentId: request.paymentId, status: 'pending', amountCents: request.amountCents, currency: request.currency });
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
    cardSucceeded: pay,
    manualPayment: pay,
    async cardFailed(context: MutationContext, request: CardFailure) {
      idSchema.parse(request.attemptId);
      if (!['failed', 'requires_action', 'canceled'].includes(request.outcome)) conflict('Invalid payment outcome');
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        const row = await attempt(tx, invoice, request.paymentIntentId, request.attemptId) ?? notFound();
        if (row.status === 'succeeded' || row.declineCode === 'intent_canceled'
          || (row.status === 'requires_action' && request.outcome === 'failed')) return result('ignored', invoice);
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
            await audit(tx, context, clock, 'billing.invoice.dunning_started', 'invoice', invoice.id, { attemptId: row.id });
            // Effects convert these local calendar days to instants using the gym timezone.
            for (const day of [3, 7]) await effect(tx, context, clock,
              { kind: 'retry', invoiceId: invoice.id, retryDay: day });
          }
        }
        return result('applied', next);
      });
    },
    async refund(context: MutationContext, request: RefundTransition) {
      idSchema.parse(request.refundId); moneySchema.parse({ amountCents: request.amountCents, currency: request.currency });
      if (request.amountCents <= 0 || !['pending', 'succeeded', 'failed'].includes(request.status)) conflict('Invalid refund');
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        const payment = (await tx.select().from(payments).where(eq(payments.id, request.paymentId)))[0] ?? notFound();
        if (payment.invoiceId !== invoice.id) notFound();
        if (request.currency !== payment.currency) conflict('Refund currency does not match');
        const previous = (await tx.select().from(refunds).where(eq(refunds.id, request.refundId)))[0];
        if (previous && (previous.paymentId !== request.paymentId || previous.amountCents !== request.amountCents
          || previous.currency !== request.currency || (previous.processorId !== null && previous.processorId !== request.processorId)))
          conflict('Refund ID reused with different parameters');
        if (previous && (previous.status === request.status && (previous.processorId !== null || request.processorId === undefined)
          || previous.status !== 'pending')) return result('ignored', invoice);
        if (request.processorId !== undefined) {
          const other = (await tx.select().from(refunds).where(eq(refunds.processorId, request.processorId)))[0];
          if (other && other.id !== request.refundId) conflict('Processor refund already recorded');
        }
        const existing = await tx.select().from(refunds).where(eq(refunds.paymentId, payment.id));
        const reserved = existing.filter(row => row.id !== request.refundId && row.status !== 'failed')
          .reduce((sum, row) => sum + row.amountCents, 0);
        if (request.status !== 'failed' && reserved + request.amountCents > payment.amountCents) conflict('Refund exceeds payment');
        const values = { status: request.status, processorId: request.processorId ?? null,
          resolvedAt: request.status === 'pending' ? null : clock.now() };
        if (previous) await tx.update(refunds).set(values).where(eq(refunds.id, request.refundId));
        else {
          const inserted = await tx.insert(refunds).values({ ...values, id: request.refundId, gymId: context.gymId,
            paymentId: request.paymentId, amountCents: request.amountCents, currency: request.currency, createdAt: clock.now() })
            .onConflictDoNothing().returning();
          if (!inserted.length) conflict('Refund identity already recorded');
        }
        await audit(tx, context, clock, 'billing.refund.recorded', 'refund', request.refundId,
          { paymentId: payment.id, amountCents: request.amountCents, currency: request.currency, ...values });
        if (request.status !== 'succeeded' || !await accepted(tx, payment.id)) return result('applied', invoice);
        const successful = await tx.select({ refund: refunds, payment: payments }).from(refunds)
          .innerJoin(payments, eq(payments.id, refunds.paymentId)).where(and(eq(payments.invoiceId, invoice.id), eq(refunds.status, 'succeeded')));
        let total = 0;
        for (const row of successful) if (await accepted(tx, row.payment.id)) total += row.refund.amountCents;
        const next = { ...invoice, status: total >= invoice.amountCents ? 'refunded' : 'partially_refunded' };
        if (next.status !== invoice.status) {
          await tx.update(invoices).set({ status: next.status }).where(eq(invoices.id, invoice.id));
          await audit(tx, context, clock, 'billing.invoice.refunded', 'invoice', invoice.id, snapshot(next), snapshot(invoice));
        }
        return result('applied', next);
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
    cardSucceeded: (context, request) => published(context, service.cardSucceeded(context, request)),
    manualPayment: (context, request) => published(context, service.manualPayment(context, request)),
    cardFailed: (context, request) => published(context, service.cardFailed(context, request)),
    refund: (context, request) => published(context, service.refund(context, request)),
  };
}
function samePayment(row: PaymentRow, request: CardSuccess | ManualPayment, method: string) {
  return row.invoiceId === request.invoiceId && row.amountCents === request.amountCents && row.currency === request.currency
    && row.method === method && ('paymentIntentId' in request
      ? row.paymentIntentId === request.paymentIntentId && row.chargeId === request.chargeId
      : row.reference === (request.reference ?? null));
}
