// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Clock } from '../../core/clock.js';
import type { Payments } from '../../infra/payments/index.js';
import { StripePayments, stripeTransport } from '../../infra/payments/stripe.js';
import type { PaymentTransport } from '../../infra/payments/transport.js';

export interface BillingSeedProvider {
  readonly gymId: string;
  readonly mode: 'test';
  readonly payments: Payments;
  /** Only Stripe's named test tokens are accepted; no card number ever enters the app. */
  seedCard(customerId: string, householdId: string, declined: boolean): Promise<string>;
}

/** Seed-only adapter over the payments transport. Customer creation stays in Payments.createCustomer. */
export function billingSeedPayments(options: {
  gymId: string; apiKey: string; webhookSecret: string; clock?: Clock; transport?: PaymentTransport;
}): BillingSeedProvider {
  if (!/^(rk|sk)_test_[A-Za-z0-9]+$/.test(options.apiKey)) throw new Error('Billing seed requires a Stripe test-mode key');
  const underlying = options.transport ?? stripeTransport(options.apiKey, { testOnly: true });
  const transport: PaymentTransport = { async request(input) {
    assertNoTransaction('payments.billingSeed');
    const result = await underlying.request(input);
    if (result.livemode === true) throw new Error('Billing seed refuses live Stripe objects');
    return result;
  } };
  const payments = new StripePayments(options.gymId, { transport, webhookSecret: options.webhookSecret,
    mode: 'test', ...(options.clock ? { clock: options.clock } : {}) });
  return { gymId: options.gymId, mode: 'test', payments, async seedCard(customerId, householdId, declined) {
    // Verify ownership before creating or attaching a method, including on a retried seed.
    await payments.adoptCustomer(customerId);
    const key = `household:${householdId}:demo-card`;
    const method = await transport.request({ method: 'POST', path: '/v1/payment_methods', idempotencyKey: key + ':create',
      params: { type: 'card', card: { token: declined ? 'tok_chargeCustomerFail' : 'tok_visa' },
        metadata: { gym_id: options.gymId, household_id: householdId } } });
    if (method.livemode !== false || typeof method.id !== 'string' || !/^pm_[A-Za-z0-9]+$/.test(method.id))
      throw new Error('Invalid test payment method');
    const attached = await transport.request({ method: 'POST', path: `/v1/payment_methods/${method.id}/attach`,
      params: { customer: customerId }, idempotencyKey: key + ':attach' });
    if (attached.livemode !== false || attached.id !== method.id || attached.customer !== customerId)
      throw new Error('Test card attachment is unresolved');
    return method.id;
  } };
}
