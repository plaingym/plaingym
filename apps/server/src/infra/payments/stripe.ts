// SPDX-License-Identifier: AGPL-3.0-only
import Stripe from 'stripe';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
import { CustomerCreationInProgress, normalizeChargeOutcome, type Payments, type CreateCustomer, type CreateCharge, type CheckoutRequest,
  type CheckoutSession, type CheckoutExpiry, type ChargeReference, type ChargeOutcome, type PaymentMetadata,
  type PaymentObjectReference, type PaymentObjectResult, type PaymentObject, type PaymentChange,
  type PaymentEvent, type Refund } from './index.js';
import type { Json, ObjectData, PaymentTransport, ProviderRequest } from './transport.js';
import { PaymentWebhookError } from './webhook-error.js';

export const STRIPE_API_VERSION = '2026-09-30.endive' as const;
export const STRIPE_PERMISSIONS = [
  ['Customers', 'Write'], ['Payment Intents', 'Write'], ['Checkout Sessions', 'Write'],
  ['Setup Intents', 'Read'], ['Payment Methods', 'Write'], ['Charges and Refunds', 'Write'], ['Webhook Endpoints', 'Write'],
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
function money(amount: number | undefined, currency: string | undefined): void {
  if (!Number.isSafeInteger(amount) || !amount || amount < 1 || !currency || !/^(usd|cad)$/.test(currency))
    throw new Error('Expected positive integer cents in usd or cad');
}
function key(value: string): void { if (!value || value.length > 200) throw new Error('Invalid idempotency key'); }
function timestamp(value: Json | undefined): Date {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid provider timestamp');
  return new Date(value * 1000);
}
class NotForGym extends Error {}
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
    return normalizeChargeOutcome({ id: id(object.id), amount: Number(object.amount), currency: String(object.currency),
      customerId: id(object.customer), ...(object.payment_method ? { paymentMethodId: id(object.payment_method) } : {}),
      ...(object.latest_charge ? { latestChargeId: id(object.latest_charge) } : {}),
      metadata: this.#metadata(object), status: String(object.status),
      ...(object.last_payment_error ? { last_payment_error: data(object.last_payment_error) as { code?: string } } : {}) }, error);
  }
  async #ownedIntent(objectId: string): Promise<ObjectData> {
    const intent = await this.#get(this.#path('payment_intents', objectId)); this.#metadata(intent); return intent;
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
    await this.#ownedCustomer(request.customerId);
    const method = await this.#get(this.#path('payment_methods', request.paymentMethodId));
    if (optionalId(method.customer) !== request.customerId) throw new Error('Payment method is not attached to payer');
    const result = await this.#post('/v1/payment_intents', { amount: request.amount, currency: request.currency,
      customer: request.customerId, payment_method: request.paymentMethodId, allowed_payment_method_types: ['card'], confirm: false,
      metadata: { gym_id: this.gymId, invoice_id: request.invoiceId, attempt_id: request.attemptId,
        ...(request.idempotencyKey.match(/:([0-9]+):create$/)?.[1] ? { attempt_n: request.idempotencyKey.match(/:([0-9]+):create$/)![1]! } : {}) } }, request.idempotencyKey);
    this.#metadata(result); return { id: id(result.id) };
  }
  async confirmCharge(objectId: string, options: { idempotencyKey: string }): Promise<ChargeOutcome> {
    assertNoTransaction('payments.confirmCharge'); key(options.idempotencyKey);
    const before = await this.#ownedIntent(objectId);
    if (before.status === 'succeeded' || before.status === 'canceled') return this.#intent(before);
    try { return this.#intent(await this.#post(this.#path('payment_intents', objectId) + '/confirm',
      { off_session: true }, options.idempotencyKey)); }
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
      if (before.status === 'succeeded' || before.status === 'canceled') return this.#intent(before);
      try { return this.#intent(await this.#post(this.#path('payment_intents', objectId) + '/cancel', {})); }
      catch (error) {
        const after = await this.#ownedIntent(objectId);
        if (after.status === 'succeeded' || after.status === 'canceled') return this.#intent(after);
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
    // Opt in so existing caller request sequences remain unchanged. A missing Charge is retryable,
    // never an unknown intent and never permission to substitute the processing clock.
    if (options?.includeSuccessTime && outcome.status === 'succeeded') {
      if (!outcome.latestChargeId) throw new Error('Successful payment requires its processor Charge ID');
      const charge = await this.#get(this.#path('charges', outcome.latestChargeId));
      if (id(charge.payment_intent) !== outcome.id) throw new Error('Successful Charge parent mismatch');
      return { ...outcome, succeededAt: timestamp(charge.created) };
    }
    return outcome;
  }
  async #checkout(object: ObjectData): Promise<CheckoutSession> {
    const metadata = this.#metadata(object), chargeId = optionalId(object.payment_intent), setupId = optionalId(object.setup_intent);
    let paymentMethodId: string | undefined, savesCard = object.mode === 'setup';
    if (chargeId) {
      const intent = await this.#ownedIntent(chargeId);
      paymentMethodId = optionalId(intent.payment_method);
      savesCard = intent.setup_future_usage === 'off_session' || intent.setup_future_usage === 'on_session';
    }
    if (setupId) {
      const setup = await this.#get(this.#path('setup_intents', setupId)); this.#metadata(setup);
      paymentMethodId = optionalId(setup.payment_method);
    }
    if (!['open', 'complete', 'expired'].includes(String(object.status)) || !['setup', 'payment'].includes(String(object.mode)))
      throw new Error('Invalid Checkout state');
    return { id: id(object.id), mode: object.mode as 'payment' | 'setup', url: String(object.url ?? ''),
      status: object.status as CheckoutSession['status'], customerId: id(object.customer), metadata, savesCard,
      ...(chargeId ? { chargeId } : {}), ...(setupId ? { setupId } : {}), ...(paymentMethodId ? { paymentMethodId } : {}) };
  }
  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    assertNoTransaction('payments.createCheckout'); key(request.idempotencyKey);
    if (request.mode === 'payment') money(request.amount, request.currency);
    for (const url of [request.successUrl, request.cancelUrl]) if (new URL(url).protocol !== 'https:') throw new Error('Checkout return URLs require HTTPS');
    let customer = request.customerId;
    if (customer) await this.#ownedCustomer(customer);
    else {
      const matches = await this.findCustomerByEmail(request.customerEmail!);
      if (matches.length > 1) throw new Error('Ambiguous payer email');
      customer = matches[0]?.id;
      if (!customer) customer = id((await this.#post('/v1/customers', {
        email: request.customerEmail!, metadata: { gym_id: this.gymId },
      }, request.idempotencyKey + ':customer')).id);
    }
    const metadata = { gym_id: this.gymId, ...(request.invoiceId ? { invoice_id: request.invoiceId } : {}),
      ...(request.linkId ? { link_id: request.linkId } : {}) };
    const params: ObjectData = { mode: request.mode, customer, success_url: request.successUrl, cancel_url: request.cancelUrl,
      allowed_payment_method_types: ['card'], metadata,
      ...(request.mode === 'payment' ? { payment_intent_data: { metadata,
        ...(request.saveForOffSession ? { setup_future_usage: 'off_session' } : {}) },
      line_items: [{ quantity: 1, price_data: { currency: request.currency!, unit_amount: request.amount!,
        product_data: { name: 'Invoice payment', metadata } } }] }
      : { setup_intent_data: { metadata } }) };
    return this.#checkout(await this.#post('/v1/checkout/sessions', params, request.idempotencyKey));
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
    return { id: id(object.id), chargeId: id(parent.id), amount: Number(object.amount), currency: String(object.currency),
      status: object.status === 'succeeded' ? 'succeeded' : object.status === 'pending' || object.status === 'requires_action' ? 'pending' : 'failed',
      metadata: this.#metadata(parent) };
  }
  async refund(request: { chargeId: string; amount: number; idempotencyKey: string }): Promise<Refund> {
    assertNoTransaction('payments.refund'); key(request.idempotencyKey);
    const parent = await this.#ownedIntent(request.chargeId); money(request.amount, String(parent.currency));
    if (parent.status !== 'succeeded') throw new Error('Only successful charges can be refunded');
    return this.#refund(await this.#post('/v1/refunds', { payment_intent: request.chargeId, amount: request.amount,
      metadata: { gym_id: this.gymId, ...(data(parent.metadata).invoice_id ? { invoice_id: data(parent.metadata).invoice_id } : {}) } }, request.idempotencyKey));
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
    catch (error) { if (missing(error) || error instanceof NotForGym) return { status: 'unknown', reference }; throw error; }
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
          status: object.status === 'succeeded' ? 'succeeded' : object.status === 'requires_action' ? 'action_required'
            : object.status === 'canceled' || (object.status === 'requires_payment_method' && object.last_setup_error) ? 'failed' : 'pending',
          ...(object.payment_method ? { paymentMethodId: id(object.payment_method) } : {}) } }; break;
      }
      case 'payment_method': {
        const object = await this.#get(this.#path('payment_methods', reference.id));
        if (data(object.metadata ?? {}).gym_id) this.#metadata(object);
        if (!object.customer) throw new NotForGym('Payment method has no customer');
        await this.#ownedCustomer(id(object.customer));
        const card = data(object.card);
        value = { kind: 'payment_method', object: { id: id(object.id), createdAt: timestamp(object.created), customerId: id(object.customer), last4: String(card.last4),
          expiresMonth: Number(card.exp_month), expiresYear: Number(card.exp_year) } }; break;
      }
    }
    return value;
  }
  async detachPaymentMethod(processorId: string): Promise<void> {
    assertNoTransaction('payments.detachPaymentMethod');
    const path = this.#path('payment_methods', processorId);
    const absent = (error: unknown) => {
      const value = error as { code?: string; statusCode?: number } | null;
      return value?.code === 'resource_missing' && [400, 404].includes(value.statusCode ?? 0);
    };
    let method: ObjectData;
    try { method = await this.#get(path); }
    catch (error) { if (absent(error)) return; throw error; }
    if (data(method.metadata ?? {}).gym_id) this.#metadata(method);
    if (!method.customer) return;
    await this.#ownedCustomer(id(method.customer));
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
  async adoptCustomer(customerId: string): Promise<{ id: string; email: string | null }> {
    assertNoTransaction('payments.adoptCustomer');
    const path = this.#path('customers', customerId), customer = await this.#get(path);
    if (customer.deleted === true) throw new Error('Customer was deleted');
    const owner = data(customer.metadata ?? {}).gym_id;
    if (owner !== undefined && owner !== this.gymId) throw new NotForGym('Payment object belongs to another gym');
    // Metadata updates merge, so the customer's other keys stay.
    if (owner === undefined) await this.#post(path, { metadata: { gym_id: this.gymId } }, 'customer:' + customerId + ':adopt');
    return { id: id(customer.id), email: typeof customer.email === 'string' ? customer.email : null };
  }
  async findCustomerByEmail(email: string): Promise<readonly { id: string; email: string }[]> {
    assertNoTransaction('payments.findCustomerByEmail');
    const matches: { id: string; email: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#get('/v1/customers', { email, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      const objects = (page.data as Json[]).map(data);
      for (const object of objects) if (data(object.metadata ?? {}).gym_id === this.gymId)
        matches.push({ id: id(object.id), email: String(object.email) });
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
      else await this.#read(reference);
      return { id: event.id, type: event.type, gymId: this.gymId, objectId: reference.id, objectKind: reference.kind };
    } catch (error) {
      if (error instanceof NotForGym) throw new PaymentWebhookError('webhook_not_for_gym');
      throw error;
    }
  }
}
