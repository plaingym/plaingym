// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';

export type ChargeReference = { kind: 'charge' | 'checkout'; id: string };
export interface PaymentMetadata {
  readonly gymId: string;
  readonly linkId?: string;
  readonly invoiceId?: string;
  readonly attemptId?: string;
}
export interface ChargeIdentity {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly customerId: string;
  readonly paymentMethodId?: string;
  /** The processor's charge for the latest confirmation (Stripe `latest_charge`), once one was attempted. */
  readonly latestChargeId?: string;
  readonly metadata: PaymentMetadata;
}
export type ChargeOutcome =
  | (ChargeIdentity & { status: 'succeeded'; succeededAt?: Date })
  | (ChargeIdentity & { status: 'failed'; code: 'declined' | 'canceled' | 'provider_error' })
  | (ChargeIdentity & { status: 'action_required'; code: 'authentication_required' })
  | (ChargeIdentity & { status: 'pending' })
  | { status: 'unknown'; reference: ChargeReference };
export interface CreateCharge {
  readonly amount: number;
  readonly currency: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly invoiceId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
}
export interface CreateCustomer {
  readonly email: string;
  readonly name: string;
  readonly householdId: string;
  readonly idempotencyKey: string;
}
/** Only an in-flight request using the same key can be retried automatically. */
export class CustomerCreationInProgress extends Error {
  constructor(options?: ErrorOptions) {
    super('Customer creation is in progress', options);
    this.name = 'CustomerCreationInProgress';
  }
}
interface CheckoutOptions {
  readonly mode: 'payment' | 'setup';
  readonly linkId?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly invoiceId?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly saveForOffSession: boolean;
  readonly idempotencyKey: string;
}
export type CheckoutRequest = CheckoutOptions & { readonly customerId: string };
export interface CheckoutSession {
  readonly id: string;
  readonly mode: 'payment' | 'setup';
  readonly savesCard: boolean;
  readonly url: string;
  readonly status: 'open' | 'complete' | 'expired';
  readonly chargeId?: string;
  readonly setupId?: string;
  readonly paymentMethodId?: string;
  readonly customerId: string;
  readonly metadata: PaymentMetadata;
}
export type CheckoutExpiry =
  { status: 'expired' } | { status: 'already_completed'; session: CheckoutSession } | { status: 'uncertain' };
export interface Refund {
  readonly id: string;
  readonly chargeId: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: 'succeeded' | 'pending' | 'failed';
  readonly metadata: PaymentMetadata;
}
export interface Dispute {
  readonly id: string;
  readonly chargeId: string;
  readonly amount: number;
  readonly status: 'open' | 'won' | 'lost' | 'closed';
}
export interface PaymentMethod {
  readonly id: string;
  readonly brand?: string;
  readonly createdAt: Date;
  readonly customerId: string;
  readonly last4: string;
  readonly expiresMonth: number;
  readonly expiresYear: number;
}
export interface SetupOutcome {
  readonly id: string;
  readonly customerId: string;
  readonly status: 'succeeded' | 'pending' | 'action_required' | 'failed';
  readonly paymentMethodId?: string;
  readonly metadata: PaymentMetadata;
}
export type PaymentObjectReference = {
  kind: 'charge' | 'checkout' | 'setup' | 'payment_method' | 'refund' | 'dispute';
  id: string;
};
export type PaymentObject =
  | { kind: 'charge'; object: ChargeOutcome }
  | { kind: 'checkout'; object: CheckoutSession }
  | { kind: 'setup'; object: SetupOutcome }
  | { kind: 'payment_method'; object: PaymentMethod }
  | { kind: 'refund'; object: Refund }
  | { kind: 'dispute'; object: Dispute };
export type PaymentObjectResult =
  { status: 'found'; value: PaymentObject } | { status: 'unknown'; reference: PaymentObjectReference };
