// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { CardImportRefused, FakePayments } from './index.js';
import { StripePayments } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';
import { customerCardsContract } from './payments.contract.js';
import type { ObjectData, PaymentTransport } from './transport.js';
import { FixtureRecorder, replayPayments } from './recording.js';

const gymId = 'gym_cards', householdId = 'household_cards', customerId = 'cus_cards';
const ids = Array.from({ length: 102 }, (_, i) => 'pm_import_' + i);
function stripe(options: { gymId?: string; householdId?: string; deleted?: boolean } = {}) {
  const transport = new StripeFixtures(gymId);
  transport.objects.set(customerId, { id: customerId, object: 'customer', deleted: options.deleted ?? false,
    metadata: { ...(options.gymId === '' ? {} : { gym_id: options.gymId ?? gymId }), household_id: options.householdId ?? householdId } });
  for (const methodId of [...ids, 'pm_foreign', 'pm_detached']) transport.objects.set(methodId, { id: methodId, object: 'payment_method',
    created: transport.now, customer: methodId === 'pm_foreign' ? 'cus_foreign' : methodId === 'pm_detached' ? null : customerId,
    metadata: {}, type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2035 } });
  return { payments: new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' }), transport, customerId, householdId };
}
customerCardsContract('StripePayments', stripe);
customerCardsContract('FakePayments', options => {
  const payments = new FakePayments(gymId, new TestClock('2026-01-01T00:00:00Z'));
  payments.seedCustomer({ id: customerId, email: 'payer@example.invalid', gymId: options?.gymId ?? gymId,
    householdId: options?.householdId ?? householdId, deleted: options?.deleted ?? false });
  for (const methodId of [...ids, 'pm_foreign']) payments.recordPaymentMethod({ id: methodId,
    customerId: methodId === 'pm_foreign' ? 'cus_foreign' : customerId, last4: '4242', brand: 'visa', expiresMonth: 12, expiresYear: 2035 });
  return { payments, customerId, householdId };
});

it('records and replays card pages, provider dates and ownership refusals', async () => {
  const f = stripe(), recorder = new FixtureRecorder(gymId), recorded = recorder.wrap(f.payments);
  const page = await recorded.listCustomerCards(customerId, { householdId });
  await expect(recorded.listCustomerCards(customerId, { householdId: 'other' })).rejects.toBeInstanceOf(CardImportRefused);
  const replay = replayPayments(JSON.parse(JSON.stringify(recorder.tape)), gymId);
  expect(await replay.listCustomerCards(customerId, { householdId })).toEqual(page);
  await expect(replay.listCustomerCards(customerId, { householdId: 'other' })).rejects.toBeInstanceOf(CardImportRefused);
});

it('sends only customer-scoped card filters and never adopts or writes a customer', async () => {
  const f = stripe();
  const first = await f.payments.listCustomerCards(customerId, { householdId });
  await f.payments.listCustomerCards(customerId, { householdId, cursor: first.nextCursor! });
  expect(f.transport.requests.filter(request => request.path === '/v1/payment_methods').map(request => request.params)).toEqual([
    { customer: customerId, type: 'card', limit: 100 },
    { customer: customerId, type: 'card', limit: 100, starting_after: ids[99] },
  ]);
  expect(f.transport.requests.every(request => request.method === 'GET')).toBe(true);
});
it.each([
  { customer: 'cus_foreign' }, { metadata: { gym_id: 'other-gym' } },
])('refuses an inconsistent provider list: %j', async changed => {
  const f = stripe(), card = { ...f.transport.objects.get(ids[0]!)!, ...changed };
  const transport: PaymentTransport = { request: input => input.path === '/v1/payment_methods'
    ? Promise.resolve({ data: [card], has_more: false }) : f.transport.request(input) };
  await expect(new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' }).listCustomerCards(customerId, { householdId }))
    .rejects.toThrow('another customer or gym');
});
it.each([
  { data: [], has_more: true }, { data: null, has_more: false },
  { data: [], has_more: 'yes' },
])('fails closed on malformed pagination: %j', async page => {
  const f = stripe();
  const transport: PaymentTransport = { request: input => input.path === '/v1/payment_methods'
    ? Promise.resolve(page as ObjectData) : f.transport.request(input) };
  await expect(new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' }).listCustomerCards(customerId, { householdId })).rejects.toThrow('card');
});
