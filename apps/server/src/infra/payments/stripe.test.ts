// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { runInTransaction } from '@plaingym/shared/transaction';
import { CustomerCreationInProgress, FakePayments } from './index.js';
import { FixtureRecorder, replayPayments } from './recording.js';
import { recordingTransport, replayTransport, type PaymentTransport } from './transport.js';
import { StripePayments, STRIPE_API_VERSION, stripeTransport } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';
import { fullPaymentsContract, type Card } from './payments.contract.js';
import { stripeProvisioner, permissionProbes } from './setup.js';
import { webhookEndpointContract } from './webhook-endpoints.contract.js';
import { PaymentWebhookError } from './webhook-error.js';
import { TestClock } from '../../core/clock.js';
import type { Tape } from './recording.js';

const gymId = '00000000-0000-7000-8000-000000000001';
const detach = { owned: 'pm_4242', foreign: 'pm_foreign' };
const charge = { amount: 100, currency: 'usd', customerId: 'cus_fixture', paymentMethodId: 'pm_4242',
  invoiceId: 'invoice_fixture', attemptId: '1', idempotencyKey: 'invoice_fixture:1:create' };
const checkout = { mode: 'payment' as const, amount: 100, currency: 'usd', customerId: 'cus_fixture',
  successUrl: 'https://gym.invalid/success', cancelUrl: 'https://gym.invalid/cancel', saveForOffSession: true,
  idempotencyKey: 'checkout_fixture', invoiceId: 'invoice_fixture' };
