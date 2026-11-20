// SPDX-License-Identifier: AGPL-3.0-only
import Stripe from 'stripe';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
import { CustomerCreationInProgress, CustomerDeleted, ERASED_CUSTOMER_NAME, normalizeChargeOutcome, type DetachOptions, type Payments, type CreateCustomer, type CreateCharge, type CheckoutRequest,
  type CheckoutSession, type CheckoutExpiry, type ChargeReference, type ChargeOutcome, type PaymentMetadata,
  type PaymentObjectReference, type PaymentObjectResult, type PaymentObject, type PaymentChange,
  type PaymentEvent, type Refund, type RefundRequest, type CustomerMatch, CardImportRefused, CardCursorRefused,
  type CustomerCardPage, type CustomerCardQuery, type PaymentMethod, type PaymentMethodType, type BankPaymentMethod,
  type BankAccountImportRead, type BankPaymentMethodForImport, BankDebitUnavailable, hasBankLast4 } from './index.js';
import type { Json, ObjectData, PaymentTransport, ProviderRequest } from './transport.js';
import { PaymentWebhookError } from './webhook-error.js';
import { matchesBillingEmail, type ClearCustomerEmail } from './email-erasure.js';
import { logWarn } from '../../core/log.js';

export const STRIPE_API_VERSION = '2026-09-30.endive' as const;
export const STRIPE_PERMISSIONS = [
  ['Customers', 'Write'], ['Payment Intents', 'Write'], ['Checkout Sessions', 'Write'],
  ['Setup Intents', 'Read'], ['Mandates', 'Read'], ['Payment Methods', 'Write'], ['Charges and Refunds', 'Write'], ['Webhook Endpoints', 'Write'],
  ['Events', 'Read'], ['Disputes', 'Read'],
] as const;
export const STRIPE_EVENTS = ['payment_intent.created', 'payment_intent.succeeded', 'payment_intent.payment_failed',
  'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.canceled',
  'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'setup_intent.succeeded', 'setup_intent.setup_failed',
  'payment_method.attached', 'payment_method.updated', 'payment_method.automatically_updated', 'charge.refunded', 'refund.created', 'refund.updated',
  'refund.failed', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'];

export function data(value: unknown): ObjectData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Stripe object');
  return value as ObjectData;
}
function id(value: Json | undefined): string { return typeof value === 'string' ? value : String(data(value).id ?? ''); }
function optionalId(value: Json | undefined): string | undefined { return value ? id(value) : undefined; }
function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'resource_missing'
    && 'statusCode' in error && error.statusCode === 404;
}
function permissionDenied(error: unknown): boolean {
  const failure = error as { statusCode?: number; code?: string; type?: string; rawType?: string; raw?: { type?: string } } | null;
  return failure?.statusCode === 403 || failure?.type === 'StripePermissionError'
    || [failure?.code, failure?.type, failure?.rawType, failure?.raw?.type].includes('permission_error');
}
// Amounts go to Stripe exactly as stored: integers in the currency's minor units (500 is ¥500, $5.00 or 0.500 KWD).
function money(amount: number | undefined, currency: string | undefined): void {
  if (!Number.isSafeInteger(amount) || !amount || amount < 1 || !currency || !/^[a-z]{3}$/.test(currency))
    throw new Error('Expected a positive integer amount in minor units and a lowercase ISO currency');
}
function key(value: string): void { if (!value || value.length > 200) throw new Error('Invalid idempotency key'); }
function optionalTimestamp(value: Json | undefined): Date | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? new Date(value * 1000) : undefined;
}
function timestamp(value: Json | undefined): Date {
  const time = optionalTimestamp(value);
  if (!time) throw new Error('Invalid provider timestamp');
  return time;
}
class NotForGym extends Error {}
class IncompleteBankMethod extends NotForGym {
  constructor(readonly customerId: string) { super('Bank account has no usable last four digits'); }
}
function methodType(method: ObjectData): PaymentMethodType {
  // Older recorded card responses contain the card object without a type discriminator.
  if (method.type === 'card' || (method.type === undefined && method.card)) return 'card';
  if (method.type === 'us_bank_account' || method.type === 'acss_debit') return method.type;
  throw new Error('Invalid Stripe object');
}
function readMethod(method: ObjectData): PaymentMethod {
  const type = methodType(method);
  const details = type === 'card' ? data(method.card) : data(method[type] ?? {});
  const identity = { id: id(method.id), customerId: id(method.customer), createdAt: timestamp(method.created) };
  if (type !== 'card') {
    if (!hasBankLast4(details.last4)) throw new IncompleteBankMethod(identity.customerId);
    return { ...identity, type, last4: details.last4, ...(typeof details.bank_name === 'string' ? { bankName: details.bank_name } : {}) };
  }
  return { ...identity, type, last4: String(details.last4), ...(typeof details.brand === 'string' ? { brand: details.brand } : {}),
    expiresMonth: Number(details.exp_month), expiresYear: Number(details.exp_year) };
}
function bankOptionRefused(error: unknown): boolean {
  const failure = error as { type?: string; rawType?: string; param?: string; raw?: { type?: string; param?: string } } | null;
  const param = failure?.param ?? failure?.raw?.param;
  const invalidRequest = failure?.type === 'StripeInvalidRequestError' || failure?.type === 'invalid_request_error'
    || failure?.rawType === 'invalid_request_error' || failure?.raw?.type === 'invalid_request_error';
  if (!invalidRequest || typeof param !== 'string') return false;
  return /^(?:allowed_)?payment_method_types(?:\[\d+\])?$/.test(param)
    || /^payment_method_options\[(?:us_bank_account|acss_debit)\](?!\[mandate_options\])(?:\[[^\]]+\])*$/.test(param);
}
function queryString(params: ObjectData): string {
  const query = new URLSearchParams();
  const append = (name: string, value: Json | undefined): void => {
    if (value === undefined) return;
    if (value !== null && typeof value === 'object') {
      for (const [child, item] of Object.entries(value)) append(name + '[' + child + ']', item);
    } else query.append(name, value === null ? '' : String(value));
  };
  for (const [name, value] of Object.entries(params)) append(name, value);
  return query.toString();
}
export function stripeTransport(apiKey: string, options: { testOnly?: boolean; demo?: boolean } = {}): PaymentTransport {
  if (!/^(rk|sk)_(test|live)_[A-Za-z0-9]+$/.test(apiKey)) throw new Error('Invalid Stripe secret key');
  if ((options.testOnly || options.demo || process.env.DEMO_MODE === 'true') && apiKey.includes('_live_'))
    throw new Error('Only Stripe test-mode keys are supported in this context');
  const stripe = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION, timeout: 20_000, maxNetworkRetries: 0 });
  return { async request(input) {
    assertNoTransaction('payments.stripe');
    // rawRequest only accepts a body on POST; all read filters belong in the URL.
    const query = input.method !== 'POST' && input.params ? queryString(input.params) : '';
    const path = input.path + (query ? (input.path.includes('?') ? '&' : '?') + query : '');
    return data(await stripe.rawRequest(input.method, path, input.method === 'POST' ? input.params : undefined, {
      apiVersion: STRIPE_API_VERSION, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    }));
  } };
}

