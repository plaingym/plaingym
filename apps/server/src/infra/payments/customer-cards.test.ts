// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { CardCursorRefused, CardImportRefused, FakePayments } from './index.js';
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

it('reads an untagged Canadian bank account only for import, and requires an active reusable mandate', async () => {
  const f = stripe();
  const customer = f.transport.objects.get(customerId)!, processorId = 'pm_pad';
  customer.metadata = {};
  f.transport.objects.set(processorId, { id: processorId, object: 'payment_method', customer: customerId,
    type: 'acss_debit', created: f.transport.now, acss_debit: { last4: '1234', bank_name: 'Test bank' } });
  const setup = { id: 'seti_pad', object: 'setup_intent', customer: customerId, payment_method: processorId,
    status: 'succeeded', usage: 'off_session', mandate: 'mandate_pad' };
  const mandate = { id: 'mandate_pad', object: 'mandate', payment_method: processorId, type: 'multi_use', status: 'inactive' };
  f.transport.objects.set(setup.id, setup);
  f.transport.objects.set(mandate.id, mandate);
  const reference = { kind: 'payment_method', id: processorId } as const;
  expect(await f.payments.readPaymentObject(reference)).toEqual({ status: 'unknown', reference });
  const unchargeable = await f.payments.readBankAccountForImport(processorId, true);
  expect(unchargeable).toMatchObject({ status: 'found', method: { customerId, last4: '1234' } });
  expect(unchargeable).not.toHaveProperty('method.mandateId');
  mandate.status = 'active';
  const recorder = new FixtureRecorder(gymId);
  const chargeable = await recorder.wrap(f.payments).readBankAccountForImport(processorId, true);
  expect(chargeable).toMatchObject({ status: 'found', method: { mandateId: mandate.id } });
  expect(await replayPayments(recorder.tape, gymId).readBankAccountForImport(processorId, true)).toEqual(chargeable);
  expect(f.transport.requests).toContainEqual({ path: '/v1/setup_intents', method: 'GET', params: {
    customer: customerId, payment_method: processorId, limit: 100,
  } });
  expect(f.transport.requests).toContainEqual({ path: '/v1/mandates/' + mandate.id, method: 'GET' });
  expect(customer.metadata).toEqual({});
  customer.metadata = { gym_id: gymId, household_id: householdId };
  expect(await f.payments.listCustomerCards(customerId, { householdId, types: ['acss_debit'], includeMandates: true }))
    .toMatchObject({ cards: [{ id: processorId, mandateId: mandate.id }] });
  customer.metadata = { gym_id: 'other-gym' };
  expect(await f.payments.readBankAccountForImport(processorId, true)).toEqual({ status: 'unavailable' });
  expect(f.transport.requests.every(request => request.method === 'GET')).toBe(true);
});
it.each([
  { statusCode: 400, code: 'resource_missing' },
  { statusCode: 400, param: 'starting_after' },
  { statusCode: 404, raw: { param: 'starting_after' } },
])('classifies refused Stripe continuation cursors: %j', async failure => {
  const f = stripe();
  const transport: PaymentTransport = { request: input => input.path === '/v1/payment_methods'
    ? Promise.reject(Object.assign(new Error('Cursor missing'), failure)) : f.transport.request(input) };
  const payments = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
  await expect(payments.listCustomerCards(customerId, { householdId, cursor: ids[0]! })).rejects.toBeInstanceOf(CardCursorRefused);
  await expect(payments.listCustomerCards(customerId, { householdId })).rejects.not.toBeInstanceOf(CardCursorRefused);
});
it.each([{ statusCode: 500 }, { statusCode: 403 }, { statusCode: 400, param: 'customer', code: 'resource_missing' }])('does not classify other provider errors as cursor refusals: %j', async failure => {
  const f = stripe(), error = Object.assign(new Error('Provider unavailable'), failure);
  const transport: PaymentTransport = { request: input => input.path === '/v1/payment_methods'
    ? Promise.reject(error) : f.transport.request(input) };
  await expect(new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' })
    .listCustomerCards(customerId, { householdId, cursor: ids[0]! })).rejects.toBe(error);
});
it('records and replays the typed fake cursor refusal', async () => {
  const payments = new FakePayments(gymId, new TestClock('2026-01-01T00:00:00Z'));
  payments.seedCustomer({ id: customerId, email: 'payer@example.invalid', householdId });
  const recorder = new FixtureRecorder(gymId), recorded = recorder.wrap(payments);
  await expect(recorded.listCustomerCards(customerId, { householdId, cursor: 'pm_missing' })).rejects.toBeInstanceOf(CardCursorRefused);
  await expect(replayPayments(recorder.tape, gymId).listCustomerCards(customerId, { householdId, cursor: 'pm_missing' })).rejects.toBeInstanceOf(CardCursorRefused);
});
function listing(changed: ObjectData) {
  const f = stripe(), card = { ...f.transport.objects.get(ids[0]!)!, ...changed };
  const transport: PaymentTransport = { request: input => input.path === '/v1/payment_methods'
    ? Promise.resolve({ data: [card], has_more: false }) : f.transport.request(input) };
  return new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
}
it('refuses an inconsistent provider list', async () => {
  await expect(listing({ customer: 'cus_foreign' }).listCustomerCards(customerId, { householdId })).rejects.toThrow('another customer or gym');
});
it.each([
  { metadata: { gym_id: 'other-gym' } }, { metadata: { household_id: 'other-household' } },
])('reports a listed method tagged elsewhere and leaves it out: %j', async changed => {
  expect(await listing(changed).listCustomerCards(customerId, { householdId }))
    .toEqual({ cards: [], nextCursor: null, skippedForeign: [{ id: ids[0], type: 'card' }] });
});
it('keeps a continuation cursor on a skipped method and records and replays the page', async () => {
  const f = stripe();
  f.transport.objects.get(ids[99]!)!.metadata = { gym_id: 'other-gym' };
  const recorder = new FixtureRecorder(gymId), recorded = recorder.wrap(f.payments);
  const page = await recorded.listCustomerCards(customerId, { householdId });
  expect(page).toMatchObject({ nextCursor: ids[99], skippedForeign: [{ id: ids[99], type: 'card' }] });
  expect(page.cards).toHaveLength(99);
  expect(page.cards.map(card => card.id)).not.toContain(ids[99]);
  expect(await replayPayments(JSON.parse(JSON.stringify(recorder.tape)), gymId).listCustomerCards(customerId, { householdId })).toEqual(page);
});
it('reports a fake method recorded for another gym and leaves it out', async () => {
  const payments = new FakePayments(gymId, new TestClock('2026-01-01T00:00:00Z'));
  payments.seedCustomer({ id: customerId, email: 'payer@example.invalid', householdId });
  payments.recordPaymentMethod({ id: 'pm_own', customerId, last4: '4242', brand: 'visa', expiresMonth: 12, expiresYear: 2035,
    createdAt: new Date('2026-01-02T00:00:00Z') });
  payments.recordPaymentMethod({ id: 'pm_other_gym', customerId, last4: '4242', brand: 'visa', expiresMonth: 12, expiresYear: 2035,
    gymId: 'other-gym' });
  payments.recordPaymentMethod({ id: 'pm_other_bank', customerId, type: 'us_bank_account', last4: '6789', gymId: 'other-gym' });
  const page = await payments.listCustomerCards(customerId, { householdId });
  expect(page).toMatchObject({ cards: [{ id: 'pm_own' }], nextCursor: null, skippedForeign: [{ id: 'pm_other_gym', type: 'card' }] });
  expect(page.cards).toHaveLength(1);
  expect((await payments.listCustomerCards(customerId, { householdId, types: ['card', 'us_bank_account'] })).skippedForeign)
    .toEqual(expect.arrayContaining([{ id: 'pm_other_gym', type: 'card' }, { id: 'pm_other_bank', type: 'us_bank_account' }]));
  const recorder = new FixtureRecorder(gymId), recorded = recorder.wrap(payments);
  const recordedPage = await recorded.listCustomerCards(customerId, { householdId });
  expect(await replayPayments(JSON.parse(JSON.stringify(recorder.tape)), gymId).listCustomerCards(customerId, { householdId })).toEqual(recordedPage);
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