it('serializes GET filters into the URL because SDK rawRequest only accepts POST bodies', async () => {
  const raw = vi.spyOn(Stripe.prototype, 'rawRequest').mockResolvedValue({ data: [], has_more: false });
  try {
    const transport = stripeTransport('rk_test_SYNTHETIC', { testOnly: true });
    await transport.request({ method: 'GET', path: '/v1/events', params: { limit: 10, created: { gte: 1, lte: 2 }, starting_after: 'evt_fixture' } });
    expect(raw).toHaveBeenLastCalledWith('GET', '/v1/events?limit=10&created%5Bgte%5D=1&created%5Blte%5D=2&starting_after=evt_fixture',
      undefined, { apiVersion: STRIPE_API_VERSION });
    const params = { amount: 100, allowed_payment_method_types: ['card'], metadata: { gym_id: gymId } };
    await transport.request({ method: 'POST', path: '/v1/payment_intents', params, idempotencyKey: 'create' });
    expect(raw).toHaveBeenLastCalledWith('POST', '/v1/payment_intents', params, { apiVersion: STRIPE_API_VERSION, idempotencyKey: 'create' });
  } finally { raw.mockRestore(); }
});
fullPaymentsContract('FakePayments', async (card = '4242') => {
  const payments = new FakePayments(gymId);
  payments.seedCustomer({ id: 'cus_fixture', email: 'payer@example.invalid' });
  payments.seedCustomer({ id: 'cus_foreign', email: 'foreign@example.invalid', gymId: 'other-gym' });
  for (const [id, customerId] of [[detach.owned, 'cus_fixture'], [detach.foreign, 'cus_foreign']] as const)
    payments.recordPaymentMethod({ id, customerId, brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
  payments.respondNextConfirmation(card === '0341' ? 'declined' : card === '3184' ? 'authentication_required' : 'succeeded');
  return { payments, charge, checkout, detach, completeCheckout: (id: string) => { payments.completeCheckout(id); } };
});
function fixture(card: Card = '4242') {
  const transport = new StripeFixtures(gymId), recorder = new FixtureRecorder(gymId);
  transport.objects.set('cus_foreign', { id: 'cus_foreign', object: 'customer', metadata: { gym_id: 'other-gym' } });
  transport.objects.set(detach.foreign, { id: detach.foreign, object: 'payment_method', customer: 'cus_foreign', metadata: {} });
  const payments = new StripePayments(gymId, { transport: recordingTransport(transport, recorder), webhookSecret: 'fixture-signing-secret',
    clock: new TestClock('2026-10-23T12:00:00Z') });
  return { payments, charge: { ...charge, paymentMethodId: 'pm_' + card }, checkout, detach, transport, recorder,
    completeCheckout: (id: string) => transport.completeCheckout(id), since: new Date('2026-10-23T00:00:00Z') };
}
const recordings = new Map<string, FixtureRecorder>();
const recordName = 'StripePayments with synthetic API fixtures', replayName = 'StripePayments with recorded API replay';
const caseName = () => expect.getState().currentTestName!.replace(recordName, '').replace(replayName, '').trim();
fullPaymentsContract(recordName, async (card) => {
  const harness = fixture(card); recordings.set(caseName(), harness.recorder); return harness;
});
const fixturePath = new URL('./stripe.synthetic.json', import.meta.url);
if (process.env.PAYMENTS_WRITE_SYNTHETIC_FIXTURES === '1') {
  afterAll(() => writeFile(fixturePath, JSON.stringify({ $comment: 'SPDX-License-Identifier: AGPL-3.0-only; synthetic API data, no real Stripe run',
    tapes: Object.fromEntries([...recordings].map(([name, recorder]) => [name, recorder.tape])) }, null, 2) + '\n'));
} else {
  const stored = JSON.parse(await readFile(fixturePath, 'utf8')) as { tapes: Record<string, Tape> };
  fullPaymentsContract(replayName, async (card = '4242') => {
    const tape = stored.tapes[caseName()];
    if (!tape) throw new Error('No recorded scenario: ' + caseName());
    return { payments: new StripePayments(gymId, { transport: replayTransport(tape, gymId), webhookSecret: 'fixture-signing-secret', clock: new TestClock('2026-10-23T12:00:00Z') }),
      charge: { ...charge, paymentMethodId: 'pm_' + card }, checkout, detach, since: new Date('2026-10-23T00:00:00Z') };
  });
}

it('replays a serialized transport recording through the actual Stripe adapter', async () => {
  const { payments, recorder } = fixture();
  const first = await payments.createCharge(charge);
  const confirmed = await payments.confirmCharge(first.id, { idempotencyKey: 'confirm' });
  const transport = replayTransport(JSON.parse(JSON.stringify(recorder.tape)), gymId);
  const replay = new StripePayments(gymId, { transport, webhookSecret: 'fixture-signing-secret' });
  expect(await replay.createCharge(charge)).toEqual(first);
  expect(await replay.confirmCharge(first.id, { idempotencyKey: 'confirm' })).toEqual(confirmed);
  transport.assertConsumed();
});
it('records and replays customer creation and typed in-flight conflicts at the Payments interface', async () => {
  const fake = new FakePayments(gymId), recorder = new FixtureRecorder(gymId), payments = recorder.wrap(fake);
  const request = { email: 'payer@example.invalid', name: 'Household', householdId: 'household_fixture', idempotencyKey: 'customer_fixture' };
  let release!: () => void;
  fake.holdNextCustomerCreation(new Promise<void>(resolve => { release = resolve; }));
  const first = payments.createCustomer(request);
  await expect(payments.createCustomer(request)).rejects.toBeInstanceOf(CustomerCreationInProgress);
  release();
  const customer = await first;
  expect(recorder.tape.exchanges.map(e => e.operation)).toEqual(['createCustomer', 'createCustomer']);
  const replay = replayPayments(JSON.parse(JSON.stringify(recorder.tape)), gymId);
  expect(await replay.createCustomer(request)).toEqual(customer);
  await expect(replay.createCustomer(request)).rejects.toBeInstanceOf(CustomerCreationInProgress);
});
it.each([
  [409, 'idempotency_key_in_use', true], [409, undefined, false],
  [400, 'idempotency_key_in_use', false], [400, 'parameter_invalid_empty', false], [400, 'idempotency_error', false],
] as const)('normalizes only an in-flight customer conflict (%s, %s)', async (statusCode, code, retryable) => {
  const { payments, transport } = fixture();
  const error = Object.assign(new Error('Provider failure'), { statusCode, code, type: 'StripeInvalidRequestError' });
  vi.spyOn(transport, 'request').mockRejectedValueOnce(error);
  const result = payments.createCustomer({ email: 'payer@example.invalid', name: 'Household', householdId: 'household_fixture', idempotencyKey: 'customer_fixture' });
  if (retryable) await expect(result).rejects.toMatchObject({ name: 'CustomerCreationInProgress', cause: error });
  else await expect(result).rejects.toBe(error);
});
it('tags all explicitly created objects and sends Endive parameters', async () => {
  const { payments, transport } = fixture();
  const customer = await payments.createCustomer({ email: 'new@example.invalid', name: 'New Household', householdId: 'household_fixture', idempotencyKey: 'customer_fixture' });
  expect(transport.objects.get(customer.id)?.metadata).toEqual({ gym_id: gymId, household_id: 'household_fixture' });
  await payments.createCheckout(checkout);
  await payments.createCheckout({ ...checkout, mode: 'setup', idempotencyKey: 'setup' });
  const intent = await payments.createCharge(charge);
  await payments.confirmCharge(intent.id, { idempotencyKey: 'confirm' });
  await payments.refund({ chargeId: intent.id, amount: 100, idempotencyKey: 'refund' });
  await stripeProvisioner(transport).register(gymId, 'https://gym.invalid', 1);
  const creates = transport.requests.filter((input) => input.method === 'POST' && !/\/(confirm|cancel|expire)$/.test(input.path));
  for (const input of creates) expect(input.params?.metadata).toMatchObject({ gym_id: gymId });
  expect(creates.find((input) => input.path === '/v1/payment_intents')?.params).toMatchObject({ confirm: false,
    allowed_payment_method_types: ['card'], metadata: { gym_id: gymId, invoice_id: charge.invoiceId, attempt_id: charge.attemptId, attempt_n: '1' } });
  const payment = creates.find((input) => input.path === '/v1/checkout/sessions');
  expect(payment?.params?.payment_intent_data).toMatchObject({ metadata: { gym_id: gymId }, setup_future_usage: 'off_session' });
  expect(payment?.params).not.toHaveProperty('payment_method_types');
  expect(payment?.params).not.toHaveProperty('expires_at');
  const expiresAt = new Date(Date.UTC(2026, 9, 29, 13, 0, 0));
  await payments.createCheckout({ ...checkout, idempotencyKey: 'short', expiresAt });
  const short = transport.requests.filter((input) => input.path === '/v1/checkout/sessions').at(-1);
  expect(short?.params?.expires_at).toBe(expiresAt.getTime() / 1000);
  expect(creates.find((input) => input.path === '/v1/webhook_endpoints')?.params?.api_version).toBe(STRIPE_API_VERSION);
  const enabled = creates.find((input) => input.path === '/v1/webhook_endpoints')?.params?.enabled_events;
  expect(enabled).toContain('payment_method.automatically_updated');
  expect(enabled).not.toContain('charge.dispute.funds_reinstated');
  expect(enabled).not.toContain('charge.dispute.funds_withdrawn');
});
it('reconciles untagged dashboard refunds and disputes through Charge -> PaymentIntent', async () => {
  const { payments, transport } = fixture(), intent = await payments.createCharge(charge);
  await payments.confirmCharge(intent.id, { idempotencyKey: 'confirm' });
  const chargeId = transport.objects.get(intent.id)!.latest_charge;
  transport.objects.set('re_dashboard', { id: 're_dashboard', object: 'refund', created: transport.now, charge: chargeId, amount: 10, currency: 'usd', status: 'succeeded', metadata: {} });
  transport.objects.set('dp_dashboard', { id: 'dp_dashboard', object: 'dispute', created: transport.now, charge: chargeId, amount: 100, status: 'needs_response', metadata: {} });
  expect(await payments.readPaymentObject({ kind: 'refund', id: 're_dashboard' })).toMatchObject({ status: 'found', value: { object: { chargeId: intent.id, metadata: { gymId } } } });
  expect(await payments.readPaymentObject({ kind: 'dispute', id: 'dp_dashboard' })).toMatchObject({ status: 'found', value: { object: { chargeId: intent.id, status: 'open' } } });
  const changes = await payments.listChangesSince(new Date('2026-10-01'));
  expect(changes.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'refund' }), expect.objectContaining({ kind: 'dispute' })]));
});
it('rejects foreign gym objects and mutates none of them', async () => {
  const { payments, transport } = fixture(), intent = await payments.createCharge(charge);
  transport.objects.get(intent.id)!.metadata = { gym_id: 'other' };
  expect(await payments.findCharge({ kind: 'charge', id: intent.id })).toMatchObject({ status: 'unknown' });
  expect(await payments.readPaymentObject({ kind: 'charge', id: intent.id })).toMatchObject({ status: 'unknown' });
  await expect(payments.confirmCharge(intent.id, { idempotencyKey: 'confirm' })).rejects.toThrow('another gym');
  expect((await payments.listChangesSince(new Date('2026-10-01'))).changes).toEqual([]);
  expect(transport.requests.filter((input) => input.path.endsWith('/confirm'))).toEqual([]);
});
it.each(['charge', 'refund', 'dispute', 'setup', 'payment_method', 'checkout'] as const)(
  'skips an untagged %s and its untagged parents while retaining tagged changes on the same pages', async (kind) => {
    const { transport, payments: writer, since } = fixture(), intent = await writer.createCharge(charge);
    transport.objects.set('cus_dashboard', { id: 'cus_dashboard', object: 'customer', metadata: {} });
    transport.objects.set('pi_dashboard', { id: 'pi_dashboard', object: 'payment_intent', metadata: {},
      customer: 'cus_dashboard', amount: 100, currency: 'usd', status: 'succeeded' });
    transport.objects.set('ch_dashboard', { id: 'ch_dashboard', object: 'charge', payment_intent: 'pi_dashboard', metadata: {} });
    const sources = {
      charge: { id: 'pi_dashboard', object: 'payment_intent' },
      refund: { id: 're_dashboard', object: 'refund', charge: 'ch_dashboard' },
      dispute: { id: 'dp_dashboard', object: 'dispute', charge: 'ch_dashboard' },
      setup: { id: 'seti_dashboard', object: 'setup_intent', customer: 'cus_dashboard' },
      payment_method: { id: 'pm_dashboard', object: 'payment_method', customer: 'cus_dashboard' },
      checkout: { id: 'cs_dashboard', object: 'checkout.session' },
    };
    const source = { ...sources[kind], metadata: {}, created: transport.now };
    if (kind !== 'charge') transport.objects.set(source.id, source);
    const payments = new StripePayments(gymId, { webhookSecret: 'unused', clock: new TestClock('2026-10-23T12:00:00Z'),
      transport: { async request(input) {
        if (input.path === '/v1/events') return { has_more: false, data: [source, { id: intent.id, object: 'payment_intent' }]
          .map((object, index) => ({ id: 'evt_mixed_' + index, created: transport.now, data: { object } })) };
        return transport.request(input);
      } } });
    const changes = await payments.listChangesSince(since);
    expect(changes.nextCursor).toBeNull();
    expect(changes.changes.length).toBeGreaterThan(0);
    expect(changes.changes.every((change) => change.kind === 'charge' && change.object.status !== 'unknown' && change.object.id === intent.id)).toBe(true);
    expect(await payments.readPaymentObject({ kind, id: source.id })).toEqual({ status: 'unknown', reference: { kind, id: source.id } });
    expect(await payments.findCharge({ kind: 'charge', id: 'pi_dashboard' })).toMatchObject({ status: 'unknown' });
  });