export type PaymentChange =
  | { kind: 'charge'; changedAt: Date; object: ChargeOutcome }
  | { kind: 'checkout'; changedAt: Date; object: CheckoutSession }
  | { kind: 'refund'; changedAt: Date; object: Refund }
  | { kind: 'dispute'; changedAt: Date; object: Dispute }
  | { kind: 'setup'; changedAt: Date; object: SetupOutcome }
  | { kind: 'payment_method'; changedAt: Date; object: PaymentMethod };
export interface PaymentEvent {
  readonly id: string;
  readonly type: string;
  readonly gymId: string;
  readonly objectId: string;
  readonly objectKind: PaymentObjectReference['kind'];
}
export interface Payments {
  /** Creates a customer owned by this gym and household; callers persist the key before calling. */
  createCustomer(request: CreateCustomer): Promise<{ id: string; email: string }>;
  createCharge(request: CreateCharge): Promise<{ id: string }>;
  confirmCharge(id: string, options: { idempotencyKey: string }): Promise<ChargeOutcome>;
  cancelCharge(id: string): Promise<ChargeOutcome>;
  /** includeSuccessTime retrieves the latest Charge's creation time for payment accounting. */
  findCharge(reference: ChargeReference, options?: { includeSuccessTime?: boolean }): Promise<ChargeOutcome>;
  /** All refunds of this PaymentIntent, including dashboard refunds; no event-history scan. */
  listRefunds(chargeId: string): Promise<readonly Refund[]>;
  /** Re-fetches the referenced object at the adapter's pinned API version. */
  readPaymentObject(reference: PaymentObjectReference): Promise<PaymentObjectResult>;
  listChangesSince(
    since: Date,
    options?: { cursor?: string; limit?: number },
  ): Promise<{
    changes: readonly PaymentChange[];
    nextCursor: string | null;
  }>;
  refund(request: { chargeId: string; amount: number; idempotencyKey: string }): Promise<Refund>;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  expireCheckout(id: string): Promise<CheckoutExpiry>;
  findCustomerByEmail(email: string): Promise<readonly { id: string; email: string }[]>;
  /**
   * Tags a customer created outside this app (an imported Stripe customer ID) with this gym, so charges and
   * Checkout accept it. Idempotent; refuses a customer tagged for another gym or deleted. Call it only on
   * staff-provided IDs, never on IDs taken from untrusted input.
   */
  adoptCustomer(customerId: string): Promise<{ id: string; email: string | null }>;
  /** Detach a gym-owned card; missing and already detached methods succeed. */
  detachPaymentMethod(processorId: string): Promise<void>;
  parseWebhook(body: Uint8Array, signature: string): Promise<PaymentEvent>;
}

export interface ProviderChargeState extends ChargeIdentity {
  status: string;
  succeededAt?: Date;
  last_payment_error?: { code?: string } | null;
}

function needsAuthentication(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false;
  const value = error as Record<string, unknown>;
  return (
    value.code === 'authentication_required' ||
    ['raw', 'error', 'payment_intent', 'last_payment_error'].some((key) =>
      needsAuthentication(value[key], depth + 1),
    )
  );
}

export function normalizeChargeOutcome(charge: ProviderChargeState, error?: unknown): ChargeOutcome {
  const identity: ChargeIdentity = {
    id: charge.id,
    amount: charge.amount,
    currency: charge.currency,
    customerId: charge.customerId,
    ...(charge.paymentMethodId ? { paymentMethodId: charge.paymentMethodId } : {}),
    ...(charge.latestChargeId ? { latestChargeId: charge.latestChargeId } : {}),
    metadata: { ...charge.metadata },
  };
  if (charge.status === 'succeeded') return { ...identity, status: 'succeeded', ...(charge.succeededAt ? { succeededAt: charge.succeededAt } : {}) };
  if (charge.status === 'canceled') return { ...identity, status: 'failed', code: 'canceled' };
  if (
    charge.status === 'requires_action' ||
    needsAuthentication(charge.last_payment_error) ||
    needsAuthentication(error)
  ) {
    return { ...identity, status: 'action_required', code: 'authentication_required' };
  }
  if (charge.status === 'requires_payment_method' && charge.last_payment_error) {
    return {
      ...identity,
      status: 'failed',
      code: charge.last_payment_error.code === 'card_declined' ? 'declined' : 'provider_error',
    };
  }
  return { ...identity, status: 'pending' };
}

