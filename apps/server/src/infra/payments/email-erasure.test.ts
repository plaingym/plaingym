// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FakePayments, billingEmailDigest } from './index.js';
import { StripePayments } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';
import { customerEmailErasureContract, type EmailErasureFixture } from './payments.contract.js';
import { FixtureRecorder, replayPayments } from './recording.js';
import type { PaymentTransport } from './transport.js';

const gymId = '00000000-0000-7000-8000-000000000001', householdId = '00000000-0000-7000-8000-000000000002';
const customerId = 'cus_email', paymentMethodId = 'pm_email';
const secret = 'fixture-email-erasure-secret';
const options = { householdId, paymentMethodId, secret, emailDigest: billingEmailDigest('payer@example.invalid', secret) };

it('keys and normalizes the digest using a distinct derived key', () => {
  const digest = billingEmailDigest(' PAYER@Example.invalid ', secret);
  expect(digest).toBe(options.emailDigest);
  expect(digest).toMatch(/^k1:[a-f0-9]{64}$/);
  expect(digest).not.toContain(createHash('sha256').update('payer@example.invalid').digest('hex'));
  expect(digest).not.toBe(billingEmailDigest('payer@example.invalid', 'another-fixture-secret'));
  expect(() => billingEmailDigest('payer@example.invalid', '')).toThrow('secret');
});
function stripe(fixture: EmailErasureFixture = {}) {
  const transport = new StripeFixtures(gymId);
  transport.objects.set(customerId, { id: customerId, object: 'customer', name: 'Household', email: fixture.customerEmail ?? 'payer@example.invalid',
    deleted: fixture.deleted ?? false, metadata: { gym_id: fixture.gymId ?? gymId, household_id: fixture.householdId ?? householdId } });
  transport.objects.set(paymentMethodId, { id: paymentMethodId, object: 'payment_method', customer: fixture.cardCustomerId ?? customerId,
    metadata: { gym_id: gymId }, billing_details: { email: fixture.cardEmail ?? 'payer@example.invalid', name: 'Card holder' } });
  const payments = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
  return { payments, customerId, options, transport, state: () => {
    const customer = transport.objects.get(customerId)!, card = transport.objects.get(paymentMethodId)!, billing = card.billing_details as { email: string | null; name: string };
    return { email: customer.email as string | null, name: customer.name as string, cardEmail: billing.email, cardName: billing.name, attached: !!card.customer };
  } };
}
customerEmailErasureContract('StripePayments', stripe);
customerEmailErasureContract('FakePayments', (fixture = {}) => {
  const payments = new FakePayments(gymId);
  payments.seedCustomer({ id: customerId, name: 'Household', email: fixture.customerEmail ?? 'payer@example.invalid',
    householdId: fixture.householdId ?? householdId, gymId: fixture.gymId ?? gymId, ...(fixture.deleted ? { deleted: true } : {}) });
  payments.recordPaymentMethod({ id: paymentMethodId, customerId: fixture.cardCustomerId ?? customerId, brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
  payments.setBillingDetails(paymentMethodId, { email: fixture.cardEmail ?? 'payer@example.invalid', name: 'Card holder' });
  return { payments, customerId, options, state: () => ({ email: payments.customer(customerId)!.email, name: payments.customer(customerId)!.name,
    cardEmail: payments.billingDetails(paymentMethodId)!.email!, cardName: payments.billingDetails(paymentMethodId)!.name!, attached: true }) };
});

it('retries a partially cleared customer after an outage without clearing a replacement email', async () => {
  const { transport, state } = stripe();
  let fail = true;
  const failing: PaymentTransport = { async request(request) {
    if (request.method === 'POST' && request.path === '/v1/payment_methods/' + paymentMethodId && fail) throw new Error('Stripe outage');
    return transport.request(request);
  } };
  const payments = new StripePayments(gymId, { transport: failing, webhookSecret: 'fixture-secret' });
  // The card's failure is reported, not thrown: the caller retries.
  expect(await payments.clearCustomerEmail(customerId, options)).toEqual({ matched: true, placeholderMethods: [], failedMethods: [paymentMethodId] });
  expect(state()).toMatchObject({ email: null, cardEmail: 'payer@example.invalid' });
  transport.objects.get(customerId)!.email = 'replacement@example.invalid';
  fail = false;
  await payments.clearCustomerEmail(customerId, options);
  await payments.clearCustomerEmail(customerId, options);
  expect(state()).toMatchObject({ email: 'replacement@example.invalid', cardEmail: null, attached: true });
  expect(transport.requests.filter(request => request.method === 'POST').map(request => request.params))
    .toEqual([{ email: '' }, { billing_details: { email: '' } }]);
});

/** `stripe()` with `pm_email` as a debit account and an extra `card` method `pm_card`, both holding `email`. */
function debitStripe(email = 'payer@example.invalid') {
  const provider = stripe({ customerEmail: email, cardEmail: email });
  Object.assign(provider.transport.objects.get(paymentMethodId)!, { type: 'acss_debit', acss_debit: { last4: '6789' } });
  provider.transport.objects.set('pm_card', { id: 'pm_card', object: 'payment_method', type: 'card', customer: customerId, metadata: { gym_id: gymId },
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, billing_details: { email, name: 'Card holder' } });
  const posts = () => provider.transport.requests.filter(request => request.method === 'POST');
  const card = () => provider.transport.objects.get('pm_card')!.billing_details;
  return { ...provider, posts, card, options: { ...options, paymentMethodId: undefined, paymentMethodIds: [paymentMethodId, 'pm_card'],
    emailDigest: billingEmailDigest(email, secret) } };
}

it('writes the placeholder email to a debit account that must keep one, leaving its name, and reports it', async () => {
  const { payments, state, posts, card, options: debitOptions } = debitStripe();
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: true, placeholderMethods: [paymentMethodId], failedMethods: [] });
  expect(state()).toMatchObject({ email: null, cardEmail: 'erased-member@example.com', cardName: 'Card holder', attached: true });
  expect(card()).toEqual({ email: null, name: 'Card holder' });
  const before = posts().length;
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: false, placeholderMethods: [paymentMethodId], failedMethods: [] });
  expect(posts()).toHaveLength(before);
});