it('skips legacy dashboard charges without a parent intent instead of fabricating a missing resource', async () => {
  const { payments, transport, since } = fixture(), intent = await payments.createCharge(charge);
  transport.objects.set('ch_legacy', { id: 'ch_legacy', object: 'charge', metadata: {}, payment_intent: null });
  transport.objects.set('re_legacy', { id: 're_legacy', object: 'refund', charge: 'ch_legacy', metadata: {} });
  expect((await payments.listChangesSince(since)).changes).toEqual([expect.objectContaining({ kind: 'charge', object: expect.objectContaining({ id: intent.id }) }),
    expect.objectContaining({ kind: 'charge', object: expect.objectContaining({ id: intent.id }) })]);
});
it.each(['payment_intent', 'charge'])('stops reconciliation on a genuinely missing %s with its reference and preserves other API errors', async (kind) => {
  const { transport, since } = fixture();
  const objectId = kind === 'payment_intent' ? 'pi_missing' : 'ch_missing';
  const payments = new StripePayments(gymId, { webhookSecret: 'unused', transport: { async request(input) {
    if (input.path === '/v1/events') return { has_more: false,
      data: [{ id: 'evt_missing', created: transport.now, data: { object: { id: objectId, object: kind } } }] };
    return transport.request(input);
  } } });
  await expect(payments.listChangesSince(since)).rejects.toThrow('Unresolved payment object: charge:' + objectId);
  const denied = Object.assign(new Error('Permission denied'), { statusCode: 403 });
  const unavailable = new StripePayments(gymId, { webhookSecret: 'unused', transport: { async request() { throw denied; } } });
  await expect(unavailable.listChangesSince(since)).rejects.toBe(denied);
});
it('keeps unknown network outcomes unknown and normalizes SCA in returned intents too', async () => {
  const { payments, transport } = fixture(), intent = await payments.createCharge(charge);
  transport.objects.get(intent.id)!.status = 'requires_payment_method';
  transport.objects.get(intent.id)!.last_payment_error = { code: 'authentication_required' };
  expect(await payments.findCharge({ kind: 'charge', id: intent.id })).toMatchObject({ status: 'action_required' });
  const unavailable = new StripePayments(gymId, { transport: { async request() { throw new Error('Network lost'); } }, webhookSecret: 'fixture' });
  await expect(unavailable.findCharge({ kind: 'charge', id: intent.id })).rejects.toThrow('Network lost');
  expect(await unavailable.expireCheckout('cs_unknown')).toEqual({ status: 'uncertain' });
});
it('reports complete and raced Checkout expiry and retains the explicit saved method', async () => {
  for (const mode of ['payment', 'setup'] as const) {
    const { payments, transport } = fixture(), session = await payments.createCheckout({ ...checkout, mode });
    transport.completeCheckout(session.id);
    expect(await payments.expireCheckout(session.id)).toMatchObject({ status: 'already_completed', session: { paymentMethodId: 'pm_3155' } });
    expect(await payments.readPaymentObject({ kind: 'checkout', id: session.id })).toMatchObject({ status: 'found', value: { object: { paymentMethodId: 'pm_3155' } } });
  }
  const { transport } = fixture();
  const raced: PaymentTransport = { async request(input) {
    if (input.path.endsWith('/expire')) { transport.completeCheckout(input.path.split('/').at(-2)!); throw new Error('Already complete'); }
    return transport.request(input);
  } };
  const payments = new StripePayments(gymId, { transport: raced, webhookSecret: 'fixture' });
  const session = await payments.createCheckout(checkout);
  expect(await payments.expireCheckout(session.id)).toMatchObject({ status: 'already_completed' });
});
it('keeps an on-session Checkout decline open while reporting its failed payment', async () => {
  const { payments, transport } = fixture(), session = await payments.createCheckout(checkout);
  const intent = transport.objects.get(session.chargeId!)!;
  intent.status = 'requires_payment_method'; intent.last_payment_error = { code: 'card_declined' };
  expect(await payments.findCharge({ kind: 'checkout', id: session.id })).toMatchObject({ status: 'failed', code: 'declined' });
  expect(await payments.readPaymentObject({ kind: 'checkout', id: session.id })).toMatchObject({ status: 'found', value: { object: { status: 'open' } } });
});
it('verifies the untouched raw body, timestamp, and gym before returning an inbox event', async () => {
  const { payments } = fixture();
  const body = Buffer.from(JSON.stringify({ id: 'evt_fixture', object: 'event', created: 1, livemode: false,
    type: 'payment_intent.succeeded', data: { object: { id: 'pi_fixture', object: 'payment_intent', metadata: { gym_id: gymId } } } }, null, 2));
  const timestamp = Math.floor(new Date('2026-10-23T12:00:00Z').getTime() / 1000);
  const sign = (time: number) => 't=' + time + ',v1=' + createHmac('sha256', 'fixture-signing-secret').update(time + '.').update(body).digest('hex');
  expect(await payments.parseWebhook(body, sign(timestamp))).toMatchObject({ gymId, objectId: 'pi_fixture', objectKind: 'charge' });
  await expect(payments.parseWebhook(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), sign(timestamp))).rejects.toMatchObject({ code: 'webhook_invalid' });
  await expect(payments.parseWebhook(body, sign(timestamp - 600))).rejects.toMatchObject({ code: 'webhook_invalid' });
  await expect(payments.parseWebhook(body, sign(timestamp + 600))).rejects.toMatchObject({ code: 'webhook_invalid' });
  await expect(payments.parseWebhook(body, 'invalid')).rejects.toBeInstanceOf(PaymentWebhookError);
  await expect(payments.parseWebhook(body, 'invalid')).rejects.toMatchObject({ code: 'webhook_invalid' });
});
function signedEvent(object: unknown, overrides = {}) {
  const body = Buffer.from(JSON.stringify({ id: 'evt_fixture', object: 'event', livemode: false,
    type: 'payment_intent.succeeded', data: { object }, ...overrides }));
  const timestamp = Math.floor(new Date('2026-10-23T12:00:00Z').getTime() / 1000);
  const signature = 't=' + timestamp + ',v1=' + createHmac('sha256', 'fixture-signing-secret').update(timestamp + '.').update(body).digest('hex');
  return [body, signature] as const;
}
it.each(['untagged', 'foreign', 'refund', 'dispute', 'payment_method', 'setup'])(
  'reports webhook_not_for_gym for a valid signed %s object', async (scenario) => {
    const { payments, transport } = fixture(), intent = await payments.createCharge(charge);
    const object = transport.objects.get(intent.id)!;
    object.metadata = scenario === 'foreign' ? { gym_id: 'other' } : {};
    const child = scenario === 'refund' ? { id: 're_unrelated', object: 'refund', payment_intent: intent.id }
      : scenario === 'dispute' ? { id: 'dp_unrelated', object: 'dispute', payment_intent: intent.id }
        : scenario === 'payment_method' ? { id: 'pm_unrelated', object: 'payment_method', customer: 'cus_unrelated' }
          : scenario === 'setup' ? { id: 'seti_unrelated', object: 'setup_intent', customer: null } : object;
    if (child !== object) transport.objects.set(String(child.id), child);
    transport.objects.set('cus_unrelated', { id: 'cus_unrelated', metadata: {} });
    await expect(payments.parseWebhook(...signedEvent(child))).rejects.toMatchObject({ code: 'webhook_not_for_gym' });
  });