/** An address, shipping or similar object whose fields are all null holds nothing, so it counts as already cleared. */
function holds(value: unknown): boolean {
  return typeof value === 'object' && value !== null ? Object.values(value).some(holds) : !!value;
}
function absent(error: unknown): boolean {
  const value = error as { code?: string; statusCode?: number } | null;
  return value?.code === 'resource_missing' && [400, 404].includes(value.statusCode ?? 0);
}

export class StripePayments implements Payments {
  readonly #transport: PaymentTransport;
  readonly #clock: Clock;
  readonly #secret: string;
  readonly #mode: 'test' | 'live';
  readonly #verifier = Stripe.createNodeCryptoProvider();
  constructor(readonly gymId: string, options: { transport: PaymentTransport; webhookSecret: string; clock?: Clock; mode?: 'test' | 'live' }) {
    if (!gymId) throw new Error('A gym is required');
    this.#transport = options.transport; this.#clock = options.clock ?? systemClock; this.#secret = options.webhookSecret; this.#mode = options.mode ?? 'test';
  }
  get keyMode(): 'test' | 'live' { return this.#mode; }
  #request(input: ProviderRequest): Promise<ObjectData> {
    assertNoTransaction('payments.stripe');
    return this.#transport.request(input);
  }
  #get(path: string, params?: ObjectData): Promise<ObjectData> {
    return this.#request({ method: 'GET', path, ...(params ? { params } : {}) });
  }
  #post(path: string, params: ObjectData, idempotencyKey?: string): Promise<ObjectData> {
    if (idempotencyKey !== undefined) key(idempotencyKey);
    return this.#request({ method: 'POST', path, params, ...(idempotencyKey ? { idempotencyKey } : {}) });
  }
  #path(resource: string, objectId: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(objectId)) throw new Error('Invalid processor ID');
    return '/v1/' + resource + '/' + objectId;
  }
  #metadata(object: ObjectData): PaymentMetadata {
    const metadata = data(object.metadata ?? {});
    if (metadata.gym_id !== this.gymId) {
      throw new NotForGym(metadata.gym_id ? 'Payment object belongs to another gym' : 'Payment object has no gym metadata');
    }
    return { gymId: this.gymId, ...(typeof metadata.invoice_id === 'string' ? { invoiceId: metadata.invoice_id } : {}),
      ...(typeof metadata.attempt_id === 'string' ? { attemptId: metadata.attempt_id } : {}),
      ...(typeof metadata.link_id === 'string' ? { linkId: metadata.link_id } : {}) };
  }
  #intent(object: ObjectData, error?: unknown): ChargeOutcome {
    // An expanded Charge (intent reads and confirmation request it) carries the success time. If it is missing,
    // belongs to another intent or has no valid time, the outcome has none and findCharge reads the Charge itself.
    const charge = object.latest_charge && typeof object.latest_charge === 'object' ? data(object.latest_charge) : undefined;
    const errorMethod = object.last_payment_error && data(object.last_payment_error).payment_method;
    const method = object.payment_method ?? errorMethod ?? charge?.payment_method;
    const type = (method && typeof method === 'object' ? data(method).type : undefined)
      ?? (errorMethod && typeof errorMethod === 'object' ? data(errorMethod).type : undefined)
      ?? (charge?.payment_method_details && data(charge.payment_method_details).type);
    const succeededAt = object.status === 'succeeded' && charge && optionalId(charge.payment_intent) === id(object.id)
      ? optionalTimestamp(charge.created) : undefined;
    return normalizeChargeOutcome({ id: id(object.id), amount: Number(object.amount), currency: String(object.currency),
      customerId: id(object.customer), ...(method ? { paymentMethodId: id(method) } : {}),
      ...(type === 'card' || type === 'us_bank_account' || type === 'acss_debit' ? { paymentMethodType: type } : {}),
      ...(object.latest_charge ? { latestChargeId: id(object.latest_charge) } : {}), ...(succeededAt ? { succeededAt } : {}),
      metadata: this.#metadata(object), status: String(object.status),
      ...(object.last_payment_error ? { last_payment_error: data(object.last_payment_error) as { code?: string } } : {}) }, error);
  }
  /** The expanded Charge gives a successful outcome its success time without another request. */
  async #ownedIntent(objectId: string): Promise<ObjectData> {
    const intent = await this.#get(this.#path('payment_intents', objectId), { expand: ['latest_charge'] });
    this.#metadata(intent); return intent;
  }
  async #ownedCustomer(customerId: string): Promise<void> {
    this.#metadata(await this.#get(this.#path('customers', customerId)));
  }
  async createCustomer(request: CreateCustomer): Promise<{ id: string; email: string }> {
    assertNoTransaction('payments.createCustomer'); key(request.idempotencyKey);
    if (!request.email?.trim() || !request.name.trim() || !request.householdId) throw new Error('Customer details are required');
    let customer: ObjectData;
    try {
      customer = await this.#post('/v1/customers', { email: request.email, name: request.name,
        metadata: { gym_id: this.gymId, household_id: request.householdId } }, request.idempotencyKey);
    } catch (error) {
      // Parameter mismatches and generic 409s are not proof of an in-flight create.
      if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 409
        && 'code' in error && error.code === 'idempotency_key_in_use')
        throw new CustomerCreationInProgress({ cause: error });
      throw error;
    }
    this.#metadata(customer);
    if (customer.deleted === true || !/^cus_[A-Za-z0-9_]+$/.test(id(customer.id))
      || data(customer.metadata).household_id !== request.householdId || customer.email !== request.email)
      throw new Error('Invalid created customer');
    return { id: id(customer.id), email: request.email };
  }
  async createCharge(request: CreateCharge): Promise<{ id: string }> {
    assertNoTransaction('payments.createCharge'); money(request.amount, request.currency); key(request.idempotencyKey);
    // One read checks both: the method is attached to the payer, and the payer (expanded) is this gym's.
    const method = await this.#get(this.#path('payment_methods', request.paymentMethodId), { expand: ['customer'] });
    const payer = method.customer && typeof method.customer === 'object' ? data(method.customer) : undefined;
    if (!payer || id(payer.id) !== request.customerId) throw new Error('Payment method is not attached to payer');
    this.#metadata(payer);
    const type = methodType(method);
    if (type === 'acss_debit' && !request.mandateId) throw new Error('A saved PAD mandate is required');
    const result = await this.#post('/v1/payment_intents', { amount: request.amount, currency: request.currency,
      customer: request.customerId, payment_method: request.paymentMethodId, allowed_payment_method_types: [type], confirm: false,
      metadata: { gym_id: this.gymId, invoice_id: request.invoiceId, attempt_id: request.attemptId,
        ...(type !== 'card' && request.mandateId ? { mandate_id: request.mandateId } : {}),
        ...(request.idempotencyKey.match(/:([0-9]+):create$/)?.[1] ? { attempt_n: request.idempotencyKey.match(/:([0-9]+):create$/)![1]! } : {}) } }, request.idempotencyKey);
    this.#metadata(result); return { id: id(result.id) };
  }
  async confirmCharge(objectId: string, options: { idempotencyKey: string }): Promise<ChargeOutcome> {
    assertNoTransaction('payments.confirmCharge'); key(options.idempotencyKey);
    const before = await this.#ownedIntent(objectId);
    // Stripe refuses to confirm a processing intent (a bank debit settles for days), so it is reported as it stands.
    if (before.status === 'succeeded' || before.status === 'canceled' || before.status === 'processing') return this.#intent(before);
    const mandate = data(before.metadata).mandate_id;
    // As in intent reads, the expanded Charge returns the success time, so recording it needs no further reads.
    try { return this.#intent(await this.#post(this.#path('payment_intents', objectId) + '/confirm',
      { off_session: true, expand: ['latest_charge'], ...(typeof mandate === 'string' ? { mandate } : {}) }, options.idempotencyKey)); }
    catch (error) {
      // Card errors embed the authoritative intent; network/permission errors remain errors, never declines.
      const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
      const raw = record.raw && typeof record.raw === 'object' ? record.raw as Record<string, unknown> : {};
      const embedded = record.payment_intent ?? raw.payment_intent;
      if (embedded && typeof embedded === 'object' && record.type === 'StripeCardError') return this.#intent(data(embedded), error);
      throw error;
    }
  }
  async cancelCharge(objectId: string): Promise<ChargeOutcome> {
    assertNoTransaction('payments.cancelCharge');
    try {
      const before = await this.#ownedIntent(objectId);
      if (before.status === 'succeeded' || before.status === 'canceled' || before.status === 'processing') return this.#intent(before);
      try { return this.#intent(await this.#post(this.#path('payment_intents', objectId) + '/cancel', {})); }
      catch (error) {
        const after = await this.#ownedIntent(objectId);
        if (after.status === 'succeeded' || after.status === 'canceled' || after.status === 'processing') return this.#intent(after);
        throw error;
      }
    } catch (error) { if (missing(error) || error instanceof NotForGym) return { status: 'unknown', reference: { kind: 'charge', id: objectId } }; throw error; }
  }
  async findCharge(reference: ChargeReference, options?: { includeSuccessTime?: boolean }): Promise<ChargeOutcome> {
    assertNoTransaction('payments.findCharge');
    let outcome: ChargeOutcome;
    try {
      if (reference.kind === 'charge') outcome = this.#intent(await this.#ownedIntent(reference.id));
      else {
        const session = await this.#checkout(await this.#get(this.#path('checkout/sessions', reference.id)));
        outcome = session.chargeId ? this.#intent(await this.#ownedIntent(session.chargeId)) : { status: 'unknown', reference };
      }
    } catch (error) { if (missing(error) || error instanceof NotForGym) return { status: 'unknown', reference }; throw error; }
    // The intent read's expanded Charge normally supplies the time. Otherwise read the Charge: a missing one is
    // retryable, never an unknown intent and never permission to substitute the processing clock.
    if (options?.includeSuccessTime && outcome.status === 'succeeded' && !outcome.succeededAt) {
      if (!outcome.latestChargeId) throw new Error('Successful payment requires its processor Charge ID');
      const charge = await this.#get(this.#path('charges', outcome.latestChargeId));
      if (id(charge.payment_intent) !== outcome.id) throw new Error('Successful Charge parent mismatch');
      return { ...outcome, succeededAt: timestamp(charge.created) };
    }
    return outcome;
  }
  async #checkout(object: ObjectData): Promise<CheckoutSession> {
    const metadata = this.#metadata(object), chargeId = optionalId(object.payment_intent), setupId = optionalId(object.setup_intent);
    // Stripe creates a payment session's PaymentIntent only when it is paid; until then the session's own marker,
    // set at creation from the same request as the intent's setup_future_usage, says whether it saves the card.
    let paymentMethodId: string | undefined, savesCard = object.mode === 'setup'
      || (object.mode === 'payment' && data(object.metadata ?? {}).saves_card === 'off_session');
    // Card recordings made before payment_status was captured use the intent's actual state.
    let paymentStatus = object.payment_status ?? (object.mode === 'setup' ? 'no_payment_required' : 'unpaid');
    let mandateId: string | undefined;
    if (chargeId) {
      const intent = await this.#ownedIntent(chargeId);
      if (object.payment_status === undefined && intent.status === 'succeeded') paymentStatus = 'paid';
      const charge = intent.latest_charge && typeof intent.latest_charge === 'object' ? data(intent.latest_charge) : undefined;
      if (charge && optionalId(charge.payment_intent) === chargeId && charge.payment_method_details) {
        const details = data(charge.payment_method_details), type = details.type;
        if ((type === 'us_bank_account' || type === 'acss_debit') && details[type]) mandateId = optionalId(data(details[type]).mandate);
      }
      paymentMethodId = optionalId(intent.payment_method);
      savesCard = intent.setup_future_usage === 'off_session' || intent.setup_future_usage === 'on_session';
    }
    if (setupId) {
      const setup = await this.#get(this.#path('setup_intents', setupId)); this.#metadata(setup);
      paymentMethodId = optionalId(setup.payment_method);
    }
    if (!['open', 'complete', 'expired'].includes(String(object.status)) || !['setup', 'payment'].includes(String(object.mode)))
      throw new Error('Invalid Checkout state');
    if (paymentStatus !== 'paid' && paymentStatus !== 'unpaid' && paymentStatus !== 'no_payment_required') throw new Error('Invalid Checkout payment status');
    return { id: id(object.id), mode: object.mode as 'payment' | 'setup', url: String(object.url ?? ''), paymentStatus,
      ...(mandateId ? { mandateId } : {}),
      status: object.status as CheckoutSession['status'], customerId: id(object.customer), metadata, savesCard,
      ...(chargeId ? { chargeId } : {}), ...(setupId ? { setupId } : {}), ...(paymentMethodId ? { paymentMethodId } : {}) };
  }
  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    assertNoTransaction('payments.createCheckout'); key(request.idempotencyKey);
    if (request.mode === 'payment') money(request.amount, request.currency);
    for (const url of [request.successUrl, request.cancelUrl]) if (new URL(url).protocol !== 'https:') throw new Error('Checkout return URLs require HTTPS');
    const customer = request.customerId;
    if (!customer) throw new Error('Customer ID is required');
    await this.#ownedCustomer(customer);
    const metadata = { gym_id: this.gymId, ...(request.invoiceId ? { invoice_id: request.invoiceId } : {}),
      ...(request.linkId ? { link_id: request.linkId } : {}) };
    const bank = request.bankDebit;
    const params: ObjectData = { mode: request.mode, customer, success_url: request.successUrl, cancel_url: request.cancelUrl,
      allowed_payment_method_types: bank ? ['card', bank.type] : ['card'],
      metadata: request.mode === 'payment' && request.saveForOffSession ? { ...metadata, saves_card: 'off_session' } : metadata,
      ...(request.expiresAt ? { expires_at: Math.floor(request.expiresAt.getTime() / 1000) } : {}),
      ...(request.mode === 'payment' ? { payment_intent_data: { metadata,
        ...(request.saveForOffSession ? { setup_future_usage: 'off_session' } : {}) },
      line_items: [{ quantity: 1, price_data: { currency: request.currency!, unit_amount: request.amount!,
        product_data: { name: 'Invoice payment', metadata } } }] }
      : { setup_intent_data: { metadata } }) };
    if (bank?.type === 'us_bank_account') {
      params.payment_method_options = { us_bank_account: { verification_method: 'instant', financial_connections: { permissions: ['payment_method'] } } };
    } else if (bank?.type === 'acss_debit') {
      params.payment_method_options = { acss_debit: { verification_method: 'instant', ...(request.mode === 'setup' ? { currency: 'cad' } : {}),
        mandate_options: { payment_schedule: 'combined', interval_description: bank.intervalDescription, transaction_type: 'personal' } } };
      if (request.mode === 'setup') params.currency = 'cad';
    }
    let session: ObjectData;
    try { session = await this.#post('/v1/checkout/sessions', params, request.idempotencyKey); }
    catch (error) {
      if (bank && bankOptionRefused(error)) throw new BankDebitUnavailable('Bank debit is unavailable for Checkout', { cause: error });
      throw error;
    }
    return this.#checkout(session);
  }
  async expireCheckout(objectId: string): Promise<CheckoutExpiry> {
    assertNoTransaction('payments.expireCheckout');
    try {
      const before = await this.#checkout(await this.#get(this.#path('checkout/sessions', objectId)));
      if (before.status === 'expired') return { status: 'expired' };
      if (before.status === 'complete') return { status: 'already_completed', session: before };
      try { await this.#post(this.#path('checkout/sessions', objectId) + '/expire', {}); }
      catch { /* Completion can win the race. Always re-read before allowing a retry. */ }
      const after = await this.#checkout(await this.#get(this.#path('checkout/sessions', objectId)));
      return after.status === 'expired' ? { status: 'expired' }
        : after.status === 'complete' ? { status: 'already_completed', session: after } : { status: 'uncertain' };
    } catch { return { status: 'uncertain' }; }
  }
  async #parentIntent(object: ObjectData): Promise<ObjectData> {
    if (data(object.metadata ?? {}).gym_id) this.#metadata(object);
    if (object.payment_intent) return this.#ownedIntent(id(object.payment_intent));
    const charge = await this.#get(this.#path('charges', id(object.charge)));
    if (!charge.payment_intent) throw new NotForGym('Charge has no parent intent');
    return this.#ownedIntent(id(charge.payment_intent));
  }
  async #refund(object: ObjectData): Promise<Refund> {
    const parent = await this.#parentIntent(object);
    // Only the refund's own metadata names a reservation; its gym still comes from the parent.
    const reservationId = data(object.metadata ?? {}).reservation_id;
    return { id: id(object.id), chargeId: id(parent.id), amount: Number(object.amount), currency: String(object.currency),
      status: object.status === 'succeeded' ? 'succeeded' : object.status === 'canceled' ? 'canceled'
        : object.status === 'pending' || object.status === 'requires_action' ? 'pending' : 'failed',
      metadata: this.#metadata(parent), ...(typeof reservationId === 'string' && reservationId ? { reservationId } : {}) };
  }
  async refund(request: RefundRequest): Promise<Refund> {
    assertNoTransaction('payments.refund'); key(request.idempotencyKey);
    const parent = await this.#ownedIntent(request.chargeId); money(request.amount, String(parent.currency));
    if (parent.status !== 'succeeded') throw new Error('Only successful charges can be refunded');
    return this.#refund(await this.#post('/v1/refunds', { payment_intent: request.chargeId, amount: request.amount,
      metadata: { gym_id: this.gymId, ...(data(parent.metadata).invoice_id ? { invoice_id: data(parent.metadata).invoice_id } : {}),
        ...(request.reservationId === undefined ? {} : { reservation_id: request.reservationId }) } }, request.idempotencyKey));
  }
  async listRefunds(chargeId: string): Promise<readonly Refund[]> {
    assertNoTransaction('payments.listRefunds');
    await this.#ownedIntent(chargeId);
    const refunds: Refund[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.#get('/v1/refunds', { payment_intent: chargeId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      const objects = (page.data as Json[]).map(data);
      for (const object of objects) {
        const refund = await this.#refund(object);
        if (refund.chargeId !== chargeId) throw new Error('Refund parent mismatch');
        if (!seen.has(refund.id)) refunds.push(refund);
        seen.add(refund.id);
      }
      const next = page.has_more ? id(objects.at(-1)?.id) : undefined;
      if (page.has_more && (!objects.length || next === cursor)) throw new Error('Invalid Stripe refund page');
      cursor = next;
    } while (cursor);
    return refunds;
  }
  async readPaymentObject(reference: PaymentObjectReference): Promise<PaymentObjectResult> {
    assertNoTransaction('payments.readPaymentObject');
    try { return { status: 'found', value: await this.#read(reference) }; }
    catch (error) {
      if (error instanceof IncompleteBankMethod)
        return { status: 'unknown', reference, incompleteBankMethod: { customerId: error.customerId } };
      if (missing(error) || error instanceof NotForGym) return { status: 'unknown', reference };
      throw error;
    }
  }
  async #withPadMandate(method: BankPaymentMethod): Promise<BankPaymentMethodForImport> {
    let cursor: string | undefined;
    do {
      const page = await this.#get('/v1/setup_intents', { customer: method.customerId, payment_method: method.id,
        limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw new Error('Invalid Stripe setup page');
      const setups = page.data.map(data);
      for (const setup of setups) {
        const owner = data(setup.metadata ?? {}).gym_id;
        if (setup.status !== 'succeeded' || setup.usage !== 'off_session' || optionalId(setup.customer) !== method.customerId
          || optionalId(setup.payment_method) !== method.id || owner !== undefined && owner !== this.gymId
          || typeof setup.mandate !== 'string' || !/^mandate_[A-Za-z0-9_]+$/.test(setup.mandate)) continue;
        const mandateId = setup.mandate;
        let mandate: ObjectData;
        try { mandate = await this.#get(this.#path('mandates', mandateId)); }
        catch (error) {
          if (permissionDenied(error)) return { ...method, mandateReadDenied: true };
          if (missing(error)) continue;
          throw error;
        }
        if (mandate.status === 'active' && mandate.type === 'multi_use' && optionalId(mandate.payment_method) === method.id
          && mandate.id === mandateId)
          return { ...method, mandateId };
      }
      const next = page.has_more ? id(setups.at(-1)?.id) : undefined;
      if (next !== undefined && (!/^seti_[A-Za-z0-9_]+$/.test(next) || next === cursor)) throw new Error('Invalid Stripe setup cursor');
      cursor = next;
    } while (cursor);
    return method;
  }
  async readBankAccountForImport(processorId: string, includeMandate: boolean): Promise<BankAccountImportRead> {
    assertNoTransaction('payments.readBankAccountForImport');
    const object = await this.#get(this.#path('payment_methods', processorId)).catch(error => {
      if (missing(error)) return null;
      throw error;
    });
    if (!object || object.type !== 'us_bank_account' && object.type !== 'acss_debit') return null;
    const owner = data(object.metadata ?? {}).gym_id, customerId = optionalId(object.customer);
    const { last4 } = data(object[object.type] ?? {});
    if (id(object.id) !== processorId || !customerId || owner !== undefined && owner !== this.gymId
      || !hasBankLast4(last4)) return { status: 'unavailable' };
    const customer = await this.#get(this.#path('customers', customerId)).catch(error => {
      if (missing(error)) return null;
      throw error;
    });
    if (!customer || customer.deleted === true || id(customer.id) !== customerId) return { status: 'unavailable' };
    const metadata = data(customer.metadata ?? {});
    if (metadata.gym_id !== undefined && metadata.gym_id !== this.gymId
      || metadata.household_id !== undefined && typeof metadata.household_id !== 'string') return { status: 'unavailable' };
    const method = readMethod(object) as BankPaymentMethod;
    return { status: 'found', method: includeMandate && method.type === 'acss_debit' ? await this.#withPadMandate(method) : method,
      ...(typeof metadata.household_id === 'string' ? { householdId: metadata.household_id } : {}) };
  }
  async #read(reference: PaymentObjectReference): Promise<PaymentObject> {
    let value: PaymentObject;
    switch (reference.kind) {
      case 'charge': value = { kind: 'charge', object: this.#intent(await this.#ownedIntent(reference.id)) }; break;
      case 'checkout': value = { kind: 'checkout', object: await this.#checkout(await this.#get(this.#path('checkout/sessions', reference.id))) }; break;
      case 'refund': value = { kind: 'refund', object: await this.#refund(await this.#get(this.#path('refunds', reference.id))) }; break;
      case 'dispute': {
        const object = await this.#get(this.#path('disputes', reference.id)), parent = await this.#parentIntent(object);
        value = { kind: 'dispute', object: { id: id(object.id), chargeId: id(parent.id), amount: Number(object.amount),
          status: object.status === 'won' || object.status === 'lost' ? object.status
            : ['warning_closed', 'charge_refunded', 'prevented'].includes(String(object.status)) ? 'closed' : 'open' } }; break;
      }
      case 'setup': {
        const object = await this.#get(this.#path('setup_intents', reference.id));
        const metadata = this.#metadata(object);
        value = { kind: 'setup', object: { id: id(object.id), customerId: id(object.customer), metadata,
          ...(object.mandate ? { mandateId: id(object.mandate) } : {}),
          status: object.status === 'succeeded' ? 'succeeded' : object.status === 'requires_action' ? 'action_required'
            : object.status === 'canceled' || (object.status === 'requires_payment_method' && object.last_setup_error) ? 'failed' : 'pending',
          ...(object.payment_method ? { paymentMethodId: id(object.payment_method) } : {}) } }; break;
      }
      case 'payment_method': {
        const object = await this.#get(this.#path('payment_methods', reference.id));
        if (data(object.metadata ?? {}).gym_id) this.#metadata(object);
        if (!object.customer) throw new NotForGym('Payment method has no customer');
        await this.#ownedCustomer(id(object.customer));
        value = { kind: 'payment_method', object: readMethod(object) }; break;
      }
    }
    return value;
  }
  async detachPaymentMethod(processorId: string, options: DetachOptions = {}): Promise<void> {
    assertNoTransaction('payments.detachPaymentMethod');
    const path = this.#path('payment_methods', processorId);
    let method: ObjectData;
    try { method = await this.#get(path); }
    catch (error) { if (absent(error)) return; throw error; }
    if (data(method.metadata ?? {}).gym_id) this.#metadata(method);
    if (!method.customer) return;
    await this.#ownedCustomer(id(method.customer));
    // Stripe updates only an attached card, so erasure clears the billing details first. A failure here stops the detach:
    // the retry finds the card still attached, whereas a detached card could no longer be cleared.
    if (options.redactBillingDetails && holds(method.billing_details)) {
      try { await this.#post(path, { billing_details: { name: '', email: '', phone: '', address: '' } }); }
      catch (error) {
        if (absent(error)) return;
        // Updating a card needs the same Payment Methods permission as detaching it.
        if ((error as { statusCode?: number } | null)?.statusCode === 403)
          throw new Error('Check the Stripe permission for Payment Methods', { cause: error });
        throw error;
      }
    }
    try { await this.#post(path + '/detach', {}); }
    catch (error) {
      if (absent(error)) return;
      if ((error as { statusCode?: number } | null)?.statusCode === 403)
        throw new Error('Check the Stripe permission for Payment Methods', { cause: error });
      // A concurrent detach or a lost response can leave the operation already complete.
      let current: ObjectData;
      try { current = await this.#get(path); }
      catch (readError) { if (absent(readError)) return; throw error; }
      if (current.customer) throw error;
    }
  }
  async clearCustomerEmail(customerId: string, options: ClearCustomerEmail): Promise<boolean> {
    assertNoTransaction('payments.clearCustomerEmail');
    const path = this.#path('customers', customerId);
    const methodPaths = [...new Set([...(options.paymentMethodIds ?? []), ...(options.paymentMethodId ? [options.paymentMethodId] : [])])]
      .map(methodId => this.#path('payment_methods', methodId));
    let customer: ObjectData;
    try { customer = await this.#get(path); }
    catch (error) { if (absent(error)) return false; throw error; }
    if (customer.deleted === true) return false;
    const metadata = data(customer.metadata ?? {});
    if (metadata.gym_id !== undefined && metadata.gym_id !== this.gymId) throw new NotForGym('Customer belongs to another gym');
    if (metadata.household_id !== undefined && metadata.household_id !== options.householdId) throw new Error('Customer belongs to another household');
    // Validate every owner before the first write. Untagged imported customers are checked by the caller's local link.
    const methods: { path: string; method: ObjectData }[] = [];
    for (const methodPath of methodPaths) {
      let method: ObjectData | undefined;
      try { method = await this.#get(methodPath); }
      catch (error) { if (!absent(error)) throw error; }
      if (method?.customer) {
        if (data(method.metadata ?? {}).gym_id !== undefined) this.#metadata(method);
        if (id(method.customer) !== customerId) throw new Error('Card belongs to another customer');
        methods.push({ path: methodPath, method });
      }
    }
    // No idempotency key: every retry reads current fields and never replays a cached write over a replacement address.
    let matched = false;
    if (matchesBillingEmail(customer.email, options.emailDigest, options.secret)) {
      await this.#post(path, { email: '' }); matched = true;
    }
    for (const { path: methodPath, method } of methods) {
      if (matchesBillingEmail(data(method.billing_details ?? {}).email, options.emailDigest, options.secret)) {
        await this.#post(methodPath, { billing_details: { email: '' } }); matched = true;
      }
    }
    return matched;
  }
  async redactCustomer(customerId: string): Promise<void> {
    assertNoTransaction('payments.redactCustomer');
    const path = this.#path('customers', customerId);
    let customer: ObjectData;
    try { customer = await this.#get(path); }
    catch (error) { if (absent(error)) return; throw error; }
    if (customer.deleted === true) return;
    // As adoptCustomer: an untagged customer (imported or made in the dashboard) is the gym's own; another gym's is refused.
    const owner = data(customer.metadata ?? {}).gym_id;
    if (owner !== undefined && owner !== this.gymId) throw new NotForGym('Payment object belongs to another gym');
    const customFields = customer.invoice_settings ? data(customer.invoice_settings).custom_fields : undefined;
    const personal = [customer.email, customer.phone, customer.address, customer.shipping, customer.description,
      customer.individual_name, customer.business_name, customFields];
    if (customer.name !== ERASED_CUSTOMER_NAME || personal.some(holds)) {
      // An empty string clears a field (the email, phone, address, shipping details and description a dashboard customer may hold);
      // the customer's metadata, payments and disputes are unchanged. Setting the same empty values twice is harmless, so there is
      // no idempotency key: a reused key would replay a cached answer and skip details a dashboard edit added since.
      // The individual and business names and the invoice custom fields are sent only when the customer holds them, so an API
      // version that doesn't take them is never sent them.
      await this.#post(path, { name: ERASED_CUSTOMER_NAME, email: '', phone: '', address: '', shipping: '', description: '',
        ...(holds(customer.individual_name) ? { individual_name: '' } : {}),
        ...(holds(customer.business_name) ? { business_name: '' } : {}),
        ...(holds(customFields) ? { invoice_settings: { custom_fields: '' } } : {}) });
    }
    // Neither independent cleanup may block the other. Report the first error only after attempting both.
    let failure: unknown;
    try { await this.#deleteTaxIds(path); } catch (error) { failure = error; }
    try { await this.#redactAttachedCards(customerId); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
  }
  /** Attached payment methods can outlive their local rows. Paginate every type without detaching them. */
  async #redactAttachedCards(customerId: string): Promise<void> {
    try {
      let cursor: string | undefined;
      let failure: unknown;
      for (;;) {
        const page = await this.#get('/v1/payment_methods', { customer: customerId, limit: 100,
          ...(cursor ? { starting_after: cursor } : {}) });
        const methods = (Array.isArray(page.data) ? page.data : []).map(data);
        for (const method of methods) {
          try {
            if (id(method.customer) !== customerId) throw new Error('Card belongs to another customer');
            const owner = data(method.metadata ?? {}).gym_id;
            if (owner !== undefined && owner !== this.gymId) {
              logWarn('payments.redaction.method_skipped_foreign', { gymId: this.gymId, customerId, paymentMethodId: id(method.id) });
              continue;
            }
            if (holds(method.billing_details)) await this.#post(this.#path('payment_methods', id(method.id)),
              { billing_details: { name: '', email: '', phone: '', address: '' } });
          } catch (error) {
            const status = (error as { statusCode?: number } | null)?.statusCode;
            if (status === 401 || status === 403) throw error;
            if (!absent(error)) failure ??= error;
          }
        }
        if (!page.has_more) {
          if (failure !== undefined) throw failure;
          return;
        }
        const next = methods.at(-1)?.id;
        if (typeof next !== 'string' || next === cursor) throw new Error('Invalid card pagination');
        cursor = next;
      }
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode === 403)
        throw new Error('Check the Stripe permission for Payment Methods', { cause: error });
      throw error;
    }
  }
  /** Deletes every tax ID of the customer, a page at a time (a deleted one leaves the list). */
  async #deleteTaxIds(customerPath: string): Promise<void> {
    try {
      for (;;) {
        const page = await this.#get(customerPath + '/tax_ids', { limit: 100 });
        const ids = (Array.isArray(page.data) ? page.data : []).map(item => id(data(item).id));
        for (const taxId of ids) {
          if (!/^[A-Za-z0-9_]+$/.test(taxId)) throw new Error('Invalid processor ID');
          try { await this.#request({ method: 'DELETE', path: customerPath + '/tax_ids/' + taxId }); }
          catch (error) { if (!absent(error)) throw error; }
        }
        if (!ids.length || !page.has_more) return;
      }
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode === 403)
        throw new Error('Check the Stripe permission for Customers (tax IDs)', { cause: error });
      throw error;
    }
  }
  async adoptCustomer(customerId: string): Promise<{ id: string; email: string | null }> {
    assertNoTransaction('payments.adoptCustomer');
    const path = this.#path('customers', customerId), customer = await this.#get(path);
    if (customer.deleted === true) throw new CustomerDeleted();
    const owner = data(customer.metadata ?? {}).gym_id;
    if (owner !== undefined && owner !== this.gymId) throw new NotForGym('Payment object belongs to another gym');
    // Metadata updates merge, so the customer's other keys stay.
    if (owner === undefined) await this.#post(path, { metadata: { gym_id: this.gymId } }, 'customer:' + customerId + ':adopt');
    return { id: id(customer.id), email: typeof customer.email === 'string' ? customer.email : null };
  }
  async listCustomerCards(customerId: string, options: CustomerCardQuery = {}): Promise<CustomerCardPage> {
    assertNoTransaction('payments.listCustomerCards');
    const path = this.#path('customers', customerId), limit = options.limit ?? 100;
    if (options.cursor !== undefined) this.#path('payment_methods', options.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid card page size');
    const customer = await this.#get(path), metadata = data(customer.metadata ?? {});
    if (customer.deleted === true || metadata.gym_id !== this.gymId
      || metadata.household_id !== undefined && metadata.household_id !== options.householdId)
      throw new CardImportRefused('Customer is not owned by this gym and household');
    const types = new Set<PaymentMethodType>(options.types ?? ['card']);
    if (!types.size) return { cards: [], nextCursor: null };
    // Stripe filters on a single type. A mixed page uses its customer-wide cursor, including skipped methods.
    const singleType = types.size === 1 ? [...types][0] : undefined;
    const page = await this.#get('/v1/payment_methods', { customer: customerId, ...(singleType ? { type: singleType } : {}), limit,
      ...(options.cursor ? { starting_after: options.cursor } : {}) }).catch(error => {
      const refused = error as { statusCode?: number; param?: string; raw?: { param?: string } } | null;
      const parameter = refused?.param ?? refused?.raw?.param;
      const cursorRefused = parameter === undefined ? absent(error)
        : parameter === 'starting_after' && [400, 404].includes(refused?.statusCode ?? 0);
      if (options.cursor && cursorRefused)
        throw new CardCursorRefused('Invalid card cursor');
      throw error;
    });
    if (!Array.isArray(page.data) || page.data.length > limit || typeof page.has_more !== 'boolean') throw new Error('Invalid card page');
    const ids = new Set<string>(), cards: CustomerCardPage['cards'][number][] = [];
    for (const value of page.data) {
      const method = data(value), owner = data(method.metadata ?? {}).gym_id;
      if (id(method.customer) !== customerId || owner !== undefined && owner !== this.gymId)
        throw new CardImportRefused('Card belongs to another customer or gym');
      const methodId = id(method.id); this.#path('payment_methods', methodId);
      if (ids.has(methodId)) throw new Error('Invalid card pagination');
      ids.add(methodId);
      if (singleType && method.type !== singleType) throw new Error('Invalid card details');
      if (!types.has(method.type as PaymentMethodType)) continue;
      if (method.type === 'card') {
        const card = data(method.card);
        if (typeof card.last4 !== 'string' || !/^[0-9]{4}$/.test(card.last4)
          || !Number.isInteger(card.exp_month) || Number(card.exp_month) < 1 || Number(card.exp_month) > 12
          || !Number.isInteger(card.exp_year) || Number(card.exp_year) < 2000) throw new Error('Invalid card details');
      }
      try { cards.push(readMethod(method)); }
      catch (error) { if (!(error instanceof IncompleteBankMethod)) throw error; }
    }
    const nextCursor = page.has_more ? [...ids].at(-1) : null;
    if (nextCursor === undefined || nextCursor === options.cursor) throw new Error('Invalid card pagination');
    if (options.includeMandates) {
      const concurrency = 4;
      for (let offset = 0; offset < cards.length; offset += concurrency) {
        await Promise.all(cards.slice(offset, offset + concurrency).map(async (method, index) => {
          if (method.type === 'acss_debit') cards[offset + index] = await this.#withPadMandate(method);
        }));
      }
    }
    return { cards, nextCursor };
  }
  async findCustomerByEmail(email: string): Promise<readonly CustomerMatch[]> {
    assertNoTransaction('payments.findCustomerByEmail');
    const matches: CustomerMatch[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#get('/v1/customers', { email, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      const objects = (page.data as Json[]).map(data);
      for (const object of objects) {
        const metadata = data(object.metadata ?? {});
        if (metadata.gym_id !== this.gymId) continue;
        // Any value names a household, so a malformed one still excludes the customer from other households' matches.
        const household = metadata.household_id;
        matches.push({ id: id(object.id), email: String(object.email),
          ...(household !== undefined && household !== '' ? { householdId: String(household) } : {}) });
      }
      cursor = page.has_more ? id(objects.at(-1)?.id) : undefined;
      if (page.has_more && !objects.length) throw new Error('Invalid Stripe page');
    } while (cursor);
    return matches;
  }
  async #reference(object: ObjectData): Promise<PaymentObjectReference | undefined> {
    const kinds: Record<string, PaymentObjectReference['kind']> = { payment_intent: 'charge', 'checkout.session': 'checkout',
      setup_intent: 'setup', payment_method: 'payment_method', refund: 'refund', dispute: 'dispute' };
    const kind = kinds[String(object.object)];
    if (kind) return { kind, id: id(object.id) };
    if (object.object === 'charge') {
      const charge = await this.#get(this.#path('charges', id(object.id)));
      if (charge.payment_intent) return { kind: 'charge', id: id(charge.payment_intent) };
    }
    return undefined;
  }
  async listChangesSince(since: Date, options: { cursor?: string; limit?: number } = {}): Promise<{ changes: readonly PaymentChange[]; nextCursor: string | null }> {
    assertNoTransaction('payments.listChangesSince');
    const limit = options.limit ?? 100, seconds = Math.floor(since.getTime() / 1000);
    if (!Number.isFinite(seconds) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid change page');
    // The cursor binds gym, lower/upper bounds, resource, and Stripe's last ID. Never use an offset into a moving list.
    type Cursor = { gym: string; since: number; until: number; resource: number; after?: string };
    let cursor: Cursor = { gym: this.gymId, since: seconds, until: Math.floor(this.#clock.now().getTime() / 1000), resource: 0 };
    if (options.cursor) {
      try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as Cursor; } catch { throw new Error('Invalid change cursor'); }
      if (cursor.gym !== this.gymId || cursor.since !== seconds || !Number.isInteger(cursor.until) || !Number.isInteger(cursor.resource)
        || cursor.resource < 0 || cursor.resource > 3 || (cursor.after !== undefined && !/^[A-Za-z0-9_]+$/.test(cursor.after))) throw new Error('Invalid change cursor');
    }
    const resources = ['events', 'payment_intents', 'refunds', 'disputes'];
    const changes: PaymentChange[] = [];
    while (cursor.resource < resources.length) {
      const resource = resources[cursor.resource]!;
      const page = await this.#get('/v1/' + resource, { created: { gte: seconds, lte: cursor.until }, limit: Math.min(limit - changes.length, 100),
        ...(cursor.after ? { starting_after: cursor.after } : {}) });
      const objects = (page.data as Json[]).map(data);
      for (const object of objects) {
        const source = resource === 'events' ? data(data(object.data).object) : object;
        let reference: PaymentObjectReference | undefined;
        try {
          reference = await this.#reference(source);
          if (!reference) continue;
          // Event payloads only identify an object. Its state is always fetched at our pinned version.
          const value = await this.#read(reference);
          changes.push({ ...value, changedAt: new Date(Number(object.created) * 1000) } as PaymentChange);
        } catch (error) {
          if (error instanceof NotForGym) continue;
          if (missing(error)) throw new Error('Unresolved payment object: ' + (reference?.kind ?? String(source.object))
            + ':' + (reference?.id ?? id(source.id)), { cause: error });
          throw error;
        }
      }
      if (page.has_more && !objects.length) throw new Error('Invalid Stripe page');
      cursor = page.has_more ? { ...cursor, after: id(objects.at(-1)!.id) }
        : { gym: cursor.gym, since: cursor.since, until: cursor.until, resource: cursor.resource + 1 };
      if (changes.length >= limit) break;
    }
    return { changes, nextCursor: cursor.resource < resources.length ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null };
  }
  async parseWebhook(body: Uint8Array, signature: string): Promise<PaymentEvent> {
    assertNoTransaction('payments.parseWebhook');
    let event: Stripe.Event, object: ObjectData;
    try {
      event = Stripe.webhooks.constructEvent(Buffer.from(body), signature, this.#secret, 300, this.#verifier, this.#clock.now().getTime());
      const timestamp = Number(signature.match(/(?:^|,)t=([0-9]+)(?:,|$)/)?.[1]);
      if (!Number.isFinite(timestamp) || Math.abs(this.#clock.now().getTime() / 1000 - timestamp) > 300
        || event.livemode !== (this.#mode === 'live') || event.object !== 'event'
        || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string' || !event.type)
        throw new Error('Invalid Stripe event envelope');
      object = data(event.data.object);
      if (typeof object.id !== 'string' || !/^[A-Za-z0-9_]+$/.test(object.id) || typeof object.object !== 'string')
        throw new Error('Invalid Stripe event object');
      data(object.metadata ?? {});
    } catch { throw new PaymentWebhookError('webhook_invalid'); }
    try {
      // Keep lookups outside payload validation: API errors, including real 404s, must be retried.
      const reference = await this.#reference(object);
      if (!reference) throw new PaymentWebhookError('webhook_not_for_gym');
      if (data(object.metadata ?? {}).gym_id) this.#metadata(object);
      else {
        try { await this.#read(reference); }
        catch (error) {
          // The method's customer was verified before its missing last four digits were discovered.
          if (!(error instanceof IncompleteBankMethod && reference.kind === 'payment_method'
            && ['payment_method.updated', 'payment_method.automatically_updated'].includes(event.type))) throw error;
        }
      }
      return { id: event.id, type: event.type, gymId: this.gymId, objectId: reference.id, objectKind: reference.kind };
    } catch (error) {
      if (error instanceof NotForGym) throw new PaymentWebhookError('webhook_not_for_gym');
      throw error;
    }
  }
}
