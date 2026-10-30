// SPDX-License-Identifier: AGPL-3.0-only
import type { Id, IsoInstant, Money } from '@plaingym/shared/contracts';
import { moneySchema } from '@plaingym/shared/contracts';
import { conflict, instant, notFound, requireMoney, scopedKey } from './common.js';
import { clock as defaultClock, type Clock } from '../clock.js';
import type { MutationContext } from './common.js';

export interface InvoiceSnapshot extends Money {
  readonly id: Id;
  readonly householdId: Id;
  readonly number: number;
  readonly kind: 'cycle' | 'one_off';
  readonly status: 'open' | 'processing' | 'past_due' | 'paid' | 'void' | 'partially_refunded' | 'refunded';
  readonly paidAt: IsoInstant | null;
}
export interface CardSuccess extends Money {
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
  readonly outcome: 'failed' | 'requires_action' | 'canceled';
}
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
  readonly status: 'pending' | 'succeeded' | 'failed';
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
 * every processor refund that ends failed: first recorded failed, pending to failed, or reversed.
 */
export interface InvoiceTransitions {
  settleZero(context: MutationContext, request: { invoiceId: Id }): Promise<InvoiceTransitionResult>;
  cardSucceeded(context: MutationContext, request: CardSuccess): Promise<InvoiceTransitionResult>;
  cardFailed(context: MutationContext, request: CardFailure): Promise<InvoiceTransitionResult>;
  manualPayment(context: MutationContext, request: ManualPayment): Promise<InvoiceTransitionResult>;
  refund(context: MutationContext, request: RefundTransition): Promise<InvoiceTransitionResult>;
}
export interface InvoiceFixture { readonly gymId: Id; readonly invoice: InvoiceSnapshot; }
export interface InvoiceAttemptFixture {
  readonly gymId: Id;
  readonly invoiceId: Id;
  readonly id: Id;
  readonly number: number;
  readonly paymentIntentId: string;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'requires_action';
  /** Persisted diagnostic; intent_canceled and confirm_abandoned prevent stale successes resurrecting an intent. */
  readonly declineCode?: string | null;
}
export type InvoiceEffect = {
  readonly gymId: Id;
  readonly invoiceId: Id;
  readonly kind: 'receipt' | 'activate_memberships' | 'dunning' | 'refund_duplicate' | 'staff_notice';
  readonly paymentId?: Id;
};
interface StoredPayment extends Money { invoiceId: Id; id: Id; accepted: boolean; fingerprint: string; }
interface StoredRefund { gymId: Id; request: RefundTransition; }
const terminal = new Set<InvoiceSnapshot['status']>(['paid', 'partially_refunded', 'refunded', 'void']);
const canceled = (attempt: InvoiceAttemptFixture) => attempt.declineCode === 'intent_canceled' || attempt.declineCode === 'confirm_abandoned';

