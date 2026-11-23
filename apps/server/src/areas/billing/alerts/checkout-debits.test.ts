// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, invoices, uuidv7 } from '@plaingym/db';
import { createCheckoutDebitReviewProvider } from './checkout-debits.js';
import { checkoutReviewAction, lateProcessingResolved } from '../runner/reconciliation.js';
import { stripeTestClearedAction } from '../stripe-writes.js';
import { useRunnerFixture, type Fixture } from '../runner/runner.fixture.test-helper.js';

const { db, factory, fixture, invoice } = useRunnerFixture();
const provider = createCheckoutDebitReviewProvider({ scope: db.forGym });
const read = (f: Fixture) => provider.read({ gymId: f.gymId, roles: ['owner'], clock: f.clock });

async function startCheckout(f: Fixture, late = false) {
  const bill = await invoice(f);
  const context = { gymId: f.gymId, actor: { kind: 'system' as const } };
  const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', invoiceId: bill.id,
    amount: bill.amountCents, currency: 'usd', bankDebit: { type: 'us_bank_account' },
    successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel',
    saveForOffSession: true, idempotencyKey: 'checkout-debit' });
  const paymentIntentId = f.provider.completeCheckout(session.id, { method: 'us_bank_account' }).chargeId!;
  if (late) await f.transitions.manualPayment(context, { invoiceId: bill.id, paymentId: uuidv7(), amountCents: bill.amountCents,
    currency: bill.currency, paidAt: f.clock.now().toISOString(), method: 'cash' });
  await f.transitions.paymentProcessing(context, { invoiceId: bill.id, paymentIntentId });
  f.clock.advance(11 * 86400_000);
  return { bill, paymentIntentId };
}

function setCustomer(f: Fixture, stripeCustomerId: string) {
  return db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId }).where(eq(households.id, f.home.id)));
}

