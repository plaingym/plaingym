// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { FakePayments } from './index.js';
import { StripePayments } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';
import { customerCardRedactionContract } from './payments.contract.js';
import type { ObjectData, PaymentTransport } from './transport.js';

const gymId = 'gym_cards', customerId = 'cus_cards';
const details = { name: 'Card holder', email: 'payer@example.invalid', phone: '+15555550100', address: { line1: '1 Mat Road' } };
const ids = Array.from({ length: 104 }, (_, i) => 'pm_redact_' + i);
function stripe() {
  const transport = new StripeFixtures(gymId);
  transport.objects.set(customerId, { id: customerId, object: 'customer', name: 'Household', metadata: { gym_id: gymId } });
  for (const [i, methodId] of ids.entries()) transport.objects.set(methodId, { id: methodId, object: 'payment_method', created: transport.now,
    customer: i === 103 ? null : i === 102 ? 'cus_foreign' : customerId, billing_details: structuredClone(details), type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
  const payments = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
  return { payments, transport, customerId, cards: () => ids.map(methodId => {
    const card = transport.objects.get(methodId)!;
    return { id: methodId, attached: !!card.customer, details: card.billing_details as typeof details };
  }) };
}
customerCardRedactionContract('StripePayments', stripe);
customerCardRedactionContract('FakePayments', async () => {
  const payments = new FakePayments(gymId);
  payments.seedCustomer({ id: customerId, email: 'payer@example.invalid' });
  for (const [i, methodId] of ids.entries()) {
    payments.recordPaymentMethod({ id: methodId, customerId: i === 102 ? 'cus_foreign' : customerId,
      brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
    payments.setBillingDetails(methodId, structuredClone(details));
  }
  await payments.detachPaymentMethod(ids[103]!);
  // The detached fixture holds its details, as a prior staff removal would leave them.
  return { payments, customerId, cards: () => ids.map((methodId, i) => ({ id: methodId, attached: i !== 103,
    details: payments.billingDetails(methodId) ?? {} })) };
});

it('pages past 100 attached cards and avoids repeating cleared writes', async () => {
  const { payments, transport } = stripe();
  await payments.redactCustomer(customerId);
  const pages = transport.requests.filter(request => request.path === '/v1/payment_methods');
  expect(pages.map(page => page.params)).toEqual([
    { customer: customerId, type: 'card', limit: 100 },
    { customer: customerId, type: 'card', limit: 100, starting_after: ids[99] },
  ]);
  const writes = () => transport.requests.filter(request => request.method === 'POST');
  const before = writes().length;
  await payments.redactCustomer(customerId);
  expect(writes()).toHaveLength(before);
  expect(writes().filter(request => request.path.startsWith('/v1/payment_methods/'))).toHaveLength(102);
});

it.each([403, 500])('propagates a card clear failure and resumes all cards on retry (%s)', async statusCode => {
  const fixture = stripe();
  let fail = true;
  const transport: PaymentTransport = { async request(input) {
    if (fail && input.method === 'POST' && input.path.endsWith('/' + ids[1]))
      throw Object.assign(new Error('Stripe outage'), { statusCode });
    return fixture.transport.request(input);
  } };
  const payments = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
  await expect(payments.redactCustomer(customerId)).rejects.toThrow(statusCode === 403 ? 'Payment Methods' : 'Stripe outage');
  fail = false;
  await payments.redactCustomer(customerId);
  expect(fixture.cards().slice(0, 102).every(card => Object.values(card.details).every(value => value == null))).toBe(true);
});

it('refuses a foreign card returned by an inconsistent provider list', async () => {
  const fixture = stripe();
  const transport: PaymentTransport = { async request(input) {
    if (input.path === '/v1/payment_methods') return { data: [fixture.transport.objects.get(ids[102]!) as ObjectData], has_more: false };
    return fixture.transport.request(input);
  } };
  await expect(new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' }).redactCustomer(customerId)).rejects.toThrow('another customer');
  expect(fixture.cards()[102]!.details).toEqual(details);
});
