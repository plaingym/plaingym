// SPDX-License-Identifier: AGPL-3.0-only
import type { Id, IsoInstant, Money } from '@plaingym/shared/contracts';
import { AppError } from '@plaingym/shared';
import { idSchema, moneySchema, refundReleased, voidInvoiceRequestSchema, type VoidInvoiceRequest } from '@plaingym/shared/contracts';
import { conflict, instant, notFound, requireMoney, scopedKey } from './common.js';
import { clock as defaultClock, type Clock } from '../clock.js';
import type { MutationContext } from './common.js';
import type { Refund } from '../../infra/payments/index.js';

/** Stripe keeps an idempotency key for 24 hours. A staff retry reuses its reservation's key only inside this window. */
export const refundRetryWindowMs = 23 * 3600_000;

export interface InvoiceSnapshot extends Money {
  readonly id: Id;
  readonly householdId: Id;
  readonly number: number;
  readonly kind: 'cycle' | 'one_off';
  readonly status: 'open' | 'processing' | 'past_due' | 'paid' | 'void' | 'partially_refunded' | 'refunded';
  readonly paidAt: IsoInstant | null;
}
export interface CardSuccess extends Money {
  readonly method: 'card' | 'bank_debit';
  readonly invoiceId: Id;
  readonly paymentId: Id;
  readonly paymentIntentId: string;
  readonly chargeId: string;
  readonly paidAt: IsoInstant;
  /** Absent for a Checkout payment that has no charge-runner attempt. */
  readonly attemptId?: Id;
}
export interface CardFailure {
  readonly invoiceId: Id;
  readonly attemptId: Id;
  readonly paymentIntentId: string;
  /** Provider outcome: canceled is persisted as failed. A cancelled attempt that was still pending (its intent was
   * never confirmed) gets declineCode confirm_abandoned and leaves the invoice, dunning and retries untouched; any
   * other cancellation gets intent_canceled and is a decline.
   * The adapter normalizes every authentication_required shape to requires_action. */
  readonly outcome: 'failed' | 'requires_action' | 'canceled' | BankFailureCode;
}
export type BankFailureCode = 'insufficient_funds' | 'payment_method_unusable';
export interface ProcessingPayment { invoiceId: Id; paymentIntentId: string; attemptId?: Id }
export interface ProcessingFailure { invoiceId: Id; paymentIntentId: string; code: BankFailureCode }
export interface ManualPayment extends Money {
  readonly invoiceId: Id;
  /** Local UUID, reused when the same command is retried. */
  readonly paymentId: Id;
  readonly method: 'cash' | 'check' | 'other';
  readonly reference?: string;
  readonly paidAt: IsoInstant;
}
export interface RefundTransition extends Money {
  readonly invoiceId: Id;
  readonly paymentId: Id;
  readonly refundId: Id;
  readonly processorId?: string;
  /** canceled: cancelled at the processor before it completed (staff are notified only when the app created it);
   * failed: it did not reach the payer. Both are final and release the amount. */
  readonly status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  /** Marks a new reservation whose processor refund will carry its row ID. It applies only when this call creates the
   * row with status pending, never to an existing row, so a retry of an older reservation keeps its request. */
  readonly tagged?: boolean;
}
/** Processor reads occur before this transition; identity selection and reservation releases are atomic. */
export interface ProcessorRefundTransition {
  readonly invoiceId: Id;
  readonly paymentId: Id;
  /** Stable identity for an external refund; an app reservation or recorded processor ID takes precedence. */
  readonly refundId: Id;
  readonly processorRefund: Refund;
  readonly pendingRefunds: readonly Refund[];
  /** Processor IDs of pending refund rows the processor reported missing (read, not found); never a failed read. */
  readonly missingRefunds?: readonly string[];
}
export interface InvoiceTransitionResult {
  readonly outcome: 'applied' | 'ignored' | 'duplicate_payment';
  readonly invoice: InvoiceSnapshot;
}
/**
 * The sole invoice-state writer. Implementations atomically deduplicate, audit,
 * persist payments/refunds and enqueue receipt, activation and dunning work.
 * Network calls occur after committing. A duplicate card payment is refunded
 * and reported to staff; it never pays an invoice twice. One-off failures do
 * not enter dunning. Payment outcomes never reopen paid, refunded or void invoices. The one backward move is a
 * processor refund that fails after it succeeded (same processor refund ID): its amount is released, the invoice's
 * refund status is recomputed (back to partially refunded or paid) and staff are notified. Staff are notified once for
 * every processor refund that ends failed: first recorded failed, pending to failed, or reversed. A canceled refund is
 * recorded as canceled and released like a failed one; an app-created refund notifies staff once. It never reverses a successful refund.
 * A full refund queues reverse_credits only when the invoice has a class pack sale.
 */