it('treats the placeholder as cleared when the erased address normalizes to it', async () => {
  const { payments, state, posts, options: debitOptions } = debitStripe(' Erased-Member@Example.com ');
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: true, placeholderMethods: [paymentMethodId], failedMethods: [] });
  expect(state()).toMatchObject({ email: null, cardEmail: 'erased-member@example.com', cardName: 'Card holder' });
  const before = posts().length;
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: false, placeholderMethods: [paymentMethodId], failedMethods: [] });
  expect(posts()).toHaveLength(before);
});

it('reports no placeholder or failed methods from FakePayments', async () => {
  const payments = new FakePayments(gymId);
  payments.seedCustomer({ id: customerId, email: 'payer@example.invalid', householdId, gymId });
  expect(await payments.clearCustomerEmail(customerId, options)).toEqual({ matched: true, placeholderMethods: [], failedMethods: [] });
});

/** Two debit accounts `pm_a` and `pm_b` on the customer, both holding the erased payer's email; `fail` decides which writes fail. */
function twoDebits(fail: (path: string) => number | undefined) {
  const transport = new StripeFixtures(gymId);
  transport.objects.set(customerId, { id: customerId, object: 'customer', name: 'Household', email: 'payer@example.invalid',
    metadata: { gym_id: gymId, household_id: householdId } });
  for (const methodId of ['pm_a', 'pm_b'])
    transport.objects.set(methodId, { id: methodId, object: 'payment_method', type: 'acss_debit', acss_debit: { last4: '6789' }, customer: customerId,
      metadata: { gym_id: gymId }, billing_details: { email: 'payer@example.invalid', name: 'Account holder' } });
  const failing: PaymentTransport = { async request(request) {
    const statusCode = request.method === 'POST' ? fail(request.path) : undefined;
    if (statusCode !== undefined) throw Object.assign(new Error('Stripe refused'), { statusCode });
    return transport.request(request);
  } };
  const payments = new StripePayments(gymId, { transport: failing, webhookSecret: 'fixture-secret' });
  const writes = (methodId: string) => transport.requests.filter(request => request.method === 'POST' && request.path === `/v1/payment_methods/${methodId}`);
  const email = (methodId: string) => (transport.objects.get(methodId)!.billing_details as { email: string | null }).email;
  return { payments, transport, writes, email,
    options: { ...options, paymentMethodId: undefined, paymentMethodIds: ['pm_a', 'pm_b'] } };
}

it('keeps going past a method whose write fails, reporting it and the debit account it cleared', async () => {
  const { payments, writes, email, options: debitOptions } = twoDebits(path => path === '/v1/payment_methods/pm_b' ? 500 : undefined);
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: true, placeholderMethods: ['pm_a'], failedMethods: ['pm_b'] });
  expect(email('pm_a')).toBe('erased-member@example.com');
  expect(email('pm_b')).toBe('payer@example.invalid');
  const before = writes('pm_a').length;
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: false, placeholderMethods: ['pm_a'], failedMethods: ['pm_b'] });
  expect(writes('pm_a')).toHaveLength(before);
});

