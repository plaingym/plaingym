// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { FakePayments } from './index.js';
import { StripePayments } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';

// A refund read is `missing` only when the processor says the refund itself doesn't exist. A missing parent or
// another gym's parent is unverified and answers `unknown` without the mark.
const gymId = '00000000-0000-7000-8000-000000000454';

function stripe() {
  const transport = new StripeFixtures(gymId);
  const payments = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret', clock: new TestClock('2026-10-23T12:00:00Z') });
  return { transport, payments };
}

it('marks a refund Stripe does not hold as missing', async () => {
  const { payments } = stripe();
  const reference = { kind: 'refund', id: 're_absent' } as const;
  expect(await payments.readPaymentObject(reference)).toEqual({ status: 'unknown', reference, missing: true });
});

it('preserves the provider error when a change feed event names a missing refund', async () => {
  const failure = Object.assign(new Error('Refund is absent'), { statusCode: 404, code: 'resource_missing' });
  const payments = new StripePayments(gymId, { webhookSecret: 'fixture-secret', transport: { async request(input) {
    if (input.path === '/v1/events') return { has_more: false,
      data: [{ created: 1, data: { object: { object: 'refund', id: 're_absent' } } }] };
    if (input.path === '/v1/refunds/re_absent') throw failure;
    throw new Error('Unexpected request');
  } } });
  await expect(payments.listChangesSince(new Date(0))).rejects.toHaveProperty('cause', failure);
});

it('does not mark a refund whose parent intent is missing', async () => {
  const { payments, transport } = stripe();
  transport.objects.set('re_orphan', { id: 're_orphan', object: 'refund', created: transport.now, payment_intent: 'pi_absent',
    amount: 10, currency: 'usd', status: 'succeeded', metadata: {} });
  const reference = { kind: 'refund', id: 're_orphan' } as const;
  const read = await payments.readPaymentObject(reference);
  expect(read).toEqual({ status: 'unknown', reference });
  expect(read).not.toHaveProperty('missing');
});

it('does not mark a refund whose parent belongs to another gym', async () => {
  const { payments, transport } = stripe();
  transport.objects.set('pi_foreign', { id: 'pi_foreign', object: 'payment_intent', amount: 100, currency: 'usd',
    status: 'succeeded', metadata: { gym_id: 'another-gym' } });
  transport.objects.set('re_foreign', { id: 're_foreign', object: 'refund', created: transport.now, payment_intent: 'pi_foreign',
    amount: 10, currency: 'usd', status: 'succeeded', metadata: {} });
  const reference = { kind: 'refund', id: 're_foreign' } as const;
  const read = await payments.readPaymentObject(reference);
  expect(read).toEqual({ status: 'unknown', reference });
  expect(read).not.toHaveProperty('missing');
});

it('marks an unheld refund on the fake as missing, and an uncertain one as unverified', async () => {
  const payments = new FakePayments(gymId, new TestClock('2026-10-23T12:00:00Z'));
  const absent = { kind: 'refund', id: 're_absent' } as const, uncertain = { kind: 'refund', id: 're_uncertain' } as const;
  expect(await payments.readPaymentObject(absent)).toEqual({ status: 'unknown', reference: absent, missing: true });
  payments.setUncertain(uncertain.id);
  const read = await payments.readPaymentObject(uncertain);
  expect(read).toEqual({ status: 'unknown', reference: uncertain });
  expect(read).not.toHaveProperty('missing');
});