describe('Checkout debit dashboard widget', () => {
  it('counts each affected invoice once and hides the finding after its payment is recorded', async () => {
    const f = await fixture({ currency: 'USD' });
    const foreign = await fixture({ currency: 'USD' });
    expect(await read(f)).toBeNull();
    const { bill, paymentIntentId } = await startCheckout(f);
    await setCustomer(f, 'cus_other');
    f.provider.settleCharge(paymentIntentId, 'succeeded');

    const mismatch = { inspected: 1, issues: [{ kind: 'checkout_debit', id: paymentIntentId, reason: 'customer_mismatch' }] };
    expect(await f.runner.reconcile(f.gymId)).toEqual(mismatch);
    expect(await read(f)).toEqual({ id: 'billing.checkout-debits', titleKey: 'billing/alerts:checkoutDebitsTitle',
      status: 'ready', kind: 'count', count: 1 });
    expect(await f.runner.reconcile(f.gymId)).toEqual(mismatch);
    expect(await read(f)).toHaveProperty('count', 1);
    await factory('auditEvents', f.gymId, { action: checkoutReviewAction, targetType: 'invoice', targetId: bill.id,
      after: { reason: 'pending', paymentIntentId } });
    expect(await read(f)).toHaveProperty('count', 1);
    expect(await read(foreign)).toBeNull();
    await expect(provider.read({ gymId: f.gymId, roles: ['coach'], clock: f.clock })).rejects.toMatchObject({ code: 'forbidden' });

    await setCustomer(f, 'cus_test');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect((await f.read()).payments).toMatchObject([{ paymentIntentId }]);
    expect(await read(f)).toBeNull();
  });

  it('counts an unsettled finding on a paid invoice until the late debit is recorded', async () => {
    const f = await fixture({ currency: 'USD' });
    const { bill, paymentIntentId } = await startCheckout(f, true);
    await setCustomer(f, 'cus_other');
    f.provider.settleCharge(paymentIntentId, 'succeeded');
    expect(await f.runner.reconcile(f.gymId)).toEqual({
      inspected: 1, issues: [{ kind: 'checkout_debit', id: paymentIntentId, reason: 'customer_mismatch' }],
    });
    const before = await f.read();
    expect(before.invoices[0]?.status).toBe('paid');
    expect(before.payments).toMatchObject([{ method: 'cash' }]);
    expect(await read(f)).toHaveProperty('count', 1);
    await factory('auditEvents', f.gymId, { action: lateProcessingResolved, targetType: 'invoice', targetId: bill.id,
      after: { paymentIntentId: 'pi_other', code: 'canceled' } });
    expect(await read(f)).toHaveProperty('count', 1);

    await setCustomer(f, 'cus_test');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect((await f.read()).payments).toEqual(expect.arrayContaining([expect.objectContaining({ paymentIntentId })]));
    expect(await read(f)).toBeNull();
  });

  it('counts a later mismatched late intent after the invoice paid the first', async () => {
    const f = await fixture({ currency: 'USD' });
    const { bill, paymentIntentId: first } = await startCheckout(f, true);
    const context = { gymId: f.gymId, actor: { kind: 'system' as const } };
    await setCustomer(f, 'cus_other');
    f.provider.settleCharge(first, 'succeeded');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [
      { kind: 'checkout_debit', id: first, reason: 'customer_mismatch' },
    ] });
    expect(await read(f)).toHaveProperty('count', 1);

    // Recording the first intent clears its finding; the second settles across the same paid invoice.
    await setCustomer(f, 'cus_test');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(await read(f)).toBeNull();

    const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', invoiceId: bill.id,
      amount: bill.amountCents, currency: 'usd', bankDebit: { type: 'us_bank_account' },
      successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: 'checkout-debit-later' });
    const second = f.provider.completeCheckout(session.id, { method: 'us_bank_account' }).chargeId!;
    await f.transitions.paymentProcessing(context, { invoiceId: bill.id, paymentIntentId: second });
    await setCustomer(f, 'cus_other');
    f.provider.settleCharge(second, 'succeeded');
    f.clock.advance(11 * 86400_000);
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [
      { kind: 'checkout_debit', id: second, reason: 'customer_mismatch' },
    ] });
    expect(await read(f)).toHaveProperty('count', 1);

    await setCustomer(f, 'cus_test');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(await read(f)).toBeNull();
  });

  it('ignores a pending finding for an earlier intent after a new processing attempt starts', async () => {
    const f = await fixture({ currency: 'USD' });
    const { bill, paymentIntentId: first } = await startCheckout(f);
    const context = { gymId: f.gymId, actor: { kind: 'system' as const } };
    const current = await f.provider.findCharge({ kind: 'charge', id: first });
    if (current.status !== 'processing') throw new Error('Expected a processing debit');
    vi.spyOn(f.provider, 'findCharge').mockResolvedValueOnce({ ...current, status: 'pending' });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [
      { kind: 'checkout_debit', id: first, reason: 'pending' },
    ] });
    expect(await read(f)).toHaveProperty('count', 1);

    await f.transitions.processingFailed(context, { invoiceId: bill.id, paymentIntentId: first, code: 'insufficient_funds' });
    const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', invoiceId: bill.id,
      amount: bill.amountCents, currency: 'usd', bankDebit: { type: 'us_bank_account' },
      successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: 'checkout-debit-retry' });
    const second = f.provider.completeCheckout(session.id, { method: 'us_bank_account' }).chargeId!;
    await f.transitions.paymentProcessing(context, { invoiceId: bill.id, paymentIntentId: second });
    expect(await read(f)).toBeNull();

    await factory('auditEvents', f.gymId, { action: checkoutReviewAction, targetType: 'invoice', targetId: bill.id,
      after: { reason: 'pending', paymentIntentId: second } });
    expect(await read(f)).toHaveProperty('count', 1);
  });

  it('counts a processing invoice with a finding and no processing audit', async () => {
    const f = await fixture({ currency: 'USD' });
    const bill = await invoice(f);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'processing' }).where(eq(invoices.id, bill.id)));
    await factory('auditEvents', f.gymId, { action: checkoutReviewAction, targetType: 'invoice', targetId: bill.id,
      after: { reason: 'pending', paymentIntentId: 'pi_without_processing_audit' } });
    expect(await read(f)).toHaveProperty('count', 1);
  });

  it('drops a late finding from Stripe test mode once a switch to live clears it', async () => {
    const f = await fixture({ currency: 'USD' });
    const { paymentIntentId } = await startCheckout(f, true);
    await setCustomer(f, 'cus_other');
    f.provider.settleCharge(paymentIntentId, 'succeeded');
    expect(await f.runner.reconcile(f.gymId)).toEqual({
      inspected: 1, issues: [{ kind: 'checkout_debit', id: paymentIntentId, reason: 'customer_mismatch' }],
    });
    expect(await read(f)).toHaveProperty('count', 1);

    await factory('auditEvents', f.gymId, { action: stripeTestClearedAction, targetType: 'gym', targetId: f.gymId, after: {} });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(await read(f)).toBeNull();
  });

  it('hides a late finding once the sweep records that the same intent failed', async () => {
    const f = await fixture({ currency: 'USD' });
    const { bill, paymentIntentId } = await startCheckout(f, true);
    const current = await f.provider.findCharge({ kind: 'charge', id: paymentIntentId });
    if (current.status !== 'processing') throw new Error('Expected a processing debit');
    const find = vi.spyOn(f.provider, 'findCharge').mockResolvedValueOnce({ ...current, status: 'pending' });
    expect(await f.runner.reconcile(f.gymId)).toEqual({
      inspected: 1, issues: [{ kind: 'checkout_debit', id: paymentIntentId, reason: 'pending' }],
    });
    expect(await read(f)).toHaveProperty('count', 1);
    find.mockResolvedValueOnce({ ...current, status: 'failed', code: 'canceled' });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect((await f.read()).audits.filter(event => event.action === lateProcessingResolved)).toMatchObject([
      { targetId: bill.id, after: { paymentIntentId, code: 'canceled' } },
    ]);
    expect(await read(f)).toBeNull();
  });
});