type StoredCharge = Exclude<ChargeOutcome, { status: 'unknown' }>;
type Confirmation = 'succeeded' | 'declined' | 'authentication_required' | 'pending';
type ChangeRecord = { kind: PaymentChange['kind']; id: string; changedAt: Date };
type IdempotentRecord = { fingerprint: string; result: unknown; expiresAt: number };

function money(amount: number, currency: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[a-z]{3}$/.test(currency)) {
    throw new Error('Expected positive integer cents and a lowercase ISO currency');
  }
}

export class FakePayments implements Payments {
  readonly #charges = new Map<string, StoredCharge>();
  readonly #checkouts = new Map<string, CheckoutSession>();
  readonly #checkoutRequests = new Map<string, CheckoutRequest>();
  readonly #refunds = new Map<string, Refund>();
  readonly #methods = new Map<string, PaymentMethod>();
  readonly #detached = new Set<string>();
  readonly #setups = new Map<string, SetupOutcome>();
  readonly #disputes = new Map<string, Dispute>();
  readonly #customers: { id: string; email: string; gymId: string; name?: string; householdId?: string }[] = [];
  readonly #changes: ChangeRecord[] = [];
  readonly #idempotency = new Map<string, IdempotentRecord>();
  readonly #uncertain = new Set<string>();
  #confirmation: Confirmation | { error: unknown } = 'succeeded';
  #loseResponse: 'createCustomer' | 'createCharge' | 'confirmCharge' | 'createCheckout' | 'refund' | undefined;
  #nextId = 0;
  readonly #customerCreationsInFlight = new Set<string>();
  #nextCustomerCreation: Promise<void> | undefined;
  constructor(
    readonly gymId: string,
    readonly clock: Clock = systemClock,
    readonly webhookSecret = 'fake-webhook-secret',
    readonly idempotencyWindowMs = 86_400_000,
  ) {}
  respondNextConfirmation(result: Confirmation | { error: unknown }): void {
    this.#confirmation = result;
  }
  /** Hold one create request so simultaneous uses of its key see the provider's conflict. */
  holdNextCustomerCreation(until: Promise<void>): void { this.#nextCustomerCreation = until; }
  loseNextResponse(operation: 'createCustomer' | 'createCharge' | 'confirmCharge' | 'createCheckout' | 'refund'): void {
    this.#loseResponse = operation;
  }
  setUncertain(id: string, uncertain = true): void {
    if (uncertain) this.#uncertain.add(id);
    else this.#uncertain.delete(id);
  }
  seedCustomer(customer: { id: string; email: string; gymId?: string }): void {
    this.#customers.push({ ...customer, gymId: customer.gymId ?? this.gymId });
  }
  recordPaymentMethod(method: Omit<PaymentMethod, 'createdAt'> & { createdAt?: Date }): void {
    this.#methods.set(method.id, structuredClone({ ...method, createdAt: method.createdAt ?? this.#methods.get(method.id)?.createdAt ?? this.clock.now() }));
    this.#record('payment_method', method.id);
  }
  recordSetup(setup: SetupOutcome): void {
    if (setup.metadata.gymId !== this.gymId) throw new Error('Setup belongs to another gym');
    this.#setups.set(setup.id, structuredClone(setup));
    this.#record('setup', setup.id);
  }
  #id(prefix: string): string {
    return `${prefix}_${++this.#nextId}`;
  }
  #record(kind: ChangeRecord['kind'], id: string): void {
    this.#changes.push({ kind, id, changedAt: this.clock.now() });
  }
  #once<T>(operation: string, key: string, fingerprint: string, run: () => T): T {
    if (!key) throw new Error('An idempotency key is required');
    // Provider idempotency keys share one namespace across endpoints.
    const existing = this.#idempotency.get(key);
    const input = operation + ':' + fingerprint;
    if (existing && existing.expiresAt > this.clock.now().getTime()) {
      if (existing.fingerprint !== input) throw new Error('Idempotency key reused with different parameters');
      return structuredClone(existing.result) as T;
    }
    const result = run();
    this.#idempotency.set(key, {
      fingerprint: input,
      result: structuredClone(result),
      expiresAt: this.clock.now().getTime() + this.idempotencyWindowMs,
    });
    return structuredClone(result);
  }
  #reply<T>(operation: 'createCustomer' | 'createCharge' | 'confirmCharge' | 'createCheckout' | 'refund', result: T): T {
    if (this.#loseResponse === operation) {
      this.#loseResponse = undefined;
      throw new Error('Provider response lost; reconcile by ID');
    }
    return result;
  }
  async createCustomer(request: CreateCustomer): Promise<{ id: string; email: string }> {
    assertNoTransaction('payments.createCustomer');
    if (!request.email?.trim() || !request.name.trim() || !request.householdId) throw new Error('Customer details are required');
    if (this.#customerCreationsInFlight.has(request.idempotencyKey)) throw new CustomerCreationInProgress();
    const until = this.#nextCustomerCreation;
    this.#nextCustomerCreation = undefined;
    this.#customerCreationsInFlight.add(request.idempotencyKey);
    try {
      if (until) await until;
      const result = this.#once('customer', request.idempotencyKey,
        JSON.stringify([request.email, request.name, request.householdId]), () => {
          const customer = { id: this.#id('cus'), email: request.email, name: request.name,
            gymId: this.gymId, householdId: request.householdId };
          this.#customers.push(customer);
          return { id: customer.id, email: customer.email };
        });
      return this.#reply('createCustomer', result);
    } finally { this.#customerCreationsInFlight.delete(request.idempotencyKey); }
  }
  async createCharge(request: CreateCharge): Promise<{ id: string }> {
    assertNoTransaction('payments.createCharge');
    if (this.#detached.has(request.paymentMethodId)) throw new Error('Payment method is detached');
    money(request.amount, request.currency);
    const result = this.#once(
      'create',
      request.idempotencyKey,
      JSON.stringify([
        request.amount,
        request.currency,
        request.customerId,
        request.paymentMethodId,
        request.invoiceId,
        request.attemptId,
      ]),
      () => {
        const id = this.#id('pi');
        this.#charges.set(id, {
          id,
          amount: request.amount,
          currency: request.currency,
          customerId: request.customerId,
          paymentMethodId: request.paymentMethodId,
          metadata: { gymId: this.gymId, invoiceId: request.invoiceId, attemptId: request.attemptId },
          status: 'pending',
        });
        this.#record('charge', id);
        return { id };
      },
    );
    return this.#reply('createCharge', result);
  }
  async confirmCharge(id: string, options: { idempotencyKey: string }): Promise<ChargeOutcome> {
    assertNoTransaction('payments.confirmCharge');
    const result = this.#once<ChargeOutcome>('confirm', options.idempotencyKey, id, () => {
      const charge = this.#charges.get(id);
      if (!charge || this.#uncertain.has(id)) return { status: 'unknown', reference: { kind: 'charge', id } };
      if (charge.status === 'succeeded' || (charge.status === 'failed' && charge.code === 'canceled'))
        return charge;
      const response = this.#confirmation;
      this.#confirmation = 'succeeded';
      if (typeof response === 'object' && response !== null && 'error' in response) {
        if (!needsAuthentication(response.error)) throw response.error;
      }
      const status =
        response === 'succeeded'
          ? 'succeeded'
          : response === 'declined'
            ? 'failed'
            : response === 'pending'
              ? 'pending'
              : 'action_required';
      const identity: ChargeIdentity = {
        id: charge.id,
        amount: charge.amount,
        currency: charge.currency,
        customerId: charge.customerId,
        ...(charge.paymentMethodId ? { paymentMethodId: charge.paymentMethodId } : {}),
        // As at Stripe, a confirmation that reached the card network created a charge.
        ...(status === 'succeeded' || status === 'failed' ? { latestChargeId: this.#id('ch') } : {}),
        metadata: charge.metadata,
      };
      const next: StoredCharge =
        status === 'failed'
          ? { ...identity, status, code: 'declined' }
          : status === 'action_required'
            ? { ...identity, status, code: 'authentication_required' }
            : status === 'succeeded'
              ? { ...identity, status: 'succeeded', succeededAt: this.clock.now() }
              : { ...identity, status: 'pending' };
      this.#charges.set(id, next);
      this.#record('charge', id);
      return next;
    });
    return this.#reply('confirmCharge', result);
  }
  async cancelCharge(id: string): Promise<ChargeOutcome> {
    assertNoTransaction('payments.cancelCharge');
    const charge = this.#charges.get(id);
    if (!charge || this.#uncertain.has(id)) return { status: 'unknown', reference: { kind: 'charge', id } };
    if (charge.status === 'succeeded') return structuredClone(charge);
    const result: StoredCharge = { ...charge, status: 'failed', code: 'canceled' };
    this.#charges.set(id, result);
    this.#record('charge', id);
    return structuredClone(result);
  }
  async findCharge(reference: ChargeReference, _options?: { includeSuccessTime?: boolean }): Promise<ChargeOutcome> {
    assertNoTransaction('payments.findCharge');
    const id = reference.kind === 'checkout' ? this.#checkouts.get(reference.id)?.chargeId : reference.id;
    if (!id || this.#uncertain.has(reference.id) || this.#uncertain.has(id)) {
      return { status: 'unknown', reference: { ...reference } };
    }
    return structuredClone(this.#charges.get(id) ?? { status: 'unknown', reference });
  }
  async listRefunds(chargeId: string): Promise<readonly Refund[]> {
    assertNoTransaction('payments.listRefunds');
    if (!this.#charges.has(chargeId) || this.#uncertain.has(chargeId)) throw new Error('Refund payment is unresolved');
    return structuredClone([...this.#refunds.values()].filter(refund => refund.chargeId === chargeId));
  }
  async readPaymentObject(reference: PaymentObjectReference): Promise<PaymentObjectResult> {
    assertNoTransaction('payments.readPaymentObject');
    if (this.#uncertain.has(reference.id)) return { status: 'unknown', reference: { ...reference } };
    let value: PaymentObject | undefined;
    const id = reference.id;
    switch (reference.kind) {
      case 'charge':
        if (this.#charges.has(id)) value = { kind: 'charge', object: this.#charges.get(id)! };
        break;
      case 'checkout':
        if (this.#checkouts.has(id)) value = { kind: 'checkout', object: this.#checkouts.get(id)! };
        break;
      case 'setup':
        if (this.#setups.has(id)) value = { kind: 'setup', object: this.#setups.get(id)! };
        break;
      case 'payment_method':
        if (this.#detached.has(id)) return { status: 'unknown', reference };
        if (this.#methods.has(id)) value = { kind: 'payment_method', object: this.#methods.get(id)! };
        break;
      case 'refund':
        if (this.#refunds.has(id)) value = { kind: 'refund', object: this.#refunds.get(id)! };
        break;
      case 'dispute':
        if (this.#disputes.has(id)) value = { kind: 'dispute', object: this.#disputes.get(id)! };
        break;
    }
    return structuredClone(value ? { status: 'found', value } : { status: 'unknown', reference });
  }
  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    assertNoTransaction('payments.createCheckout');
    if (request.mode === 'payment') money(request.amount ?? 0, request.currency ?? '');
    if (!request.customerId) throw new Error('Customer ID is required');
    const result = this.#once(
      'checkout',
      request.idempotencyKey,
      JSON.stringify([
        request.mode,
        request.customerId,
        request.amount,
        request.currency,
        request.invoiceId,
        request.successUrl,
        request.cancelUrl,
        request.saveForOffSession,
        request.linkId,
      ]),
      () => {
        const id = this.#id('cs');
        const customerId = request.customerId;
        const session: CheckoutSession = {
          id,
          customerId,
          mode: request.mode,
          savesCard: request.mode === 'setup' || request.saveForOffSession,
          url: `https://checkout.invalid/${id}`,
          status: 'open',
          metadata: { gymId: this.gymId, ...(request.invoiceId ? { invoiceId: request.invoiceId } : {}),
            ...(request.linkId ? { linkId: request.linkId } : {}) },
        };
        this.#checkouts.set(id, session);
        this.#checkoutRequests.set(id, structuredClone(request));
        this.#record('checkout', id);
        return session;
      },
    );
    return this.#reply('createCheckout', result);
  }
  completeCheckout(id: string): CheckoutSession {
    const session = this.#checkouts.get(id);
    const request = this.#checkoutRequests.get(id);
    if (!session || !request) throw new Error('Unknown Checkout session');
    if (session.status === 'expired') throw new Error('Checkout has expired');
    if (session.status === 'complete') return structuredClone(session);
    const chargeId = session.mode === 'payment' ? this.#id('pi') : undefined;
    const paymentMethodId = this.#id('pm');
    if (session.savesCard) this.recordPaymentMethod({
      id: paymentMethodId,
      customerId: session.customerId,
      last4: '4242',
      brand: 'visa',
      expiresMonth: 12,
      expiresYear: this.clock.now().getUTCFullYear() + 3,
    });
    const setupId = session.mode === 'setup' ? this.#id('seti') : undefined;
    if (setupId)
      this.recordSetup({
        id: setupId,
        customerId: session.customerId,
        status: 'succeeded',
        paymentMethodId,
        metadata: session.metadata,
      });
    if (chargeId) {
      this.#charges.set(chargeId, {
        id: chargeId,
        amount: request.amount!,
        currency: request.currency!,
        customerId: session.customerId,
        paymentMethodId,
        latestChargeId: this.#id('ch'),
        metadata: session.metadata,
        status: 'succeeded',
        succeededAt: this.clock.now(),
      });
      this.#record('charge', chargeId);
    }
    const completed: CheckoutSession = {
      ...session,
      status: 'complete',
      paymentMethodId,
      ...(setupId ? { setupId } : {}),
      ...(chargeId ? { chargeId } : {}),
    };
    this.#checkouts.set(id, completed);
    this.#record('checkout', id);
    return structuredClone(completed);
  }
  async expireCheckout(id: string): Promise<CheckoutExpiry> {
    assertNoTransaction('payments.expireCheckout');
    const session = this.#checkouts.get(id);
    if (!session || this.#uncertain.has(id)) return { status: 'uncertain' };
    if (session.status === 'complete')
      return { status: 'already_completed', session: structuredClone(session) };
    this.#checkouts.set(id, { ...session, status: 'expired' });
    this.#record('checkout', id);
    return { status: 'expired' };
  }
  async refund(request: { chargeId: string; amount: number; idempotencyKey: string }): Promise<Refund> {
    assertNoTransaction('payments.refund');
    const result = this.#once(
      'refund',
      request.idempotencyKey,
      JSON.stringify([request.chargeId, request.amount]),
      () => {
        const charge = this.#charges.get(request.chargeId);
        if (!charge || charge.status !== 'succeeded')
          throw new Error('Only successful charges can be refunded');
        money(request.amount, charge.currency);
        const refunded = [...this.#refunds.values()]
          .filter((refund) => refund.chargeId === charge.id && refund.status !== 'failed')
          .reduce((sum, refund) => sum + refund.amount, 0);
        if (refunded + request.amount > charge.amount) throw new Error('Refund exceeds charge');
        const refund: Refund = {
          id: this.#id('re'),
          chargeId: charge.id,
          amount: request.amount,
          currency: charge.currency,
          metadata: charge.metadata,
          status: 'succeeded',
        };
        this.#refunds.set(refund.id, refund);
        this.#record('refund', refund.id);
        return refund;
      },
    );
    return this.#reply('refund', result);
  }
  recordDispute(dispute: Dispute): void {
    if (!this.#charges.has(dispute.chargeId)) throw new Error('Unknown disputed charge');
    this.#disputes.set(dispute.id, structuredClone(dispute));
    this.#record('dispute', dispute.id);
  }
  async listChangesSince(since: Date, options: { cursor?: string; limit?: number } = {}) {
    assertNoTransaction('payments.listChangesSince');
    const start = Number(options.cursor ?? '0');
    const limit = options.limit ?? 100;
    if (
      !Number.isFinite(since.getTime()) ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new Error('Invalid change page');
    const records = this.#changes.filter((change) => change.changedAt >= since);
    const page = records.slice(start, start + limit);
    const changes: PaymentChange[] = page.map((record) => {
      switch (record.kind) {
        case 'charge':
          return {
            ...record,
            kind: 'charge',
            object: this.#uncertain.has(record.id)
              ? { status: 'unknown', reference: { kind: 'charge', id: record.id } }
              : this.#charges.get(record.id)!,
          };
        case 'checkout':
          return { ...record, kind: 'checkout', object: this.#checkouts.get(record.id)! };
        case 'refund':
          return { ...record, kind: 'refund', object: this.#refunds.get(record.id)! };
        case 'dispute':
          return { ...record, kind: 'dispute', object: this.#disputes.get(record.id)! };
        case 'setup':
          return { ...record, kind: 'setup', object: this.#setups.get(record.id)! };
        case 'payment_method':
          return { ...record, kind: 'payment_method', object: this.#methods.get(record.id)! };
      }
    });
    return structuredClone({
      changes,
      nextCursor: start + limit < records.length ? String(start + limit) : null,
    });
  }
  async findCustomerByEmail(email: string): Promise<readonly { id: string; email: string }[]> {
    assertNoTransaction('payments.findCustomerByEmail');
    return structuredClone(
      this.#customers.filter((customer) => customer.gymId === this.gymId && customer.email.toLowerCase() === email.toLowerCase())
        .map(({ id, email }) => ({ id, email })),
    );
  }
  /** Seeded customers belong to this gym; unknown IDs fail like a missing Stripe customer. */
  async adoptCustomer(customerId: string): Promise<{ id: string; email: string | null }> {
    assertNoTransaction('payments.adoptCustomer');
    const customer = this.#customers.find((item) => item.id === customerId);
    if (!customer) throw new Error('No such customer');
    if (customer.gymId !== this.gymId) throw new Error('Customer belongs to another gym');
    return { id: customer.id, email: customer.email };
  }
  async detachPaymentMethod(processorId: string): Promise<void> {
    assertNoTransaction('payments.detachPaymentMethod');
    if (!/^[A-Za-z0-9_]+$/.test(processorId)) throw new Error('Invalid processor ID');
    const method = this.#methods.get(processorId);
    if (!method || this.#detached.has(processorId)) return;
    await this.adoptCustomer(method.customerId);
    this.#detached.add(processorId);
  }
  signWebhook(body: Uint8Array): string {
    return createHmac('sha256', this.webhookSecret).update(body).digest('hex');
  }
  async parseWebhook(body: Uint8Array, signature: string): Promise<PaymentEvent> {
    assertNoTransaction('payments.parseWebhook');
    const expected = Buffer.from(this.signWebhook(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new Error('Invalid webhook signature');
    const event: unknown = JSON.parse(new TextDecoder().decode(body));
    if (
      typeof event !== 'object' ||
      !event ||
      !('id' in event) ||
      typeof event.id !== 'string' ||
      !('type' in event) ||
      typeof event.type !== 'string' ||
      !('gymId' in event) ||
      event.gymId !== this.gymId ||
      !('objectId' in event) ||
      typeof event.objectId !== 'string' ||
      !('objectKind' in event) ||
      typeof event.objectKind !== 'string' ||
      !['charge', 'checkout', 'setup', 'payment_method', 'refund', 'dispute'].includes(event.objectKind)
    )
      throw new Error('Invalid payment event');
    return {
      id: event.id,
      type: event.type,
      gymId: event.gymId,
      objectId: event.objectId,
      objectKind: event.objectKind as PaymentObjectReference['kind'],
    };
  }
}