it('routes signed untagged refunds through a tagged parent and saved methods through their tagged customer', async () => {
  const { payments, transport } = fixture(), intent = await payments.createCharge(charge);
  const refund = { id: 're_dashboard', object: 'refund', metadata: {}, payment_intent: intent.id, amount: 100, currency: 'usd' };
  transport.objects.set(refund.id, refund);
  expect(await payments.parseWebhook(...signedEvent(refund))).toMatchObject({ objectKind: 'refund', objectId: refund.id, gymId });
  const method = transport.objects.get('pm_4242')!; method.metadata = {};
  expect(await payments.parseWebhook(...signedEvent(method))).toMatchObject({ objectKind: 'payment_method', objectId: method.id, gymId });
});
it.each([{ livemode: true }, { data: null }, { id: null }, { type: null }, { object: 'not_an_event' }])(
  'reports webhook_invalid for signed malformed or mode-mismatched events: %j', async (overrides) => {
    const { payments } = fixture();
    await expect(payments.parseWebhook(...signedEvent({ id: 'pi_fixture', object: 'payment_intent' }, overrides)))
      .rejects.toMatchObject({ code: 'webhook_invalid' });
  });
it('reports webhook_invalid for signed malformed JSON or object payloads', async () => {
  const { payments } = fixture();
  for (const object of [null, [], { object: 'payment_intent' }, { id: 'pi_fixture' }, { id: 'pi_fixture', object: 'payment_intent', metadata: [] }])
    await expect(payments.parseWebhook(...signedEvent(object))).rejects.toMatchObject({ code: 'webhook_invalid' });
  const body = Buffer.from('{');
  const timestamp = Math.floor(new Date('2026-10-23T12:00:00Z').getTime() / 1000);
  const signature = 't=' + timestamp + ',v1=' + createHmac('sha256', 'fixture-signing-secret').update(timestamp + '.').update(body).digest('hex');
  await expect(payments.parseWebhook(body, signature)).rejects.toMatchObject({ code: 'webhook_invalid' });
});
it.each([
  new Error('Network unavailable'),
  Object.assign(new Error('Permission denied'), { statusCode: 403 }),
  Object.assign(new Error('No such parent'), { statusCode: 404, code: 'resource_missing' }),
])('preserves webhook parent-lookup failures for inbox retries: %s', async (error) => {
  const refund = { id: 're_fixture', object: 'refund', payment_intent: 'pi_parent' };
  const payments = new StripePayments(gymId, { clock: new TestClock('2026-10-23T12:00:00Z'), webhookSecret: 'fixture-signing-secret',
    transport: { async request(input) { if (input.path === '/v1/refunds/re_fixture') return refund; throw error; } } });
  await expect(payments.parseWebhook(...signedEvent(refund))).rejects.toBe(error);
});
it('validates every permission including Setup Intents, Events and Disputes, and refuses incomplete profiles', async () => {
  for (const denied of ['Setup Intents', 'Events', 'Disputes', 'Charges and Refunds']) {
    const transport = new StripeFixtures(gymId), observed: string[] = [];
    const restricted: PaymentTransport = { async request(input) {
      const resource = permissionProbes.find((probe) => probe.request.path === input.path && probe.request.method === input.method)!.resource;
      observed.push(resource);
      if (resource === denied) throw Object.assign(new Error('Permission denied'), { type: 'StripePermissionError', statusCode: 403 });
      return transport.request(input);
    } };
    await expect(stripeProvisioner(restricted).validate()).rejects.toThrow(denied);
    expect(observed).toContain(denied);
  }
  await stripeProvisioner(new StripeFixtures(gymId)).validate();
});
it('adopts an imported customer once, so charges and email matching accept it, and refuses customers of other gyms', async () => {
  const { payments, transport } = fixture();
  transport.objects.set('cus_imported', { id: 'cus_imported', object: 'customer', email: 'imported@example.invalid', metadata: { legacy_id: '42' } });
  transport.objects.set('pm_imported', { id: 'pm_imported', object: 'payment_method', customer: 'cus_imported', card: { last4: '4242', exp_month: 12, exp_year: 2030 } });
  const imported = { ...charge, customerId: 'cus_imported', paymentMethodId: 'pm_imported', idempotencyKey: 'invoice_imported:1:create' };
  await expect(payments.createCharge(imported)).rejects.toThrow('no gym metadata');
  expect(await payments.findCustomerByEmail('imported@example.invalid')).toEqual([]);
  expect(await payments.adoptCustomer('cus_imported')).toEqual({ id: 'cus_imported', email: 'imported@example.invalid' });
  expect(transport.objects.get('cus_imported')!.metadata).toEqual({ legacy_id: '42', gym_id: gymId });
  const writes = transport.requests.filter((request) => request.method === 'POST').length;
  await payments.adoptCustomer('cus_imported');
  expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(writes);
  expect(await payments.findCustomerByEmail('imported@example.invalid')).toEqual([{ id: 'cus_imported', email: 'imported@example.invalid' }]);
  await expect(payments.createCharge(imported)).resolves.toMatchObject({ id: expect.stringMatching(/^pi_/) });
  transport.objects.set('cus_foreign', { id: 'cus_foreign', object: 'customer', email: null, metadata: { gym_id: '00000000-0000-7000-8000-000000000002' } });
  await expect(payments.adoptCustomer('cus_foreign')).rejects.toThrow('another gym');
  transport.objects.set('cus_deleted', { id: 'cus_deleted', object: 'customer', deleted: true });
  await expect(payments.adoptCustomer('cus_deleted')).rejects.toThrow('deleted');
  await expect(payments.adoptCustomer('cus_missing')).rejects.toThrow();
  await expect(payments.adoptCustomer('../cus_fixture')).rejects.toThrow('Invalid processor ID');
});
it.each(['concurrent', 'lost_response', 'missing', 'permission', 'failure'] as const)('handles detach %s without hiding a failed removal', async outcome => {
  const { payments, transport } = fixture();
  const request = transport.request.bind(transport);
  vi.spyOn(transport, 'request').mockImplementation(async input => {
    if (!input.path.endsWith('/detach')) return request(input);
    if (outcome === 'concurrent' || outcome === 'lost_response') {
      await request(input);
      throw Object.assign(new Error('Detach response unavailable'), { statusCode: outcome === 'concurrent' ? 400 : 500 });
    }
    if (outcome === 'missing') throw Object.assign(new Error('Missing'), { code: 'resource_missing', statusCode: 400 });
    throw Object.assign(new Error('Detach failed'), { statusCode: outcome === 'permission' ? 403 : 500 });
  });
  const removal = payments.detachPaymentMethod('pm_4242');
  if (outcome === 'permission') await expect(removal).rejects.toThrow('Check the Stripe permission for Payment Methods');
  else if (outcome === 'failure') await expect(removal).rejects.toThrow('Detach failed');
  else await expect(removal).resolves.toBeUndefined();
  expect(transport.requests.filter(input => input.path.endsWith('/detach'))).toHaveLength(['concurrent', 'lost_response'].includes(outcome) ? 1 : 0);
});
it('redacts only an owned customer, keeping its metadata, and treats deleted or missing customers as done', async () => {
  const { payments, transport } = fixture();
  transport.objects.set('cus_erased', { id: 'cus_erased', object: 'customer', name: 'Pat Payer', email: 'pat@example.invalid',
    metadata: { gym_id: gymId, household_id: 'household_fixture' } });
  await payments.redactCustomer('cus_erased');
  expect(transport.objects.get('cus_erased')).toMatchObject({ name: 'Erased member', email: null,
    metadata: { gym_id: gymId, household_id: 'household_fixture' } });
  expect(transport.requests.filter((request) => request.method === 'POST')).toEqual([{ method: 'POST', path: '/v1/customers/cus_erased',
    params: { name: 'Erased member', email: '' }, idempotencyKey: 'customer:cus_erased:redact' }]);
  // A finished redaction is not written again.
  await payments.redactCustomer('cus_erased');
  expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  transport.objects.set('cus_foreign', { id: 'cus_foreign', object: 'customer', name: 'Other', email: 'other@example.invalid', metadata: { gym_id: 'other' } });
  transport.objects.set('cus_untagged', { id: 'cus_untagged', object: 'customer', name: 'Dashboard', email: 'dash@example.invalid', metadata: {} });
  await expect(payments.redactCustomer('cus_foreign')).rejects.toThrow('another gym');
  await expect(payments.redactCustomer('cus_untagged')).rejects.toThrow('no gym metadata');
  transport.objects.set('cus_deleted', { id: 'cus_deleted', object: 'customer', deleted: true });
  await expect(payments.redactCustomer('cus_deleted')).resolves.toBeUndefined();
  await expect(payments.redactCustomer('cus_missing')).resolves.toBeUndefined();
  await expect(payments.redactCustomer('../cus_fixture')).rejects.toThrow('Invalid processor ID');
  expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  expect(transport.objects.get('cus_foreign')).toMatchObject({ name: 'Other', email: 'other@example.invalid' });
});
it('redacts a fake customer like the provider and refuses another gym', async () => {
  const payments = new FakePayments(gymId);
  payments.seedCustomer({ id: 'cus_seeded', email: 'seeded@example.invalid' });
  payments.seedCustomer({ id: 'cus_other', email: 'other@example.invalid', gymId: 'other-gym' });
  await payments.redactCustomer('cus_seeded');
  expect(payments.customer('cus_seeded')).toEqual({ name: 'Erased member', email: null });
  await expect(payments.redactCustomer('cus_other')).rejects.toThrow('another gym');
  expect(payments.customer('cus_other')).toEqual({ name: null, email: 'other@example.invalid' });
  await expect(payments.redactCustomer('cus_missing')).resolves.toBeUndefined();
  await runInTransaction(async () => { await expect(payments.redactCustomer('cus_seeded')).rejects.toThrow('transaction'); });
});
it('blocks all provider operations inside a database transaction before any request', async () => {
  const { payments, transport } = fixture();
  await runInTransaction(async () => {
    const calls = [() => payments.createCustomer({ email: 'payer@example.invalid', name: 'Household', householdId: 'household_fixture', idempotencyKey: 'customer' }),
      () => payments.createCharge(charge), () => payments.confirmCharge('pi_fixture', { idempotencyKey: 'confirm' }),
      () => payments.cancelCharge('pi_fixture'), () => payments.findCharge({ kind: 'charge', id: 'pi_fixture' }),
      () => payments.readPaymentObject({ kind: 'setup', id: 'seti_fixture' }), () => payments.listChangesSince(new Date()),
      () => payments.listRefunds('pi_fixture'),
      () => payments.refund({ chargeId: 'pi_fixture', amount: 1, idempotencyKey: 'refund' }), () => payments.createCheckout(checkout),
      () => payments.expireCheckout('cs_fixture'), () => payments.findCustomerByEmail('payer@example.invalid'),
      () => payments.adoptCustomer('cus_fixture'), () => payments.detachPaymentMethod('pm_4242'), () => payments.redactCustomer('cus_fixture'),
      () => payments.parseWebhook(new Uint8Array(), '')];
    for (const call of calls) await expect(call()).rejects.toThrow('transaction');
  });
  expect(transport.requests).toEqual([]);
  expect(() => stripeTransport('sk_live_SYNTHETIC', { testOnly: true })).toThrow('test-mode');
});

