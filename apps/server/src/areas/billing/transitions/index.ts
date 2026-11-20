// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { forGym, invoices, paymentAttempts, payments, refunds, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import { conflict, instant, notFound, requireMoney, type MutationContext } from '../../../core/interfaces/common.js';
import type { BankFailureCode, CardSuccess, CardFailure, ManualPayment, RefundTransition, ProcessorRefundTransition, InvoiceTransitions, InvoiceTransitionResult } from '../../../core/interfaces/invoice-transitions.js';
import type { PaymentsResolver } from '../webhooks/inbox.js';
import { isAssignmentInvoice } from '../assignment-invoices.js';
import { bankAttemptsExhausted, invoiceProcessing, processingIntents, retriesStopped, revokeBankMethod } from './bank.js';
import { logError } from '../../../core/log.js';
import { readBillingRules } from '../../settings/settings.js';
import { applyProcessorRefund, applyRefund } from './refunds.js';
import { createInvoiceVoid } from './void.js';
import { stripeWriteScope } from '../stripe-writes.js';
import { accepted, audit, canceledAttempt, confirmAbandoned, effect, lockInvoice, paymentRecorded, recorded, result, snapshot, terminal,
  type InvoiceRow } from './store.js';

export interface TransitionOptions {
  paymentsFor?: PaymentsResolver;
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
      const method = request.method;
      if (!card && invoice.status === 'processing') conflict('Payment is processing');
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
    async paymentProcessing(context, request) {
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        const row = await attempt(tx, invoice, request.paymentIntentId, request.attemptId);
        const isTerminal = terminal(invoice);
        const history = isTerminal ? [] : await processingIntents(tx, invoice.id);
        if (history.includes(request.paymentIntentId)) return result('ignored', invoice);
        if (invoice.status === 'processing') {
          if (row?.status === 'processing') return result('ignored', invoice);
          conflict('Another payment is processing');
        }
        if (row) {
          const changed = await tx.update(paymentAttempts).set({ status: 'processing', processingAt: clock.now() })
            .where(and(eq(paymentAttempts.id, row.id), eq(paymentAttempts.status, 'pending'), isNull(paymentAttempts.resolvedAt))).returning();
          if (!changed.length) return result('ignored', invoice);
          if (isTerminal) await audit(tx, context, clock, 'billing.attempt.processing', 'payment_attempt', row.id,
            { status: 'processing', paymentIntentId: request.paymentIntentId }, { status: row.status });
        }
        if (isTerminal) return result('ignored', invoice);
        const next = { ...invoice, status: 'processing' };
        await tx.update(invoices).set({ status: next.status }).where(eq(invoices.id, invoice.id));
        await audit(tx, context, clock, invoiceProcessing, 'invoice', invoice.id,
          { ...snapshot(next), paymentIntentId: request.paymentIntentId, sequence: history.length + 1 }, snapshot(invoice));
        return result('applied', next);
      });
    },
    async processingFailed(context, request) {
      // A Checkout attempt has no saved-method snapshot. Resolve its exact method before opening the write transaction.
      let processorId: string | undefined;
      if (request.code === 'payment_method_unusable') {
        const ignored = await scope(context.gymId, async tx => {
          const invoice = await lockInvoice(tx, request.invoiceId);
          return invoice.status === 'processing' && (await processingIntents(tx, invoice.id)).at(-1) === request.paymentIntentId
            ? undefined : result('ignored', invoice);
        });
        if (ignored) return ignored;
        const provider = await options.paymentsFor?.(context.gymId);
        const current = await provider?.findCharge({ kind: 'charge', id: request.paymentIntentId });
        if (current?.status !== 'failed' || current.code !== request.code || current.id !== request.paymentIntentId
          || current.metadata.gymId !== context.gymId || current.metadata.invoiceId !== request.invoiceId || !current.paymentMethodId)
          conflict('Failed bank payment method is unresolved');
        processorId = current.paymentMethodId;
      }
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        if (invoice.status !== 'processing' || (await processingIntents(tx, invoice.id)).at(-1) !== request.paymentIntentId)
          return result('ignored', invoice);
        if (await attempt(tx, invoice, request.paymentIntentId)) conflict('Runner failure requires its attempt');
        return failedInvoice(tx, context, invoice, undefined, request.code, processorId);
      });
    },
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
      if (!['failed', 'requires_action', 'canceled', 'insufficient_funds', 'payment_method_unusable'].includes(request.outcome)) conflict('Invalid payment outcome');
      return scope(context.gymId, async tx => {
        const invoice = await lockInvoice(tx, request.invoiceId);
        const row = await attempt(tx, invoice, request.paymentIntentId, request.attemptId) ?? notFound();
        // A terminal invoice never moves, and an attempt already resolved on it stays as recorded. One still unresolved
        // (a charge that crossed a manual payment, say) is closed below, so reconciliation stops listing it.
        if (terminal(invoice) && !['pending', 'processing', 'requires_action'].includes(row.status)) return result('ignored', invoice);
        if (row.status === 'succeeded' || canceledAttempt(row)
          || (row.status === 'requires_action' && request.outcome === 'failed')) return result('ignored', invoice);
        // An intent cancelled before it was confirmed never reached the member's card: close the attempt without
        // touching the invoice, dunning or retries, so the next collection charges it. A cancelled action-needed
        // attempt stays a decline below.
        if (request.outcome === 'canceled' && row.status === 'pending') {
          await resolveAttempt(tx, context, row, 'failed', confirmAbandoned);
          return result('applied', invoice);
        }
        const bankCode = request.outcome === 'insufficient_funds' || request.outcome === 'payment_method_unusable' ? request.outcome : undefined;
        const status = request.outcome === 'requires_action' ? 'requires_action' : 'failed';
        const declineCode = request.outcome === 'canceled' ? 'intent_canceled'
          : request.outcome === 'requires_action' ? 'authentication_required' : bankCode ?? null;
        if (row.status === status && row.declineCode === declineCode) return result('ignored', invoice);
        const alreadyResolved = row.status === status;
        await resolveAttempt(tx, context, row, status, declineCode);
        const latest = (await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoice.id))
          .orderBy(desc(paymentAttempts.attemptNumber)).limit(1))[0]!;
        if (terminal(invoice) || row.attemptNumber < latest.attemptNumber || alreadyResolved) return result('ignored', invoice);
        if (invoice.status === 'processing' && row.status !== 'processing' && (await processingIntents(tx, invoice.id)).at(-1) !== request.paymentIntentId)
          return result('ignored', invoice);
        return failedInvoice(tx, context, invoice, row.id, bankCode, row.savedPaymentMethod);
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
  async function failedInvoice(tx: Transaction, context: MutationContext, invoice: InvoiceRow, attemptId?: string,
    bankCode?: BankFailureCode, processorId?: string) {
    // An assignment invoice a bank failure made past due stays past due on a later card failure, so its retries continue.
    const recurring = invoice.kind === 'cycle' || (!!bankCode || invoice.status === 'past_due') && await isAssignmentInvoice(tx, invoice.id);
    const next = { ...invoice, status: recurring ? 'past_due' : 'open' };
    if (next.status !== invoice.status) {
      await tx.update(invoices).set({ status: next.status, ...(!attemptId ? { checkoutSessionId: null, checkoutExpiresAt: null } : {}) }).where(eq(invoices.id, invoice.id));
      await audit(tx, context, clock, 'billing.invoice.payment_failed', 'invoice', invoice.id, snapshot(next), snapshot(invoice));
    }
    if (bankCode === 'payment_method_unusable' && processorId) await revokeBankMethod(tx, context, clock, invoice, processorId);
    const stop = bankCode === 'payment_method_unusable' || bankCode === 'insufficient_funds' && await bankAttemptsExhausted(tx, invoice);
    if (stop && !await recorded(tx, retriesStopped, invoice.id)) await audit(tx, context, clock, retriesStopped, 'invoice', invoice.id, { bankCode });
    const source = { ...(attemptId ? { attemptId } : {}), ...(bankCode ? { bankCode } : {}) };
    if (recurring || bankCode === 'payment_method_unusable')
      await effect(tx, context, clock, { kind: 'dunning', invoiceId: invoice.id, ...source });
    if (recurring && !stop && !await recorded(tx, 'billing.invoice.dunning_started', invoice.id) && !await recorded(tx, retriesStopped, invoice.id)) {
      const { retryDays } = await readBillingRules(tx, context.gymId);
      await audit(tx, context, clock, 'billing.invoice.dunning_started', 'invoice', invoice.id, { ...source, retryDays });
      for (const day of retryDays) await effect(tx, context, clock, { kind: 'retry', invoiceId: invoice.id, retryDay: day });
    }
    return result('applied', next);
  }
  // The transition has committed; a failed publish is recovered by the hourly sweep.
  async function published(context: MutationContext, work: Promise<InvoiceTransitionResult>) {
    const value = await work;
    try { await options.afterCommit?.(context.gymId); }
    catch (error) { logError('billing.transitions.publish_failed', { gymId: context.gymId }, error); }
    return value;
  }
  return {
    voidInvoice: (context, request) => published(context, service.voidInvoice(context, request)),
    paymentProcessing: (context, request) => published(context, service.paymentProcessing(context, request)),
    processingFailed: (context, request) => published(context, service.processingFailed(context, request)),
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
