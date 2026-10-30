// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { paymentAttemptStatusSchema } from '../../../../../packages/shared/src/contracts/states.js';
import { FakeInvoiceTransitions } from './invoice-transitions.js';
import { invoiceTransitionsContract } from './invoice-transitions.contract.js';
import type { CardSuccess, InvoiceSnapshot, RefundTransition } from './invoice-transitions.js';
import { gym, otherGym, household, id, mutation } from './test-fixtures.js';
const invoiceId = id(20);
const attemptId = id(21);
const paymentId = id(22);
const invoice: InvoiceSnapshot = { id: invoiceId, householdId: household, number: 100,
  kind: 'cycle', status: 'open', amountCents: 10000, currency: 'CAD', paidAt: null };
const success: CardSuccess = { invoiceId, attemptId, paymentId, paymentIntentId: 'pi_1', chargeId: 'ch_1',
  amountCents: 10000, currency: 'CAD', paidAt: '2026-10-21T12:00:00Z' };
const failure = { invoiceId, attemptId, paymentIntentId: 'pi_1', outcome: 'failed' as const };
const refund: RefundTransition = { invoiceId, paymentId, refundId: id(30), processorId: 're_1',
  amountCents: 4000, currency: 'CAD', status: 'succeeded' };
const build = (overrides: Partial<InvoiceSnapshot> = {}) => new FakeInvoiceTransitions(
  [{ gymId: gym, invoice: { ...invoice, ...overrides } }],
  [{ gymId: gym, invoiceId, id: attemptId, number: 1, paymentIntentId: 'pi_1', status: 'pending' }],
);
describe('InvoiceTransitions fake', () => {
  it('deduplicates success from a runner and webhook by intent even when their local IDs differ', async () => {
    const fake = build();
    expect((await fake.cardSucceeded(mutation, success)).invoice.status).toBe('paid');
    expect((await fake.cardSucceeded(mutation, { ...success, paymentId: id(99) })).outcome).toBe('ignored');
    expect((await fake.cardSucceeded(mutation, success)).outcome).toBe('ignored');
    expect(fake.payments).toHaveLength(1);
    expect(fake.effects.map((effect) => effect.kind)).toEqual(['receipt', 'activate_memberships']);
  });
  it('keeps paid final when older failures and requires-action events arrive', async () => {
    const fake = build();
    await fake.cardSucceeded(mutation, success);
    await fake.cardFailed(mutation, failure);
    await fake.cardFailed(mutation, { ...failure, outcome: 'requires_action' });
    expect(fake.read(gym, invoiceId).status).toBe('paid');
    expect(fake.effects.some((effect) => effect.kind === 'dunning')).toBe(false);
  });
  it('deduplicates failures and ignores outcomes for an older attempt', async () => {
    const fake = build();
    await fake.cardFailed(mutation, failure);
    expect((await fake.cardFailed(mutation, failure)).outcome).toBe('ignored');
    expect(fake.effects.filter((effect) => effect.kind === 'dunning')).toHaveLength(1);
    fake.seedAttempt({ gymId: gym, invoiceId, id: id(23), number: 2, paymentIntentId: 'pi_2', status: 'pending' });
    expect((await fake.cardFailed(mutation, { ...failure, outcome: 'requires_action' })).outcome).toBe('ignored');
    expect(fake.effects.filter((effect) => effect.kind === 'dunning')).toHaveLength(1);
  });
  it('sends normalized authentication requirements down the action path, then accepts success', async () => {
    const fake = build();
    expect((await fake.cardFailed(mutation, { ...failure, outcome: 'requires_action' })).invoice.status).toBe('past_due');
    expect((await fake.cardFailed(mutation, failure)).outcome).toBe('ignored');
    expect((await fake.cardSucceeded(mutation, success)).invoice.status).toBe('paid');
  });
  it('never schedules dunning for a one-off invoice', async () => {
    const fake = build({ kind: 'one_off' });
    expect((await fake.cardFailed(mutation, failure)).invoice.status).toBe('open');
    await fake.cardFailed(mutation, { ...failure, outcome: 'requires_action' });
    expect(fake.effects).toEqual([]);
  });
  it('rejects wrong money and cross-gym or mismatched attempt references before writing', async () => {
    const fake = build();
    await expect(fake.cardSucceeded(mutation, { ...success, currency: 'USD' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(fake.cardSucceeded(mutation, { ...success, amountCents: 9999 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(fake.cardSucceeded({ ...mutation, gymId: otherGym }, success)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.cardSucceeded(mutation, { ...success, paymentIntentId: 'pi_other' })).rejects.toMatchObject({ code: 'not_found' });
    expect(fake.payments).toEqual([]);
    expect(fake.read(gym, invoiceId).status).toBe('open');
  });
  it('records cash once and refunds a later Checkout payment exactly once', async () => {
    const fake = build();
    const manual = { invoiceId, paymentId: id(40), method: 'cash' as const, amountCents: 10000,
      currency: 'CAD', paidAt: success.paidAt };
    await fake.manualPayment(mutation, manual);
    expect((await fake.manualPayment(mutation, manual)).outcome).toBe('ignored');
    expect((await fake.cardSucceeded(mutation, success)).outcome).toBe('duplicate_payment');
    expect((await fake.cardSucceeded(mutation, success)).outcome).toBe('ignored');
    expect(fake.effects.filter((effect) => effect.kind === 'refund_duplicate')).toHaveLength(1);
    expect(fake.effects.filter((effect) => effect.kind === 'staff_notice')).toHaveLength(1);
    expect((await fake.refund(mutation, { ...refund, amountCents: 10000 })).invoice.status).toBe('paid');
  });
  it('moves forward through partial and full refunds without duplicate or stale writes', async () => {
    const fake = build();
    await fake.cardSucceeded(mutation, success);
    expect((await fake.refund(mutation, { ...refund, status: 'pending' })).invoice.status).toBe('paid');
    expect((await fake.refund(mutation, refund)).invoice.status).toBe('partially_refunded');
    expect((await fake.refund(mutation, refund)).outcome).toBe('ignored');
    expect((await fake.refund(mutation, { ...refund, status: 'pending' })).outcome).toBe('ignored');
    expect((await fake.refund(mutation, { ...refund, refundId: id(31), processorId: 're_2', amountCents: 6000 })).invoice.status).toBe('refunded');
    await fake.cardFailed(mutation, failure);
    expect(fake.read(gym, invoiceId).status).toBe('refunded');
  });
  it('reserves pending refunds and rejects over-refunds, mismatched currency and reused processor IDs', async () => {
    const fake = build();
    await fake.cardSucceeded(mutation, success);
    await fake.refund(mutation, { ...refund, amountCents: 8000, status: 'pending' });
    await expect(fake.refund(mutation, { ...refund, refundId: id(31), processorId: 're_2', amountCents: 3000 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(fake.refund(mutation, { ...refund, currency: 'USD' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(fake.refund(mutation, { ...refund, refundId: id(31), amountCents: 1000 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(fake.refund({ ...mutation, gymId: otherGym }, refund)).rejects.toMatchObject({ code: 'not_found' });
    await fake.refund(mutation, { ...refund, amountCents: 8000, status: 'failed' });
    expect((await fake.refund(mutation, { ...refund, refundId: id(32), processorId: 're_3', amountCents: 10000 })).invoice.status).toBe('refunded');
  });
  it.each([['pending', 'confirm_abandoned'], ['requires_action', 'intent_canceled']] as const)(
    'does not resurrect a cancelled %s intent or a void invoice', async (status, declineCode) => {
    const fake = build();
    if (status === 'requires_action') await fake.cardFailed(mutation, { ...failure, outcome: 'requires_action' });
    await fake.cardFailed(mutation, { ...failure, outcome: 'canceled' });
    expect(fake.attempts[0]).toMatchObject({ status: 'failed', declineCode });
    expect(paymentAttemptStatusSchema.parse(fake.attempts[0]!.status)).toBe('failed');
    const restored = new FakeInvoiceTransitions([{ gymId: gym, invoice: fake.read(gym, invoiceId) }], fake.attempts);
    expect((await restored.cardSucceeded(mutation, success)).outcome).toBe('ignored');
    expect((await fake.cardSucceeded(mutation, success)).outcome).toBe('ignored');
    expect(fake.payments).toEqual([]);
    await expect(build({ status: 'void' }).cardSucceeded(mutation, success)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('returns snapshots without sharing fake state', async () => {
    const fake = build();
    const result = await fake.cardSucceeded(mutation, success);
    (result.invoice as { status: string }).status = 'open';
    expect(fake.read(gym, invoiceId).status).toBe('paid');
  });
});
invoiceTransitionsContract('FakeInvoiceTransitions', async () => {
  const fake = build();
  return { transitions: fake, context: mutation, success: { ...success, attemptId },
    manual: { invoiceId, paymentId: id(40), method: 'cash', amountCents: 10000, currency: 'CAD', paidAt: success.paidAt },
    async read() {
      const attempt = fake.attempts.find((row) => row.id === attemptId)!;
      return { invoice: fake.read(gym, invoiceId).status, attempt: { status: attempt.status, declineCode: attempt.declineCode ?? null },
        effects: fake.effects.map((effect) => effect.kind).sort() };
    } };
});
