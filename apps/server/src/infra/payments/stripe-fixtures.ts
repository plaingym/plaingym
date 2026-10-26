// SPDX-License-Identifier: AGPL-3.0-only
import { isDeepStrictEqual } from 'node:util';
import type { ObjectData, PaymentTransport, ProviderRequest } from './transport.js';
/** Synthetic API fixtures, never represented as recordings of a real Stripe account. */
export class StripeFixtures implements PaymentTransport {
  readonly objects = new Map<string, ObjectData>();
  readonly requests: ProviderRequest[] = [];
  readonly #keys = new Map<string, { request: ProviderRequest; result: ObjectData }>();
  readonly #changes: ObjectData[] = [];
  #nextId = 0;
  constructor(readonly gymId: string, readonly now = 1792756800) {
    this.objects.set('cus_fixture', { id: 'cus_fixture', object: 'customer', email: 'payer@example.invalid', metadata: { gym_id: gymId } });
    for (const card of ['4242', '0341', '3155', '3184']) this.objects.set('pm_' + card, {
      id: 'pm_' + card, object: 'payment_method', created: now, customer: 'cus_fixture', card: { last4: card, exp_month: 12, exp_year: 2030 }, metadata: { gym_id: gymId },
    });
  }
  completeCheckout(sessionId: string): void {
    const session = this.objects.get(sessionId)!;
    if (session.status !== 'open') throw new Error('Checkout is not open');
    if (session.mode === 'payment') {
      const intent = this.objects.get(String(session.payment_intent))!;
      intent.status = 'succeeded'; intent.payment_method = 'pm_3155';
      if (!intent.setup_future_usage) intent.payment_method = this.#store('pm', { object: 'payment_method', customer: null,
        card: { last4: '3155', exp_month: 12, exp_year: 2030 } }).id;
      intent.latest_charge = this.#store('ch', { object: 'charge', payment_intent: intent.id, metadata: intent.metadata }).id;
    } else {
      const setup = this.objects.get(String(session.setup_intent))!;
      setup.status = 'succeeded'; setup.payment_method = 'pm_3155';
    }
    session.status = 'complete'; session.url = null;
  }
  async request(input: ProviderRequest): Promise<ObjectData> {
    this.requests.push(structuredClone(input));
    if (input.idempotencyKey) {
      const previous = this.#keys.get(input.idempotencyKey);
      if (previous) {
        if (!isDeepStrictEqual(previous.request, input)) throw Object.assign(new Error('Idempotency mismatch'), { type: 'StripeIdempotencyError' });
        return structuredClone(previous.result);
      }
    }
    const result = this.#execute(input);
    if (input.idempotencyKey) this.#keys.set(input.idempotencyKey, { request: structuredClone(input), result: structuredClone(result) });
    return structuredClone(result);
  }
  #store(prefix: string, object: ObjectData): ObjectData {
    const result = { id: prefix + '_' + ++this.#nextId, created: this.now, livemode: false, ...object };
    this.objects.set(String(result.id), result);
    this.#changes.push(result);
    return result;
  }
  #execute(input: ProviderRequest): ObjectData {
    const parts = input.path.slice(4).split('/');
    const resource = parts[0] === 'checkout' ? 'checkout/sessions' : parts[0]!;
    const objectId = parts[resource === 'checkout/sessions' ? 2 : 1];
    const action = parts[resource === 'checkout/sessions' ? 3 : 2];
    const params = input.params ?? {};
    if (input.method === 'GET' && !objectId) {
      const kind: Record<string, string> = { customers: 'customer', payment_intents: 'payment_intent', refunds: 'refund',
        disputes: 'dispute', charges: 'charge', setup_intents: 'setup_intent', payment_methods: 'payment_method', webhook_endpoints: 'webhook_endpoint', 'checkout/sessions': 'checkout.session' };
      let objects = resource === 'events' ? this.#changes.map((object, index) => ({ id: 'evt_' + index, object: 'event',
        created: this.now, data: { object: { id: object.id, object: object.object, status: 'stale_snapshot' } } }))
        : [...this.objects.values()].filter((object) => object.object === kind[resource]);
      if (params.email) objects = objects.filter((object) => object.email === params.email);
      if (resource === 'refunds' && params.payment_intent) objects = objects.filter(object =>
        (object.payment_intent ?? this.objects.get(String(object.charge))?.payment_intent) === params.payment_intent);
      const after = params.starting_after ? objects.findIndex((object) => object.id === params.starting_after) + 1 : 0;
      const limit = Number(params.limit ?? 100);
      return { data: objects.slice(after, after + limit), has_more: after + limit < objects.length };
    }
    if (objectId) {
      const object = this.objects.get(objectId);
      if (!object) throw Object.assign(new Error('No such object'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
      if (input.method === 'GET') return object;
      if (!action && resource === 'customers') {
        object.metadata = { ...object.metadata as ObjectData, ...params.metadata as ObjectData }; return object;
      }
      if (action === 'confirm') {
        if (object.status === 'canceled') throw new Error('Intent canceled');
        const card = String(object.payment_method).slice(-4);
        object.status = card === '0341' || card === '3184' ? 'requires_payment_method' : 'succeeded';
        if (card === '0341' || card === '3184') {
          object.last_payment_error = { code: card === '3184' ? 'authentication_required' : 'card_declined' };
          throw Object.assign(new Error('Card error'), { type: 'StripeCardError', code: (object.last_payment_error as ObjectData).code,
            payment_intent: structuredClone(object), statusCode: 402 });
        }
        object.latest_charge = this.#store('ch', { object: 'charge', payment_intent: object.id, metadata: object.metadata }).id;
        return object;
      }
      if (action === 'cancel') { object.status = 'canceled'; return object; }
      if (action === 'expire') {
        if (object.status !== 'open') throw new Error('Checkout not active');
        object.status = 'expired'; return object;
      }
      throw new Error('Unexpected mutation');
    }
    if (input.method !== 'POST') throw new Error('Unexpected request');
    if (resource === 'customers') return this.#store('cus', { object: 'customer', ...params });
    if (resource === 'payment_intents') return this.#store('pi', { object: 'payment_intent', ...params, status: 'requires_confirmation' });
    if (resource === 'checkout/sessions') {
      const mode = params.mode, metadata = (params[mode === 'payment' ? 'payment_intent_data' : 'setup_intent_data'] as ObjectData).metadata;
      const linked = this.#store(mode === 'payment' ? 'pi' : 'seti', { object: mode === 'payment' ? 'payment_intent' : 'setup_intent',
        customer: params.customer, metadata, status: 'requires_payment_method', payment_method: null, amount: 100, currency: 'usd',
        ...(mode === 'payment' ? { setup_future_usage: (params.payment_intent_data as ObjectData).setup_future_usage ?? null } : {}) });
      return this.#store('cs', { object: 'checkout.session', ...params, status: 'open', url: 'https://checkout.invalid/fixture',
        [mode === 'payment' ? 'payment_intent' : 'setup_intent']: linked.id });
    }
    if (resource === 'refunds') {
      if (!this.objects.has(String(params.payment_intent))) throw Object.assign(new Error('No intent'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
      return this.#store('re', { object: 'refund', ...params, currency: 'usd', status: 'succeeded' });
    }
    if (resource === 'webhook_endpoints') return this.#store('we', { object: 'webhook_endpoint', ...params, secret: 'fixture-signing-secret' });
    throw new Error('Unexpected fixture endpoint ' + input.path);
  }
}
