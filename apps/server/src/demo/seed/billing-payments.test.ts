// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { billingSeedPayments } from './billing-payments.js';
import { replayTransport, type ProviderRequest } from '../../infra/payments/transport.js';
import type { Tape } from '../../infra/payments/recording.js';

const gymId = '00000000-0000-7000-8000-000000000001', householdId = '00000000-0000-7000-8000-000000000002';
const options = { gymId, apiKey: 'rk_test_synthetic', webhookSecret: 'whsec_synthetic' };

it.each(['rk_live_forbidden', 'sk_live_forbidden', 'pk_test_public', '', ' rk_test_invalid'])(
  'rejects a non-test secret key before using the transport (%s)', apiKey => {
    const request = vi.fn();
    expect(() => billingSeedPayments({ ...options, apiKey, transport: { request } })).toThrow(/test-mode/);
    expect(request).not.toHaveBeenCalled();
  });

it.each([false, true])('uses Payments.createCustomer and a named test token, then reads an owned saved card (declined=%s)', async declined => {
  const metadata = { gym_id: gymId, household_id: householdId };
  const customer = { id: 'cus_fixture', email: 'demo@example.invalid', metadata, livemode: false };
  const card = { id: 'pm_fixture', customer: 'cus_fixture', metadata, livemode: false, created: 1793030400,
    card: { last4: declined ? '0341' : '4242', exp_month: 12, exp_year: 2030 } };
  const exchange = (input: ProviderRequest, output: unknown) => ({ operation: 'stripe', input, output });
  const key = `household:${householdId}:demo-card`;
  const tape: Tape = { version: 1, gymId, exchanges: [
    exchange({ method: 'POST', path: '/v1/customers', params: { email: customer.email, name: 'Demo household', metadata },
      idempotencyKey: 'customer-key' }, customer),
    exchange({ method: 'GET', path: '/v1/customers/cus_fixture' }, customer),
    exchange({ method: 'POST', path: '/v1/payment_methods', idempotencyKey: key + ':create', params: { type: 'card',
      card: { token: declined ? 'tok_chargeCustomerFail' : 'tok_visa' }, metadata } }, { ...card, customer: null }),
    exchange({ method: 'POST', path: '/v1/payment_methods/pm_fixture/attach', params: { customer: 'cus_fixture' },
      idempotencyKey: key + ':attach' }, card),
    exchange({ method: 'GET', path: '/v1/payment_methods/pm_fixture' }, card),
    exchange({ method: 'GET', path: '/v1/customers/cus_fixture' }, customer),
  ] };
  const transport = replayTransport(tape, gymId), provider = billingSeedPayments({ ...options, transport });
  const created = await provider.payments.createCustomer({ name: 'Demo household', email: customer.email, householdId, idempotencyKey: 'customer-key' });
  expect(created).toEqual({ id: customer.id, email: customer.email });
  const methodId = await provider.seedCard(created.id, householdId, declined);
  expect(await provider.payments.readPaymentObject({ kind: 'payment_method', id: methodId })).toMatchObject({
    status: 'found', value: { kind: 'payment_method', object: { customerId: customer.id, last4: card.card.last4, expiresYear: 2030 } },
  });
  transport.assertConsumed();
});

it('rejects a live object returned under a test key', async () => {
  const request = vi.fn(async () => ({ id: 'cus_live', livemode: true }));
  const provider = billingSeedPayments({ ...options, transport: { request } });
  await expect(provider.payments.createCustomer({ email: 'demo@example.invalid', name: 'Demo', householdId, idempotencyKey: 'demo' }))
    .rejects.toThrow(/live Stripe/);
});

it('refuses another gym customer before creating or attaching a card', async () => {
  const request = vi.fn(async () => ({ id: 'cus_foreign', livemode: false, metadata: { gym_id: 'another-gym' } }));
  const provider = billingSeedPayments({ ...options, transport: { request } });
  await expect(provider.seedCard('cus_foreign', householdId, false)).rejects.toThrow(/another gym/);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual([{ method: 'GET', path: '/v1/customers/cus_foreign' }]);
});

it('does not accept an attachment for a different customer', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ id: 'cus_fixture', livemode: false, metadata: { gym_id: gymId } })
    .mockResolvedValueOnce({ id: 'pm_fixture', livemode: false })
    .mockResolvedValueOnce({ id: 'pm_fixture', livemode: false, customer: 'cus_other' });
  const provider = billingSeedPayments({ ...options, transport: { request } });
  await expect(provider.seedCard('cus_fixture', householdId, false)).rejects.toThrow(/attachment is unresolved/);
});