it('writes no further method after a 403, reporting every method left', async () => {
  const { payments, transport, email, options: debitOptions } = twoDebits(path => path === '/v1/payment_methods/pm_a' ? 403 : undefined);
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: true, placeholderMethods: [], failedMethods: ['pm_a', 'pm_b'] });
  expect(transport.requests.filter(request => request.method === 'POST' && request.path.startsWith('/v1/payment_methods/'))).toEqual([]);
  expect(email('pm_b')).toBe('payer@example.invalid');
});

it.each([401, 403])('reports a later debit account already holding the placeholder after a %s', async status => {
  const attemptedWrites: string[] = [];
  const { payments, transport, options: debitOptions } = twoDebits(path => {
    attemptedWrites.push(path);
    return path === '/v1/payment_methods/pm_a' ? status : undefined;
  });
  transport.objects.get('pm_b')!.billing_details = { name: 'Account holder', email: 'erased-member@example.com' };
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({
    matched: true, placeholderMethods: ['pm_b'], failedMethods: ['pm_a', 'pm_b'],
  });
  expect(attemptedWrites).toEqual([`/v1/customers/${customerId}`, '/v1/payment_methods/pm_a']);
});

it('lists only a debit account holding the placeholder, never a card that holds the same address', async () => {
  const { payments, transport, posts, card, options: debitOptions } = debitStripe();
  // An earlier attempt left the placeholder on the debit account; the card held the address before this erasure.
  (transport.objects.get(paymentMethodId)!.billing_details as { email: string }).email = 'erased-member@example.com';
  (transport.objects.get('pm_card')!.billing_details as { email: string }).email = 'erased-member@example.com';
  expect(await payments.clearCustomerEmail(customerId, debitOptions)).toEqual({ matched: true, placeholderMethods: [paymentMethodId], failedMethods: [] });
  expect(posts().map(request => request.path)).toEqual([`/v1/customers/${customerId}`]);
  expect(card()).toEqual({ email: 'erased-member@example.com', name: 'Card holder' });
});

it('accepts an untagged customer and leaves an already detached card alone', async () => {
  const { payments, transport, state } = stripe();
  transport.objects.get(customerId)!.metadata = {};
  transport.objects.get(paymentMethodId)!.customer = null;
  await payments.clearCustomerEmail(customerId, options);
  expect(state()).toMatchObject({ email: null, cardEmail: 'payer@example.invalid', attached: false });
});

it('records and replays the new payments operation', async () => {
  const recorder = new FixtureRecorder(gymId), payments = recorder.wrap(new FakePayments(gymId));
  await payments.clearCustomerEmail('cus_missing', options);
  expect(recorder.tape.exchanges).toHaveLength(1);
  expect(JSON.stringify(recorder.tape)).not.toContain(secret);
  await replayPayments(recorder.tape, gymId).clearCustomerEmail('cus_missing', options);
});

it.each(['StripePayments', 'FakePayments'])('clears matching emails on every specified card with %s', async name => {
  const fake = new FakePayments(gymId), provider = stripe(), payments = name === 'StripePayments' ? provider.payments : fake;
  fake.seedCustomer({ id: customerId, email: 'payer@example.invalid', householdId });
  const ids = ['pm_one', 'pm_two', 'pm_replacement'];
  for (const methodId of ids) {
    const email = methodId === 'pm_replacement' ? 'replacement@example.invalid' : 'payer@example.invalid';
    provider.transport.objects.set(methodId, { id: methodId, object: 'payment_method', created: provider.transport.now, customer: customerId,
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, billing_details: { email, name: 'Card holder' } });
    fake.recordPaymentMethod({ id: methodId, customerId, brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
    fake.setBillingDetails(methodId, { email, name: 'Card holder' });
  }
  await payments.clearCustomerEmail(customerId, { ...options, paymentMethodId: undefined, paymentMethodIds: ids });
  for (const methodId of ids) {
    const details = name === 'StripePayments' ? provider.transport.objects.get(methodId)!.billing_details : fake.billingDetails(methodId);
    expect(details).toEqual({ name: 'Card holder', email: methodId === 'pm_replacement' ? 'replacement@example.invalid' : null });
    expect(await payments.readPaymentObject({ kind: 'payment_method', id: methodId })).toMatchObject({ status: 'found' });
  }
});