export interface InvoiceTransitions {
  paymentProcessing(context: MutationContext, request: ProcessingPayment): Promise<InvoiceTransitionResult>;
  processingFailed(context: MutationContext, request: ProcessingFailure): Promise<InvoiceTransitionResult>;
  voidInvoice(context: MutationContext, request: VoidInvoiceRequest & { invoiceId: Id }): Promise<InvoiceTransitionResult>;
  settleZero(context: MutationContext, request: { invoiceId: Id }): Promise<InvoiceTransitionResult>;
  cardSucceeded(context: MutationContext, request: CardSuccess): Promise<InvoiceTransitionResult>;
  cardFailed(context: MutationContext, request: CardFailure): Promise<InvoiceTransitionResult>;
  manualPayment(context: MutationContext, request: ManualPayment): Promise<InvoiceTransitionResult>;
  refund(context: MutationContext, request: RefundTransition): Promise<InvoiceTransitionResult>;
  /** Records a processor refund, refusing as not found one whose gym metadata, charge or currency is not this
   * payment's. */
  processorRefund(context: MutationContext, request: ProcessorRefundTransition): Promise<InvoiceTransitionResult>;
}
export interface InvoiceFixture {
  readonly gymId: Id;
  readonly invoice: InvoiceSnapshot;
  readonly checkoutSessionId?: string | null;
  readonly checkoutExpiresAt?: IsoInstant | null;
}
export interface InvoiceAttemptFixture {
  readonly gymId: Id;
  readonly invoiceId: Id;
  readonly id: Id;
  readonly number: number;
  readonly paymentIntentId: string;
  readonly status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'requires_action';
  readonly processingAt?: IsoInstant;
  /** Persisted diagnostic; intent_canceled and confirm_abandoned prevent stale successes resurrecting an intent. */
  readonly declineCode?: string | null;
}
export type InvoiceEffect = {
  readonly gymId: Id;
  readonly invoiceId: Id;
  readonly kind: 'receipt' | 'activate_memberships' | 'reverse_credits' | 'dunning' | 'refund_duplicate' | 'staff_notice';
  readonly paymentId?: Id;
};
interface StoredPayment extends Money {
  method: CardSuccess['method'] | ManualPayment['method'];
  invoiceId: Id; id: Id; accepted: boolean; fingerprint: string; paymentIntentId?: string; chargeId?: string;
}
export interface InvoiceRefundFixture {
  readonly gymId: Id;
  readonly request: RefundTransition;
  readonly tagged?: boolean;
  /** Durable app-request or duplicate-reservation audit markers. */
  readonly requested?: boolean;
  readonly duplicateReserved?: boolean;
  /** The original recorded audit was pending with no processor ID. */
  readonly originalPending?: boolean;
}
// The fake treats a reservation as a duplicate only when it is seeded with `duplicateReserved`. The real
// `duplicateReservation` (areas/billing/transitions/store.ts) also counts a `duplicate_payment` reason with no
// `billing.refund.requested` audit on a payment that wasn't accepted; the fake doesn't model that case.
interface StoredRefund { gymId: Id; request: RefundTransition; appCreated: boolean; tagged: boolean; duplicate: boolean; createdAt: Date; }
const terminal = new Set<InvoiceSnapshot['status']>(['paid', 'partially_refunded', 'refunded', 'void']);
const canceled = (attempt: InvoiceAttemptFixture) => attempt.declineCode === 'intent_canceled' || attempt.declineCode === 'confirm_abandoned';