export class FakeInvoiceTransitions implements InvoiceTransitions {
  readonly #invoices = new Map<string, InvoiceSnapshot>();
  readonly #attempts = new Map<string, InvoiceAttemptFixture>();
  readonly #payments = new Map<string, StoredPayment>();
  readonly #intents = new Map<string, string>();
  readonly #charges = new Map<string, string>();
  readonly #refunds = new Map<string, StoredRefund>();
  readonly #processorRefunds = new Map<string, string>();
  readonly #effects: InvoiceEffect[] = [];
  constructor(invoices: readonly InvoiceFixture[] = [], attempts: readonly InvoiceAttemptFixture[] = [], private readonly clock: Clock = defaultClock) {
    invoices.forEach(({ gymId, invoice }) => this.#invoices.set(scopedKey(gymId, invoice.id), structuredClone(invoice)));
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
  get effects(): readonly InvoiceEffect[] { return structuredClone(this.#effects); }
  get payments(): readonly Omit<StoredPayment, 'fingerprint'>[] {
    return [...this.#payments.values()].map(({ invoiceId, id, amountCents, currency, accepted }) =>
      ({ invoiceId, id, amountCents, currency, accepted }));
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
  #recordPayment(context: MutationContext, request: CardSuccess | ManualPayment, method: 'card' | ManualPayment['method']) {
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
    if (invoice.status === 'void') conflict('Void invoice cannot accept a payment');
    if (terminal.has(invoice.status) && method !== 'card') conflict('Invoice is already paid');
    const accepted = !terminal.has(invoice.status);
    this.#payments.set(key, { id: request.paymentId, invoiceId: invoice.id, accepted, fingerprint,
      amountCents: request.amountCents, currency: request.currency });
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
  async cardSucceeded(context: MutationContext, request: CardSuccess): Promise<InvoiceTransitionResult> {
    if (request.attemptId !== undefined) {
      const attempt = this.#attempt(context.gymId, request.invoiceId, request.attemptId, request.paymentIntentId);
      if (canceled(attempt)) return this.#result('ignored', this.#invoice(context.gymId, request.invoiceId));
    }
    const result = this.#recordPayment(context, request, 'card');
    if (request.attemptId !== undefined) {
      const key = scopedKey(context.gymId, request.attemptId);
      this.#attempts.set(key, { ...this.#attempts.get(key)!, status: 'succeeded' });
    }
    return result;
  }
  async cardFailed(context: MutationContext, request: CardFailure): Promise<InvoiceTransitionResult> {
    const invoice = this.#invoice(context.gymId, request.invoiceId);
    const attempt = this.#attempt(context.gymId, invoice.id, request.attemptId, request.paymentIntentId);
    if (attempt.status === 'succeeded' || canceled(attempt) || (attempt.status === 'requires_action' && request.outcome === 'failed')) return this.#result('ignored', invoice);
    // A cancelled, never-confirmed attempt never reached the card: close it without touching the invoice or dunning.
    if (request.outcome === 'canceled' && attempt.status === 'pending') {
      this.#attempts.set(scopedKey(context.gymId, attempt.id), { ...attempt, status: 'failed', declineCode: 'confirm_abandoned' });
      return this.#result('applied', invoice);
    }
    const status = request.outcome === 'canceled' ? 'failed' : request.outcome;
    const alreadyResolved = attempt.status === status;
    this.#attempts.set(scopedKey(context.gymId, attempt.id), { ...attempt, status,
      ...(request.outcome === 'canceled' ? { declineCode: 'intent_canceled' } : {}) });
    const latest = Math.max(...[...this.#attempts.values()].filter((item) => item.gymId === context.gymId
      && item.invoiceId === invoice.id).map((item) => item.number));
    if (terminal.has(invoice.status) || attempt.number < latest || alreadyResolved) return this.#result('ignored', invoice);
    const next: InvoiceSnapshot = { ...invoice, status: invoice.kind === 'cycle' ? 'past_due' : 'open' };
    this.#invoices.set(scopedKey(context.gymId, invoice.id), next);
    if (invoice.kind === 'cycle') this.#effect(context.gymId, invoice.id, 'dunning');
    return this.#result('applied', next);
  }
  async manualPayment(context: MutationContext, request: ManualPayment): Promise<InvoiceTransitionResult> {
    return this.#recordPayment(context, request, request.method);
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
    const invoice = this.#invoice(context.gymId, request.invoiceId);
    const payment = this.#payments.get(scopedKey(context.gymId, request.paymentId)) ?? notFound();
    if (payment.invoiceId !== invoice.id) notFound();
    moneySchema.parse({ amountCents: request.amountCents, currency: request.currency });
    if (request.amountCents <= 0 || request.currency !== payment.currency) conflict('Invalid refund money');
    const key = scopedKey(context.gymId, request.refundId);
    const existing = this.#refunds.get(key)?.request;
    if (existing && JSON.stringify([existing.paymentId, existing.amountCents, existing.currency, existing.processorId])
      !== JSON.stringify([request.paymentId, request.amountCents, request.currency, request.processorId]))
      conflict('Refund ID reused with different parameters');
    const reversed = existing?.status === 'succeeded' && request.status === 'failed'
      && existing.processorId !== undefined && existing.processorId === request.processorId;
    if (existing && !reversed && (existing.status === request.status || existing.status !== 'pending')) return this.#result('ignored', invoice);
    const processorKey = request.processorId === undefined ? undefined : JSON.stringify([context.gymId, request.processorId]);
    if (processorKey !== undefined) {
      const other = this.#processorRefunds.get(processorKey);
      if (other !== undefined && other !== key) conflict('Processor refund already recorded');
    }
    const reserved = [...this.#refunds.entries()].filter(([otherKey, { gymId, request: other }]) => otherKey !== key
      && gymId === context.gymId && other.paymentId === payment.id && other.status !== 'failed')
      .reduce((sum, [, { request: other }]) => sum + other.amountCents, 0);
    if (request.status !== 'failed' && reserved + request.amountCents > payment.amountCents) conflict('Refund exceeds payment');
    this.#refunds.set(key, { gymId: context.gymId, request: structuredClone(request) });
    if (processorKey !== undefined) this.#processorRefunds.set(processorKey, key);
    // A failed refund never moves again, so each processor refund that ends failed notifies staff once.
    if (request.status === 'failed' && request.processorId !== undefined)
      this.#effect(context.gymId, invoice.id, 'staff_notice', payment.id);
    if (!(request.status === 'succeeded' || (reversed && ['partially_refunded', 'refunded'].includes(invoice.status)))
      || !payment.accepted) return this.#result('applied', invoice);
    const refunded = [...this.#refunds.entries()].filter(([, { gymId, request: other }]) =>
      gymId === context.gymId && other.invoiceId === invoice.id && other.status === 'succeeded'
      && this.#payments.get(scopedKey(context.gymId, other.paymentId))?.accepted)
      .reduce((sum, [, { request: other }]) => sum + other.amountCents, 0);
    const next: InvoiceSnapshot = { ...invoice,
      status: refunded === 0 ? 'paid' : refunded >= invoice.amountCents ? 'refunded' : 'partially_refunded' };
    this.#invoices.set(scopedKey(context.gymId, invoice.id), next);
    return this.#result('applied', next);
  }
}
