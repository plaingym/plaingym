// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { FakePayments } from './index.js';
import { FixtureRecorder, Replay, replayPayments, redact } from './recording.js';
import { TestClock } from '../../core/clock.js';
import { paymentsContract } from '../../core/registry-infra-contracts.js';

export const gymId = '00000000-0000-7000-8000-000000000001';
export const charge = { amount: 100, currency: 'usd', customerId: 'cus_fixture', paymentMethodId: 'pm_fixture',
  invoiceId: 'invoice_fixture', attemptId: '1', idempotencyKey: 'invoice_fixture:1:create' };
export const checkout = { mode: 'payment' as const, amount: 100, currency: 'usd', customerId: 'cus_fixture',
  successUrl: 'https://gym.invalid/success', cancelUrl: 'https://gym.invalid/cancel', saveForOffSession: true,
  idempotencyKey: 'checkout_fixture', invoiceId: 'invoice_fixture' };
paymentsContract('replayable fake', async () => ({ payments: new FakePayments(gymId), charge, checkout }));

it('records and replays Dates, bytes, idempotency, and errors without a provider', async () => {
  const recorder = new FixtureRecorder(gymId), fake = new FakePayments(gymId, new TestClock('2026-10-23T12:00:00Z'));
  const provider = recorder.wrap(fake);
  const intent = await provider.createCharge(charge);
  await provider.confirmCharge(intent.id, { idempotencyKey: 'confirm' });
  const since = new Date('2026-10-23T00:00:00Z');
  const changes = await provider.listChangesSince(since);
  await expect(provider.createCharge({ ...charge, amount: 200 })).rejects.toThrow();
  const replay = replayPayments(JSON.parse(JSON.stringify(recorder.tape)), gymId);
  expect(await replay.createCharge(charge)).toEqual(intent);
  await replay.confirmCharge(intent.id, { idempotencyKey: 'confirm' });
  expect(await replay.listChangesSince(since)).toEqual(changes);
  await expect(replay.createCharge({ ...charge, amount: 200 })).rejects.toThrow();
  await expect(replay.cancelCharge(intent.id)).rejects.toThrow('mismatch');
  expect(() => replayPayments(recorder.tape, 'other')).toThrow('mismatch');
});
it('redacts credentials and card secrets from request/response fixtures', () => {
  const redacted = JSON.stringify(redact({ secret: 'signing-secret', client_secret: 'pi_secret',
    key: 'rk_test_SYNTHETIC', number: 'synthetic-card', cvc: 'synthetic-cvc', metadata: { gym_id: gymId } }));
  expect(redacted).not.toMatch(/signing-secret|pi_secret|rk_test_|synthetic-card|synthetic-cvc/);
  expect(redacted).toContain(gymId);
});
it('rejects reordered requests and unconsumed exchanges', async () => {
  const replay = new Replay({ version: 1, gymId, exchanges: [{ operation: 'one', input: [] }] }, gymId);
  expect(() => replay.assertConsumed()).toThrow('Unconsumed');
  await expect(replay.run('two', [])).rejects.toThrow('mismatch');
});
it('retains nested Stripe card-error intents for normalization during transport replay', async () => {
  const recorder = new FixtureRecorder(gymId);
  await expect(recorder.run('confirm', [], async () => { throw { type: 'StripeCardError', raw: {
    payment_intent: { id: 'pi_fixture', status: 'requires_payment_method', client_secret: 'sensitive',
      last_payment_error: { code: 'authentication_required' } },
  } }; })).rejects.toMatchObject({ type: 'StripeCardError' });
  expect(JSON.stringify(recorder.tape)).not.toContain('sensitive');
  await expect(new Replay(recorder.tape, gymId).run('confirm', [])).rejects.toMatchObject({ type: 'StripeCardError',
    payment_intent: { id: 'pi_fixture', last_payment_error: { code: 'authentication_required' } } });
});
it('does not expose a then method when a wrapped provider is returned from an async factory', async () => {
  const recorder = new FixtureRecorder(gymId), wrapped = recorder.wrap(new FakePayments(gymId));
  expect(await Promise.resolve(wrapped)).toBe(wrapped);
  const replay = replayPayments({ version: 1, gymId, exchanges: [] }, gymId);
  expect(await Promise.resolve(replay)).toBe(replay);
  expect(recorder.tape.exchanges).toEqual([]);
});