export class FakeInvoiceTransitions implements InvoiceTransitions {
  readonly #invoices = new Map<string, InvoiceSnapshot>();
  readonly #checkouts = new Map<string, Pick<InvoiceFixture, 'checkoutSessionId' | 'checkoutExpiresAt'>>();
  readonly #attempts = new Map<string, InvoiceAttemptFixture>();
  readonly #payments = new Map<string, StoredPayment>();
  readonly #intents = new Map<string, string>();
  readonly #charges = new Map<string, string>();
  readonly #refunds = new Map<string, StoredRefund>();
  readonly #processorRefunds = new Map<string, string>();
  readonly #effects: InvoiceEffect[] = [];
  readonly #processingHistory = new Map<string, string[]>();
  constructor(invoices: readonly InvoiceFixture[] = [], attempts: readonly InvoiceAttemptFixture[] = [], private readonly clock: Clock = defaultClock,
    private readonly options: { packSale?: (invoiceId: Id) => boolean; assignmentInvoice?: (invoiceId: Id) => boolean } = {}) {
    invoices.forEach(({ gymId, invoice, checkoutSessionId, checkoutExpiresAt }) => {
      const key = scopedKey(gymId, invoice.id);
      this.#invoices.set(key, structuredClone(invoice));
      this.#checkouts.set(key, { checkoutSessionId: checkoutSessionId ?? null, checkoutExpiresAt: checkoutExpiresAt ?? null });
    });
    attempts.forEach((attempt) => this.seedAttempt(attempt));
  }
  seedAttempt(attempt: InvoiceAttemptFixture): void {
    this.#invoice(attempt.gymId, attempt.invoiceId);
    if (!Number.isSafeInteger(attempt.number) || attempt.number < 1) throw new Error('Invalid attempt number');
    const key = scopedKey(attempt.gymId, attempt.id);
    if (this.#attempts.has(key) || [...this.#attempts.values()].some((other) => other.gymId === attempt.gymId
      && (other.paymentIntentId === attempt.paymentIntentId
        || (other.invoiceId === attempt.invoiceId && other.number === attempt.number)))) conflict('Attempt already exists');
    this.#attempts.set(key, structuredClone(attempt));
  }
  get attempts(): readonly InvoiceAttemptFixture[] { return structuredClone([...this.#attempts.values()]); }
  seedRefund(fixture: InvoiceRefundFixture): void {
    const { gymId, request } = fixture, key = scopedKey(gymId, request.refundId);
    const processorKey = request.processorId === undefined ? undefined : JSON.stringify([gymId, request.processorId]);
    if (this.#refunds.has(key) || processorKey !== undefined && this.#processorRefunds.has(processorKey))
      conflict('Refund already exists');
    const tagged = fixture.tagged === true || request.tagged === true && request.status === 'pending';
    this.#refunds.set(key, { gymId, request: structuredClone(request), tagged, duplicate: fixture.duplicateReserved === true,
      createdAt: this.clock.now(), appCreated: request.processorId === undefined || tagged || fixture.requested === true
        || fixture.duplicateReserved === true || fixture.originalPending === true });
    if (processorKey !== undefined) this.#processorRefunds.set(processorKey, key);
  }
  get effects(): readonly InvoiceEffect[] { return structuredClone(this.#effects); }
  get refunds(): RefundTransition[] { return structuredClone([...this.#refunds.values()].map(row => row.request)); }
  get payments(): readonly Omit<StoredPayment, 'fingerprint'>[] {
    return [...this.#payments.values()].map(({ invoiceId, id, amountCents, currency, accepted, method }) =>
      ({ invoiceId, id, amountCents, currency, accepted, method }));
  }
  read(gymId: Id, invoiceId: Id): InvoiceSnapshot { return structuredClone(this.#invoice(gymId, invoiceId)); }
  #invoice(gymId: Id, invoiceId: Id): InvoiceSnapshot {
    return this.#invoices.get(scopedKey(gymId, invoiceId)) ?? notFound();
  }
  #attempt(gymId: Id, invoiceId: Id, attemptId: Id, paymentIntentId: string): InvoiceAttemptFixture {
    const attempt = this.#attempts.get(scopedKey(gymId, attemptId)) ?? notFound();
    if (attempt.invoiceId !== invoiceId || attempt.paymentIntentId !== paymentIntentId) notFound();
    return attempt;
  }
  #result(outcome: InvoiceTransitionResult['outcome'], invoice: InvoiceSnapshot): InvoiceTransitionResult {
    return { outcome, invoice: structuredClone(invoice) };
  }
  #effect(gymId: Id, invoiceId: Id, kind: InvoiceEffect['kind'], paymentId?: Id): void {
    this.#effects.push({ gymId, invoiceId, kind, ...(paymentId === undefined ? {} : { paymentId }) });
  }
  #recordPayment(context: MutationContext, request: CardSuccess | ManualPayment, method: CardSuccess['method'] | ManualPayment['method']) {
    const invoice = this.#invoice(context.gymId, request.invoiceId);
    requireMoney(invoice, request);
    if (request.amountCents <= 0) conflict('Payment must be positive');
    instant(request.paidAt);
    const key = scopedKey(context.gymId, request.paymentId);
    const fingerprint = JSON.stringify([request.invoiceId, request.amountCents, request.currency, method,
      'paymentIntentId' in request ? request.paymentIntentId : request.reference ?? null,
      'chargeId' in request ? request.chargeId : null]);
    const existing = this.#payments.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) conflict('Payment ID reused with different parameters');
      return this.#result('ignored', invoice);
    }
    if ('paymentIntentId' in request) {
      for (const [index, id] of [[this.#intents, request.paymentIntentId], [this.#charges, request.chargeId]] as const) {
        const otherKey = index.get(JSON.stringify([context.gymId, id]));
        if (otherKey !== undefined) {
          const other = this.#payments.get(otherKey)!;
          if (other.fingerprint !== fingerprint) conflict('Processor payment already belongs to another payment');
          return this.#result('ignored', invoice);
        }
      }
    }
    if (!('paymentIntentId' in request)) {
      if (invoice.status === 'processing') conflict('Payment is processing');
      if (invoice.status === 'void') conflict('Void invoice cannot accept a payment');
      if (terminal.has(invoice.status)) conflict('Invoice is already paid');
    }
    const accepted = !terminal.has(invoice.status);
    this.#payments.set(key, { id: request.paymentId, invoiceId: invoice.id, accepted, fingerprint, method,
      amountCents: request.amountCents, currency: request.currency,
      ...('paymentIntentId' in request ? { paymentIntentId: request.paymentIntentId, chargeId: request.chargeId } : {}) });
    if ('paymentIntentId' in request) {
      this.#intents.set(JSON.stringify([context.gymId, request.paymentIntentId]), key);
      this.#charges.set(JSON.stringify([context.gymId, request.chargeId]), key);
    }
    if (!accepted) {
      this.#effect(context.gymId, invoice.id, 'refund_duplicate', request.paymentId);
      this.#effect(context.gymId, invoice.id, 'staff_notice', request.paymentId);
      return this.#result('duplicate_payment', invoice);
    }
    const paid: InvoiceSnapshot = { ...invoice, status: 'paid', paidAt: request.paidAt };
    this.#invoices.set(scopedKey(context.gymId, invoice.id), paid);
    this.#effect(context.gymId, invoice.id, 'receipt', request.paymentId);
    this.#effect(context.gymId, invoice.id, 'activate_memberships', request.paymentId);
    return this.#result('applied', paid);
  }
  async voidInvoice(context: MutationContext, request: VoidInvoiceRequest & { invoiceId: Id }): Promise<InvoiceTransitionResult> {
    idSchema.parse(request.invoiceId); voidInvoiceRequestSchema.parse({ reason: request.reason });
    const invoice = this.#invoice(context.gymId, request.invoiceId);
    if (invoice.status === 'void') return this.#result('ignored', invoice);
    const refuse = (reason: string, message: string): never => { throw new AppError('conflict', message, { reason: [reason] }); };
    if (!['open', 'past_due'].includes(invoice.status)) refuse('not_payable', 'Only unpaid invoices can be voided');
    const attempts = [...this.#attempts.values()].filter(attempt => attempt.gymId === context.gymId && attempt.invoiceId === invoice.id);
    if (attempts.some(attempt => attempt.status === 'pending')) refuse('pending_attempt', 'Resolve the pending card attempt before voiding');
    if (attempts.some(attempt => attempt.status === 'requires_action')) refuse('action_required', 'Resolve the authentication attempt before voiding');
    const checkout = this.#checkouts.get(scopedKey(context.gymId, invoice.id));
    if (checkout?.checkoutSessionId || checkout?.checkoutExpiresAt && new Date(checkout.checkoutExpiresAt) > this.clock.now())
      refuse('checkout_reserved', 'Resolve the reserved Checkout before voiding');
    const voided = { ...invoice, status: 'void' as const };
    this.#invoices.set(scopedKey(context.gymId, invoice.id), voided);
    return this.#result('applied', voided);
  }
  async cardSucceeded(context: MutationContext, request: CardSuccess): Promise<InvoiceTransitionResult> {
    if (request.attemptId !== undefined) {
      const attempt = this.#attempt(context.gymId, request.invoiceId, request.attemptId, request.paymentIntentId);
      if (canceled(attempt) && this.#invoice(context.gymId, request.invoiceId).status !== 'void')
        return this.#result('ignored', this.#invoice(context.gymId, request.invoiceId));
    }
    const result = this.#recordPayment(context, request, request.method);
    if (request.attemptId !== undefined) {
      const key = scopedKey(context.gymId, request.attemptId);
      this.#attempts.set(key, { ...this.#attempts.get(key)!, status: 'succeeded' });
    }
    return result;
  }
  async cardFailed(context: MutationContext, request: CardFailure): Promise<InvoiceTransitionResult> {
    const invoice = this.#invoice(context.gymId, request.invoiceId);
    const attempt = this.#attempt(context.gymId, invoice.id, request.attemptId, request.paymentIntentId);
    // A terminal invoice never moves; only an attempt still unresolved on it is closed.
    if (terminal.has(invoice.status) && !['pending', 'processing', 'requires_action'].includes(attempt.status)) return this.#result('ignored', invoice);
    if (attempt.status === 'succeeded' || canceled(attempt) || (attempt.status === 'requires_action' && request.outcome === 'failed')) return this.#result('ignored', invoice);
    // A cancelled, never-confirmed attempt never reached the card: close it without touching the invoice or dunning.
    if (request.outcome === 'canceled' && attempt.status === 'pending') {
      this.#attempts.set(scopedKey(context.gymId, attempt.id), { ...attempt, status: 'failed', declineCode: 'confirm_abandoned' });
      return this.#result('applied', invoice);
    }
    const status = request.outcome === 'requires_action' ? 'requires_action' : 'failed';
    const alreadyResolved = attempt.status === status;
    this.#attempts.set(scopedKey(context.gymId, attempt.id), { ...attempt, status,
      ...(request.outcome === 'canceled' ? { declineCode: 'intent_canceled' } :
        request.outcome === 'insufficient_funds' || request.outcome === 'payment_method_unusable' ? { declineCode: request.outcome } : {}) });
    const latest = Math.max(...[...this.#attempts.values()].filter((item) => item.gymId === context.gymId
      && item.invoiceId === invoice.id).map((item) => item.number));
    if (terminal.has(invoice.status) || attempt.number < latest || alreadyResolved) return this.#result('ignored', invoice);
    const key = scopedKey(context.gymId, invoice.id);
    if (invoice.status === 'processing' && attempt.status !== 'processing' && this.#processingHistory.get(key)?.at(-1) !== request.paymentIntentId)
      return this.#result('ignored', invoice);
    const bankCode = request.outcome === 'insufficient_funds' || request.outcome === 'payment_method_unusable' ? request.outcome : undefined;
    return this.#failInvoice(context.gymId, invoice, bankCode);
  }
  async manualPayment(context: MutationContext, request: ManualPayment): Promise<InvoiceTransitionResult> {
    return this.#recordPayment(context, request, request.method);
  }
  async paymentProcessing(context: MutationContext, request: ProcessingPayment): Promise<InvoiceTransitionResult> {
    const invoice = this.#invoice(context.gymId, request.invoiceId), key = scopedKey(context.gymId, invoice.id);
    const history = this.#processingHistory.get(key) ?? [];
    const attempt = request.attemptId ? this.#attempt(context.gymId, invoice.id, request.attemptId, request.paymentIntentId)
      : [...this.#attempts.values()].find(row => row.gymId === context.gymId && row.paymentIntentId === request.paymentIntentId);
    if (attempt && attempt.invoiceId !== invoice.id) notFound();
    // Like the real transition, a terminal invoice skips the history check and only updates a pending attempt.
    if ((!terminal.has(invoice.status) && history.includes(request.paymentIntentId)) || attempt && attempt.status !== 'pending')
      return this.#result('ignored', invoice);
    if (invoice.status === 'processing') conflict('Another payment is processing');
    if (attempt) this.#attempts.set(scopedKey(context.gymId, attempt.id), { ...attempt, status: 'processing', processingAt: this.clock.now().toISOString() });
    if (terminal.has(invoice.status)) return this.#result('ignored', invoice);
    this.#processingHistory.set(key, [...history, request.paymentIntentId]);
    const next = { ...invoice, status: 'processing' as const };
    this.#invoices.set(key, next);
    return this.#result('applied', next);
  }
  async processingFailed(context: MutationContext, request: ProcessingFailure): Promise<InvoiceTransitionResult> {
    const invoice = this.#invoice(context.gymId, request.invoiceId), key = scopedKey(context.gymId, invoice.id);
    if (invoice.status !== 'processing' || this.#processingHistory.get(key)?.at(-1) !== request.paymentIntentId)
      return this.#result('ignored', invoice);
    if ([...this.#attempts.values()].some(row => row.gymId === context.gymId && row.paymentIntentId === request.paymentIntentId))
      conflict('Runner failure requires its attempt');
    this.#checkouts.delete(key);
    return this.#failInvoice(context.gymId, invoice, request.code);
  }
  #failInvoice(gymId: Id, invoice: InvoiceSnapshot, bankCode?: BankFailureCode): InvoiceTransitionResult {
    const recurring = invoice.kind === 'cycle' || (!!bankCode || invoice.status === 'past_due') && this.options.assignmentInvoice?.(invoice.id);
    const next: InvoiceSnapshot = { ...invoice, status: recurring ? 'past_due' : 'open' };
    this.#invoices.set(scopedKey(gymId, invoice.id), next);
    if (recurring || bankCode === 'payment_method_unusable') this.#effect(gymId, invoice.id, 'dunning');
    return this.#result('applied', next);
  }
  async settleZero(context: MutationContext, request: { invoiceId: Id }): Promise<InvoiceTransitionResult> {
    const invoice = this.#invoice(context.gymId, request.invoiceId);
    if (invoice.amountCents !== 0) conflict('Invoice is not zero value');
    if (invoice.status === 'void') conflict('Void invoice cannot be settled');
    if (terminal.has(invoice.status)) return this.#result('ignored', invoice);
    if (!['open', 'past_due'].includes(invoice.status)) conflict('Invoice is not payable');
    if ([...this.#payments.entries()].some(([key, payment]) => key === scopedKey(context.gymId, payment.id)
      && payment.invoiceId === invoice.id && payment.accepted))
      conflict('Invoice already has an accepted payment');
    const next: InvoiceSnapshot = { ...invoice, status: 'paid', paidAt: this.clock.now().toISOString() };
    this.#invoices.set(scopedKey(context.gymId, invoice.id), next);
    this.#effect(context.gymId, invoice.id, 'activate_memberships');
    return this.#result('applied', next);
  }
  async refund(context: MutationContext, request: RefundTransition): Promise<InvoiceTransitionResult> {
    return this.#applyRefund(context, request);
  }
  #applyRefund(context: MutationContext, request: RefundTransition, appCreated = false, missing = false): InvoiceTransitionResult {
    const invoice = this.#invoice(context.gymId, request.invoiceId);
    if (invoice.status === 'processing') conflict('Payment is processing');
    const payment = this.#payments.get(scopedKey(context.gymId, request.paymentId)) ?? notFound();
    if (payment.invoiceId !== invoice.id) notFound();
    moneySchema.parse({ amountCents: request.amountCents, currency: request.currency });
    if (request.amountCents <= 0 || request.currency !== payment.currency) conflict('Invalid refund money');
    if (request.status === 'canceled' && request.processorId === undefined) conflict('Only a processor refund can be canceled');
    const key = scopedKey(context.gymId, request.refundId);
    const existing = this.#refunds.get(key)?.request;
    if (existing && (existing.paymentId !== request.paymentId || existing.amountCents !== request.amountCents
      || existing.currency !== request.currency || (existing.processorId !== undefined && existing.processorId !== request.processorId)))
      conflict('Refund ID reused with different parameters');
    const reversed = existing?.status === 'succeeded' && request.status === 'failed'
      && existing.processorId !== undefined && existing.processorId === request.processorId;
    if (existing && !reversed && (existing.status === request.status && (existing.processorId !== undefined || request.processorId === undefined)
      || existing.status !== 'pending')) return this.#result('ignored', invoice);
    const processorKey = request.processorId === undefined ? undefined : JSON.stringify([context.gymId, request.processorId]);
    if (processorKey !== undefined) {
      const other = this.#processorRefunds.get(processorKey);
      if (other !== undefined && other !== key) conflict('Processor refund already recorded');
    }
    const reserved = [...this.#refunds.entries()].filter(([otherKey, { gymId, request: other }]) => otherKey !== key
      && gymId === context.gymId && other.paymentId === payment.id && !refundReleased(other))
      .reduce((sum, [, { request: other }]) => sum + other.amountCents, 0);
    if (!refundReleased(request) && reserved + request.amountCents > payment.amountCents) conflict('Refund exceeds payment');
    const previous = this.#refunds.get(key);
    const tagged = previous?.tagged ?? (request.tagged === true && request.status === 'pending');
    const createdInApp = previous?.appCreated ?? (request.processorId === undefined || tagged);
    appCreated ||= createdInApp;
    this.#refunds.set(key, { gymId: context.gymId, request: structuredClone(request), appCreated: createdInApp, tagged,
      duplicate: previous?.duplicate ?? false, createdAt: previous?.createdAt ?? this.clock.now() });
    if (processorKey !== undefined) this.#processorRefunds.set(processorKey, key);
    // In the real rule's order: a released missing row, a failed or app-created canceled processor refund, then a
    // released duplicate reservation or one the system released past the retry window.
    if (missing && request.status === 'failed') this.#effect(context.gymId, invoice.id, 'staff_notice', payment.id);
    else if (request.status === 'failed' && request.processorId !== undefined || request.status === 'canceled' && appCreated)
      this.#effect(context.gymId, invoice.id, 'staff_notice', payment.id);
    else if (request.status === 'failed' && request.processorId === undefined && previous && (previous.duplicate
      || context.actor.kind === 'system' && this.clock.now().getTime() - previous.createdAt.getTime() >= refundRetryWindowMs))
      this.#effect(context.gymId, invoice.id, 'staff_notice', payment.id);
    if (!(request.status === 'succeeded' || (reversed && ['partially_refunded', 'refunded'].includes(invoice.status)))
      || !payment.accepted) return this.#result('applied', invoice);
    const refunded = [...this.#refunds.entries()].filter(([, { gymId, request: other }]) =>
      gymId === context.gymId && other.invoiceId === invoice.id && other.status === 'succeeded'
      && this.#payments.get(scopedKey(context.gymId, other.paymentId))?.accepted)
      .reduce((sum, [, { request: other }]) => sum + other.amountCents, 0);
    const next: InvoiceSnapshot = { ...invoice,
      status: refunded === 0 ? 'paid' : refunded >= invoice.amountCents ? 'refunded' : 'partially_refunded' };
    if (next.status === 'refunded' && invoice.status !== 'refunded' && this.options.packSale?.(invoice.id))
      this.#effect(context.gymId, invoice.id, 'reverse_credits');
    this.#invoices.set(scopedKey(context.gymId, invoice.id), next);
    return this.#result('applied', next);
  }
  async processorRefund(context: MutationContext, input: ProcessorRefundTransition): Promise<InvoiceTransitionResult> {
    // Match the database transaction: a failed decision leaves no released reservations or effects behind.
    const refunds = new Map(this.#refunds), processors = new Map(this.#processorRefunds), invoices = new Map(this.#invoices);
    const effects = this.#effects.length;
    try { return this.#applyProcessorRefund(context, input); }
    catch (error) {
      this.#refunds.clear(); refunds.forEach((row, key) => this.#refunds.set(key, row));
      this.#processorRefunds.clear(); processors.forEach((row, key) => this.#processorRefunds.set(key, row));
      this.#invoices.clear(); invoices.forEach((row, key) => this.#invoices.set(key, row));
      this.#effects.length = effects;
      throw error;
    }
  }
  #applyProcessorRefund(context: MutationContext, input: ProcessorRefundTransition): InvoiceTransitionResult {
    const invoice = this.#invoice(context.gymId, input.invoiceId);
    const payment = this.#payments.get(scopedKey(context.gymId, input.paymentId)) ?? notFound();
    if (payment.invoiceId !== invoice.id) notFound();
    const value = input.processorRefund;
    if (value.metadata.gymId !== context.gymId || value.currency.toUpperCase() !== payment.currency
      || ![payment.paymentIntentId, payment.chargeId].includes(value.chargeId)) notFound();
    const request: RefundTransition = { invoiceId: input.invoiceId, paymentId: input.paymentId, refundId: input.refundId,
      processorId: value.id, amountCents: value.amount, currency: value.currency.toUpperCase(), status: value.status };
    const read = () => [...this.#refunds.values()].filter(row => row.gymId === context.gymId && row.request.paymentId === payment.id);
    let rows = read();
    const appCreated = rows.some(row => row.tagged && row.request.refundId === value.reservationId
      && row.request.amountCents === value.amount && row.request.currency === request.currency);
    const recorded = rows.find(row => row.request.processorId === value.id);
    if (recorded) return this.#applyRefund(context, { ...request, refundId: recorded.request.refundId }, appCreated);
    const reservations = rows.filter(row => row.request.processorId === undefined && row.request.status === 'pending');
    const own = reservations.find(row => row.tagged && row.request.refundId === value.reservationId && row.request.amountCents === value.amount);
    if (own) return this.#applyRefund(context, { ...request, refundId: own.request.refundId });
    const untagged = reservations.filter(row => !row.tagged);
    if (value.reservationId === undefined && untagged.length) {
      if (untagged.length !== 1 || untagged[0]!.request.amountCents !== value.amount || untagged[0]!.request.currency !== request.currency)
        throw new Error('Refund reservation is ambiguous');
      return this.#applyRefund(context, { ...request, refundId: untagged[0]!.request.refundId });
    }
    if (!refundReleased(value)) {
      let unread = false;
      const missing: StoredRefund[] = [];
      for (const stored of rows.filter(row => row.request.processorId !== undefined && row.request.status === 'pending')) {
        const row = stored.request;
        const current = input.pendingRefunds.find(refund => refund.id === row.processorId);
        if (!current && input.missingRefunds?.includes(row.processorId!)) {
          missing.push(stored);
          continue;
        }
        if (!current || current.amount !== row.amountCents || current.currency.toUpperCase() !== row.currency
          || current.metadata.gymId !== context.gymId || ![payment.paymentIntentId, payment.chargeId].includes(current.chargeId)) {
          unread = true;
          continue;
        }
        if (refundReleased(current)) this.#applyRefund(context, { ...row, status: current.status });
      }
      rows = read();
      let excess = rows.filter(row => !refundReleased(row.request)).reduce((sum, row) => sum + row.request.amountCents, value.amount - payment.amountCents);
      const newestFirst = (a: StoredRefund, b: StoredRefund) => b.createdAt.getTime() - a.createdAt.getTime()
        || b.request.refundId.localeCompare(a.request.refundId);
      for (const { request: row } of missing.sort(newestFirst)) {
        if (excess <= 0) break;
        this.#applyRefund(context, { ...row, status: 'failed' }, false, true);
        excess -= row.amountCents;
      }
      if (excess > 0 && unread) conflict('Pending refund must be reconciled before recording an external refund');
      const outrun = [...reservations].sort(newestFirst);
      if (excess > outrun.reduce((sum, row) => sum + row.request.amountCents, 0)) conflict('Refund exceeds payment');
      for (const { request: row } of outrun) {
        if (excess <= 0) break;
        this.#applyRefund(context, { ...row, status: 'failed' });
        excess -= row.amountCents;
      }
    }
    return this.#applyRefund(context, request, appCreated);
  }
}
