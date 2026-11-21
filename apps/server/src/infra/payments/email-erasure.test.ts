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
  await expect(payments.clearCustomerEmail(customerId, options)).rejects.toThrow('Stripe outage');
  expect(state()).toMatchObject({ email: null, cardEmail: 'payer@example.invalid' });
  transport.objects.get(customerId)!.email = 'replacement@example.invalid';
  fail = false;
  await payments.clearCustomerEmail(customerId, options);
  await payments.clearCustomerEmail(customerId, options);
  expect(state()).toMatchObject({ email: 'replacement@example.invalid', cardEmail: null, attached: true });
  expect(transport.requests.filter(request => request.method === 'POST').map(request => request.params))
    .toEqual([{ email: '' }, { billing_details: { email: '' } }]);
});

it('writes the placeholder email to a debit account that must keep one, leaving its name', async () => {
  const { payments, transport, state } = stripe();
  Object.assign(transport.objects.get(paymentMethodId)!, { type: 'acss_debit', acss_debit: { last4: '6789' } });
  expect(await payments.clearCustomerEmail(customerId, options)).toBe(true);
  expect(state()).toMatchObject({ email: null, cardEmail: 'erased-member@example.com', cardName: 'Card holder', attached: true });
  const posts = () => transport.requests.filter(request => request.method === 'POST');
  const before = posts().length;
  expect(await payments.clearCustomerEmail(customerId, options)).toBe(false);
  expect(posts()).toHaveLength(before);
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
