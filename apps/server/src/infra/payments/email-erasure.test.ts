// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { FakePayments, billingEmailDigest } from './index.js';
import { StripePayments } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';
import { customerEmailErasureContract, type EmailErasureFixture } from './payments.contract.js';
import { FixtureRecorder, replayPayments } from './recording.js';
import type { PaymentTransport } from './transport.js';

const gymId = '00000000-0000-7000-8000-000000000001', householdId = '00000000-0000-7000-8000-000000000002';
const customerId = 'cus_email', paymentMethodId = 'pm_email';
const options = { householdId, paymentMethodId, emailDigest: billingEmailDigest('payer@example.invalid') };
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
  await replayPayments(recorder.tape, gymId).clearCustomerEmail('cus_missing', options);
});