// Explicit opt-in only. Regular/offline runs never inspect credentials or make network calls.
if (process.env.STRIPE_CONTRACT_MODE === 'test-api') {
  const apiKey = process.env.STRIPE_TEST_RESTRICTED_KEY;
  if (!apiKey || !/^rk_test_[A-Za-z0-9]+$/.test(apiKey)) throw new Error('Provide STRIPE_TEST_RESTRICTED_KEY (rk_test_ only)');
  const fixturesPath = process.env.STRIPE_CONTRACT_FIXTURES;
  if (!fixturesPath) throw new Error('Provide STRIPE_CONTRACT_FIXTURES; see infra/payments/README.md');
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8')) as { gymId: string; customerId: string; methods: Record<Card, string>; detach: { owned: string; foreign: string } };
  if (!fixtures.detach?.owned || !fixtures.detach.foreign) throw new Error('Provide dedicated owned and foreign detach fixtures');
  const recordings: FixtureRecorder[] = [];
  fullPaymentsContract('Stripe test API', async (card = '4242') => {
    const run = randomUUID(), recorder = new FixtureRecorder(fixtures.gymId); recordings.push(recorder);
    const payments = new StripePayments(fixtures.gymId, { transport: recordingTransport(stripeTransport(apiKey, { testOnly: true }), recorder), webhookSecret: 'unused' });
    return { payments, charge: { ...charge, customerId: fixtures.customerId, paymentMethodId: fixtures.methods[card], invoiceId: run, idempotencyKey: run + ':1:create' },
      checkout: { ...checkout, customerId: fixtures.customerId, idempotencyKey: run + ':checkout' }, detach: fixtures.detach };
  });
  it('checks the full restricted-key profile against the test API', () => stripeProvisioner(stripeTransport(apiKey, { testOnly: true })).validate());
  it('registers a tagged test endpoint at the pinned API version', async () => {
    const recorder = new FixtureRecorder(fixtures.gymId); recordings.push(recorder);
    const provisioner = stripeProvisioner(recordingTransport(stripeTransport(apiKey, { testOnly: true }), recorder));
    const endpoint = await provisioner.register(fixtures.gymId, 'https://stripe-contract.invalid', new Date().getTime());
    expect(endpoint.endpointId).toMatch(/^we_/);
    expect(endpoint.webhookSecret).toMatch(/^whsec_/);
    console.log('Created test webhook endpoint: ' + endpoint.endpointId);
  });
  // Reuse, update, cleanup and removal run against a throwaway origin; every endpoint they create is deleted afterward.
  webhookEndpointContract('Stripe test API', () => {
    const recorder = new FixtureRecorder(fixtures.gymId); recordings.push(recorder);
    return { transport: recordingTransport(stripeTransport(apiKey, { testOnly: true }), recorder), gymId: fixtures.gymId,
      origin: 'https://r17-' + randomUUID() + '.invalid', base: Date.now() };
  });
  afterAll(async () => {
    if (process.env.STRIPE_RECORDING_OUTPUT) await writeFile(process.env.STRIPE_RECORDING_OUTPUT,
      JSON.stringify(recordings.map((recorder) => recorder.tape), null, 2), { mode: 0o600 });
  });
}
