// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { allocateInvoiceNumber, households, invoices, paymentAttempts, paymentMethods, payments, uuidv7 } from '@plaingym/db';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';
import { AppError } from '@plaingym/shared';
import type { FakePayments } from '../../../infra/payments/index.js';
import { createChargeRunner } from './index.js';
import { createRunnerJobs } from './runner.jobs.js';
import { createRestoreCheckLease } from '../../health/restore.billing-lease.js';
import { createPaymentService } from '../payments.js';
import { useRunnerFixture, gate, type Fixture } from './runner.fixture.test-helper.js';
import { lateProcessingResolved } from './reconciliation.js';

const { db, factory, fixture, invoice, checkout } = useRunnerFixture();

describe('bank debit reconciliation', () => {
  const day = 86400_000;
  const actor = (f: Fixture) => ({ gymId: f.gymId, actor: { kind: 'system' as const } });

  async function processingCheckout(f: Fixture, bill: Awaited<ReturnType<typeof invoice>>, key = 'checkout-debit') {
    const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', invoiceId: bill.id,
      amount: bill.amountCents, currency: 'usd', bankDebit: { type: 'us_bank_account' },
      successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: key });
    const paymentIntentId = f.provider.completeCheckout(session.id, { method: 'us_bank_account' }).chargeId!;
    expect((await f.transitions.paymentProcessing(actor(f), { invoiceId: bill.id, paymentIntentId })).outcome).toBe('applied');
    return paymentIntentId;
  }

  it('1. records exactly one bank payment for a Checkout debit that settled without a webhook', async () => {
    const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
    const paymentIntentId = await processingCheckout(f, bill);
    f.clock.advance(4 * day);
    const paidAt = f.clock.now();
    f.provider.settleCharge(paymentIntentId, 'succeeded');
    f.clock.advance(7 * day);
    const find = vi.spyOn(f.provider, 'findCharge');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).toHaveBeenCalledExactlyOnceWith({ kind: 'charge', id: paymentIntentId }, { includeSuccessTime: true });
    const rows = await f.read();
    expect(rows.invoices[0]).toMatchObject({ status: 'paid', paidAt });
    expect(rows.payments).toMatchObject([{ method: 'bank_debit', paymentIntentId, paidAt }]);
    expect(rows.attempts).toEqual([]);
  });

  it('2. leaves a still-processing Checkout debit alone after eleven days', async () => {
    const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
    const paymentIntentId = await processingCheckout(f, bill);
    const before = await f.read();
    f.clock.advance(11 * day);
    const cancel = vi.spyOn(f.provider, 'cancelCharge'), find = vi.spyOn(f.provider, 'findCharge');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(find).toHaveBeenCalledExactlyOnceWith({ kind: 'charge', id: paymentIntentId }, { includeSuccessTime: true });
    expect(cancel).not.toHaveBeenCalled();
    expect(await f.read()).toEqual(before);
  });

  it('3. moves a cycle invoice to past due when its Checkout debit failed without a webhook', async () => {
    const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
    const paymentIntentId = await processingCheckout(f, bill);
    f.provider.settleCharge(paymentIntentId, 'insufficient_funds');
    f.clock.advance(11 * day);
    const find = vi.spyOn(f.provider, 'findCharge');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(find).toHaveBeenCalledExactlyOnceWith({ kind: 'charge', id: paymentIntentId }, { includeSuccessTime: true });
    const rows = await f.read();
    expect(rows.invoices[0]?.status).toBe('past_due');
    expect(rows.payments).toEqual([]);
    expect(rows.attempts).toEqual([]);
  });

  it('4. skips a two-day-old Checkout debit even when an earlier processing audit is stale', async () => {
    const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
    const previousIntentId = await processingCheckout(f, bill);
    f.provider.settleCharge(previousIntentId, 'insufficient_funds');
    await f.transitions.processingFailed(actor(f), { invoiceId: bill.id, paymentIntentId: previousIntentId, code: 'insufficient_funds' });
    f.clock.advance(11 * day);
    await processingCheckout(f, bill, 'checkout-retry');
    f.clock.advance(2 * day);
    const find = vi.spyOn(f.provider, 'findCharge');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).not.toHaveBeenCalled();
    expect((await f.read()).invoices[0]?.status).toBe('processing');
  });

  it('5. moves a pending runner attempt to processing after cash was recorded and skips the next hourly sweep', async () => {
    const f = await fixture({ currency: 'USD' });
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ type: 'us_bank_account' })
      .where(eq(paymentMethods.householdId, f.home.id)));
    f.provider.recordPaymentMethod({ id: 'pm_test', customerId: 'cus_test', type: 'us_bank_account', last4: '6789' });
    f.provider.loseNextResponse('confirmCharge');
    await f.runner.daily(f.gymId);
    const { attempts: [attempt], invoices: [bill] } = await f.read();
    expect(attempt).toMatchObject({ status: 'pending', processingAt: null });
    const paymentIntentId = attempt!.paymentIntentId!;
    expect((await f.provider.findCharge({ kind: 'charge', id: paymentIntentId })).status).toBe('processing');
    await f.transitions.manualPayment(actor(f), { invoiceId: bill!.id, paymentId: uuidv7(), amountCents: bill!.amountCents,
      currency: bill!.currency, paidAt: f.clock.now().toISOString(), method: 'cash' });

    const processingAt = f.clock.now();
    const request = { invoiceId: bill!.id, attemptId: attempt!.id, paymentIntentId };
    expect(await f.transitions.paymentProcessing(actor(f), request)).toMatchObject({ outcome: 'ignored', invoice: { status: 'paid' } });
    f.clock.advance(3600_000);
    expect((await f.transitions.paymentProcessing(actor(f), request)).outcome).toBe('ignored');
    const find = vi.spyOn(f.provider, 'findCharge');
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).not.toHaveBeenCalled();
    const rows = await f.read();
    expect(rows.invoices[0]?.status).toBe('paid');
    expect(rows.attempts).toMatchObject([{ status: 'processing', processingAt, resolvedAt: null }]);
    expect(rows.payments).toMatchObject([{ method: 'cash' }]);
    expect(rows.audits.filter(event => event.action === 'billing.attempt.processing'))
      .toMatchObject([{ targetId: attempt!.id, occurredAt: processingAt }]);
  });

  it.each(['canceled', 'provider_error'] as const)('recovers a Checkout debit whose intent reports %s', async code => {
    const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
    const paymentIntentId = await processingCheckout(f, bill);
    const ref = { kind: 'charge' as const, id: paymentIntentId };
    const processing = await f.provider.findCharge(ref);
    if (processing.status !== 'processing') throw new Error('Expected a processing debit');
    const find = vi.spyOn(f.provider, 'findCharge').mockResolvedValueOnce({ ...processing, status: 'failed', code });
    f.clock.advance(11 * day);

    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).toHaveBeenCalledExactlyOnceWith(ref, { includeSuccessTime: true });
    const rows = await f.read();
    expect(rows.invoices[0]?.status).toBe('past_due');
    expect(rows.audits.filter(event => event.action === 'billing.invoice.payment_failed')).toMatchObject([
      { targetId: bill.id, after: { status: 'past_due', failureCode: code } },
    ]);
    expect(rows.payments).toEqual([]);
    expect(rows.attempts).toEqual([]);
  });

  it.each(['customer_mismatch', 'pending', 'attempt_resolved'] as const)(
    'reports Checkout debit %s without failing the hourly job or repeating the audit', async reason => {
      const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
      const paymentIntentId = await processingCheckout(f, bill);
      const current = await f.provider.findCharge({ kind: 'charge', id: paymentIntentId });
      if (current.status !== 'processing') throw new Error('Expected a processing debit');
      if (reason === 'customer_mismatch') {
        await db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId: 'cus_other' }).where(eq(households.id, f.home.id)));
        f.provider.settleCharge(paymentIntentId, 'succeeded');
      } else if (reason === 'pending') {
        vi.spyOn(f.provider, 'findCharge').mockResolvedValue({ ...current, status: 'pending' });
      } else {
        await factory('paymentAttempts', f.gymId, { invoiceId: bill.id, currency: bill.currency, paymentIntentId,
          status: 'failed', resolvedAt: f.clock.now() });
      }
      f.clock.advance(11 * day);
      const job = createRunnerJobs(() => f.runner).find(job => job.id === 'billing.runner.reconcile')!;
      const cancel = vi.spyOn(f.provider, 'cancelCharge');
      const [result] = await Promise.all([f.runner.reconcile(f.gymId), job.handler({}, f.context)]);
      expect(result).toEqual({ inspected: 1, issues: [{ kind: 'checkout_debit', id: paymentIntentId, reason }] });
      await expect(job.handler({}, f.context)).resolves.toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();
      const rows = await f.read();
      expect(rows.audits.filter(event => event.action === 'billing.runner.checkout_debit_unresolved')).toMatchObject([
        { targetType: 'invoice', targetId: bill.id, after: { reason, paymentIntentId } },
      ]);
      expect(rows.invoices[0]?.status).toBe('processing');
      expect(rows.payments).toEqual([]);
    });

  it('identifies a Checkout provider error separately from unresolved runner attempts', async () => {
    const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
    await processingCheckout(f, bill);
    f.clock.advance(11 * day);
    vi.spyOn(f.provider, 'findCharge').mockRejectedValue(new Error('Stripe is unreachable'));
    const job = createRunnerJobs(() => f.runner).find(job => job.id === 'billing.runner.reconcile')!;
    await expect(job.handler({}, f.context)).rejects.toThrow('Checkout bank debits remain unresolved');
  });

  async function startLateCheckout() {
    const f = await fixture({ currency: 'USD' }), bill = await invoice(f);
    const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', invoiceId: bill.id,
      amount: bill.amountCents, currency: 'usd', bankDebit: { type: 'us_bank_account' },
      successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: 'checkout-cash-race' });
    let paymentIntentId: string | undefined;
    const staff = createPaymentService({ ...f.serviceOptions, paymentsFor: async () => f.provider,
      transitions: { ...f.transitions, async manualPayment(context, request) {
        // Checkout saves its session and completes after the staff service's last locked check.
        await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: session.id }).where(eq(invoices.id, bill.id)));
        paymentIntentId = f.provider.completeCheckout(session.id, { method: 'us_bank_account' }).chargeId!;
        return f.transitions.manualPayment(context, request);
      } },
    });
    const cash = await staff.manualPayment(actor(f), bill.id, { method: 'cash', amountCents: bill.amountCents,
      currency: 'USD', paidAt: f.clock.now().toISOString() });
    if (!paymentIntentId) throw new Error('Expected Checkout to have completed');
    const request = { invoiceId: bill.id, paymentIntentId };
    for (let count = 0; count < 2; count++) {
      expect(await f.transitions.paymentProcessing(actor(f), request)).toMatchObject({ outcome: 'ignored', invoice: { status: 'paid' } });
    }
    return { f, bill, cash, paymentIntentId };
  }

  it('recovers and refunds a Checkout debit that starts processing after cash won the invoice', async () => {
    const { f, bill, cash, paymentIntentId } = await startLateCheckout();
    const find = vi.spyOn(f.provider, 'findCharge');
    f.clock.advance(9 * day);
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    f.provider.settleCharge(paymentIntentId, 'succeeded');
    f.clock.advance(2 * day);
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).toHaveBeenCalledExactlyOnceWith({ kind: 'charge', id: paymentIntentId }, { includeSuccessTime: true });

    const rows = await f.read();
    expect(rows.invoices[0]?.status).toBe('paid');
    expect(rows.audits.filter(event => event.action === 'billing.invoice.late_processing')).toMatchObject([
      { targetId: bill.id, after: { paymentIntentId } },
    ]);
    expect(rows.payments.map(payment => payment.method).sort()).toEqual(['bank_debit', 'cash']);
    expect(rows.payments.find(payment => payment.method === 'cash')?.id).toBe(cash.id);
    expect(rows.refunds).toMatchObject([{ reason: 'duplicate_payment', status: 'pending',
      paymentId: rows.payments.find(payment => payment.paymentIntentId === paymentIntentId)?.id }]);
    expect(rows.attempts).toEqual([]);
  });

  it.each(['canceled', 'provider_error'] as const)('stops reading a late Checkout debit Stripe reports as %s', async code => {
    const { f, bill, cash, paymentIntentId } = await startLateCheckout();
    const ref = { kind: 'charge' as const, id: paymentIntentId };
    const processing = await f.provider.findCharge(ref);
    if (processing.status !== 'processing') throw new Error('Expected a processing debit');
    const find = vi.spyOn(f.provider, 'findCharge').mockResolvedValueOnce({ ...processing, status: 'failed', code });
    const cancel = vi.spyOn(f.provider, 'cancelCharge');
    f.clock.advance(11 * day);

    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).toHaveBeenCalledExactlyOnceWith(ref, { includeSuccessTime: true });
    expect(cancel).not.toHaveBeenCalled();
    const rows = await f.read();
    expect(rows.invoices[0]?.status).toBe('paid');
    expect(rows.payments).toMatchObject([{ id: cash.id, method: 'cash' }]);
    expect(rows.refunds).toEqual([]);
    expect(rows.audits.filter(event => event.action === lateProcessingResolved)).toMatchObject([
      { targetType: 'invoice', targetId: bill.id, after: { paymentIntentId, code } },
    ]);
  });

  it('records one resolving audit when two sweeps read the same failed late Checkout debit', async () => {
    const { f, paymentIntentId } = await startLateCheckout();
    const ref = { kind: 'charge' as const, id: paymentIntentId };
    const processing = await f.provider.findCharge(ref);
    if (processing.status !== 'processing') throw new Error('Expected a processing debit');
    const bothRead = gate();
    const find = vi.spyOn(f.provider, 'findCharge').mockImplementation(async () => {
      if (find.mock.calls.length === 2) bothRead.release();
      await bothRead.wait;
      return { ...processing, status: 'failed', code: 'canceled' };
    });
    f.clock.advance(11 * day);

    expect(await Promise.all([f.runner.reconcile(f.gymId), f.runner.reconcile(f.gymId)])).toEqual([
      { inspected: 1, issues: [] }, { inspected: 1, issues: [] },
    ]);
    expect((await f.read()).audits.filter(event => event.action === lateProcessingResolved)).toHaveLength(1);
  });

  it.each(['processing', 'succeeded'] as const)('reads a late Checkout debit Stripe still reports as %s on every sweep', async status => {
    const { f, paymentIntentId } = await startLateCheckout();
    const issues = status === 'succeeded' ? [{ kind: 'checkout_debit', id: paymentIntentId, reason: 'customer_mismatch' }] : [];
    if (status === 'succeeded') {
      await db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId: 'cus_other' }).where(eq(households.id, f.home.id)));
      f.provider.settleCharge(paymentIntentId, 'succeeded');
    }
    f.clock.advance(11 * day);
    const find = vi.spyOn(f.provider, 'findCharge');
    const cancel = vi.spyOn(f.provider, 'cancelCharge');

    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues });
    expect(find).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    expect((await f.read()).audits.filter(event => event.action === lateProcessingResolved)).toEqual([]);
  });
});

describe('charge crashes and reconciliation races', () => {
  it('does not require a provider for an empty sweep, but fails the job for unresolved stored intents', async () => {
    const f = await fixture();
    const payments = vi.fn(async () => { throw new Error('Payments are not configured'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments });
    const job = createRunnerJobs(() => runner).find(job => job.id === 'billing.runner.reconcile')!;
    expect(await runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    await expect(job.handler({}, f.context)).resolves.toBeUndefined();
    expect(payments).not.toHaveBeenCalled();
    f.provider.loseNextResponse('confirmCharge'); await f.runner.daily(f.gymId);
    // Recent reservations are not eligible for the sweep either.
    expect(await runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(payments).not.toHaveBeenCalled();
    f.clock.advance(16 * 60_000);
    await expect(job.handler({}, f.context)).rejects.toThrow('payment_attempts remain unresolved');
    expect(payments).toHaveBeenCalledWith(f.gymId);
    expect((await f.read()).attempts[0]!.status).toBe('pending');
  });
  it('lists stale intents without Stripe and completes the hourly job, but still fails for a real provider error', async () => {
    const f = await fixture();
    f.provider.loseNextResponse('confirmCharge'); await f.runner.daily(f.gymId); f.clock.advance(16 * 60_000);
    const payments = vi.fn(async () => { throw new AppError('unavailable', 'Stripe is not configured'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments });
    const job = createRunnerJobs(() => runner).find(job => job.id === 'billing.runner.reconcile')!;
    const attempt = (await f.read()).attempts[0]!;
    expect(await runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [
      { kind: 'charge', id: attempt.paymentIntentId, reason: 'stripe_not_configured' },
    ] });
    await expect(job.handler({}, f.context)).resolves.toBeUndefined();
    expect((await f.read()).attempts[0]).toMatchObject({ status: 'pending', resolvedAt: null });
    const broken = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: async () => f.provider });
    vi.spyOn(f.provider, 'findCharge').mockRejectedValue(new Error('Stripe is unreachable'));
    expect((await broken.reconcile(f.gymId)).issues).toMatchObject([{ reason: 'provider_or_transition_error' }]);
    await expect(createRunnerJobs(() => broken).find(job => job.id === 'billing.runner.reconcile')!.handler({}, f.context))
      .rejects.toThrow('remain unresolved');
    expect((await f.read()).attempts[0]!.status).toBe('pending');
  });
  it('abandons a stale no-ID reservation without requiring a provider', async () => {
    const f = await fixture();
    f.provider.loseNextResponse('createCharge'); await f.runner.daily(f.gymId);
    f.clock.advance(16 * 60_000);
    const payments = vi.fn(async () => { throw new Error('Payments are not configured'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments });
    expect(await runner.reconcile(f.gymId)).toEqual({ inspected: 1, issues: [] });
    expect(payments).not.toHaveBeenCalled();
    expect((await f.read()).attempts[0]).toMatchObject({ status: 'failed', declineCode: 'create_abandoned' });
  });
  it('recovers a success lost before its database commit with one payment, including with billing off', async () => {
    const f = await fixture(); f.provider.loseNextResponse('confirmCharge');
    const succeededAt = f.clock.now();
    expect((await f.runner.daily(f.gymId)).errors).toHaveLength(1);
    expect((await f.read()).attempts[0]!.status).toBe('pending');
    f.clock.advance(16 * 60_000); await f.enable(false);
    expect((await f.runner.reconcile(f.gymId)).issues).toEqual([]);
    await f.runner.reconcile(f.gymId); await f.enable(true); await f.runner.daily(f.gymId);
    const rows = await f.read();
    expect(rows.attempts).toHaveLength(1); expect(rows.payments).toHaveLength(1); expect(rows.invoices[0]!.status).toBe('paid');
    expect(rows.payments[0]!.paidAt).toEqual(succeededAt); expect(rows.invoices[0]!.paidAt).toEqual(succeededAt);
  });
  it.each(['missing', 'invalid'])('keeps a %s processor success time retryable without recording a payment', async kind => {
    const f = await fixture(), succeededAt = f.clock.now();
    f.provider.loseNextResponse('confirmCharge'); await f.runner.daily(f.gymId);
    f.clock.advance(3 * 86400000); await f.enable(false);
    const find = f.provider.findCharge.bind(f.provider);
    const lookup = vi.spyOn(f.provider, 'findCharge').mockImplementation(async (reference, options) => {
      expect(options).toEqual({ includeSuccessTime: true });
      const outcome = await find(reference, options);
      if (outcome.status !== 'succeeded') return outcome;
      const withoutTime = { ...outcome };
      delete withoutTime.succeededAt;
      return kind === 'missing' ? withoutTime : { ...withoutTime, succeededAt: new Date(NaN) };
    });
    expect((await f.runner.reconcile(f.gymId)).issues).toHaveLength(1);
    expect((await f.runner.postRestore(f.gymId, succeededAt)).readyForOwnerReview).toBe(false);
    const pending = await f.read();
    expect(pending.attempts[0]!.status).toBe('pending'); expect(pending.payments).toHaveLength(0);
    expect(pending.invoices[0]!.paidAt).toBeNull();
    lookup.mockRestore();
    expect((await f.runner.reconcile(f.gymId)).issues).toEqual([]);
    expect((await f.read()).payments[0]!.paidAt).toEqual(succeededAt);
  });
  it('skips unknown attempts even after idempotency keys expire', async () => {
    const f = await fixture(); f.provider.loseNextResponse('confirmCharge'); await f.runner.daily(f.gymId);
    const row = (await f.read()).attempts[0]!;
    f.provider.setUncertain(row.paymentIntentId!); f.clock.advance(25 * 60 * 60_000);
    const create = vi.spyOn(f.provider, 'createCharge');
    expect((await f.runner.reconcile(f.gymId)).issues).toHaveLength(1);
    await f.runner.daily(f.gymId); expect(create).not.toHaveBeenCalled(); expect((await f.read()).attempts).toHaveLength(1);
  });
  it('invalidates a delayed create before its CAS; its worker cancels and never confirms', async () => {
    const f = await fixture(), entered = gate(), resume = gate();
    const create = f.provider.createCharge.bind(f.provider), confirm = vi.spyOn(f.provider, 'confirmCharge');
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      entered.release(); await resume.wait; return create(request);
    });
    const run = f.runner.daily(f.gymId); await entered.wait;
    f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId);
    resume.release(); await run;
    expect(confirm).not.toHaveBeenCalled(); expect((await f.read()).attempts[0]!.declineCode).toBe('create_abandoned');
    await f.runner.daily(f.gymId);
    expect((await f.read()).payments).toHaveLength(1);
  });
  it.each(['cancel wins', 'confirm wins'])('serializes reconciliation versus a delayed confirm: %s', async winner => {
    const f = await fixture(), entered = gate(), resume = gate();
    const confirm = f.provider.confirmCharge.bind(f.provider);
    vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, request) => {
      const outcome = winner === 'confirm wins' ? await confirm(id, request) : undefined;
      entered.release(); await resume.wait; return outcome ?? confirm(id, request);
    });
    const run = f.runner.daily(f.gymId); await entered.wait;
    f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId); resume.release(); await run;
    const rows = await f.read();
    expect(rows.payments).toHaveLength(winner === 'confirm wins' ? 1 : 0);
    // A confirm that arrives after the reconcile cancelled the intent never reached the member's card.
    expect(rows.invoices[0]!.status).toBe(winner === 'confirm wins' ? 'paid' : 'open');
    expect(rows.attempts[0]).toMatchObject(winner === 'confirm wins' ? { status: 'succeeded' }
      : { status: 'failed', declineCode: 'confirm_abandoned' });
  });
  it('a no-ID reconciler CAS cannot overwrite an ID saved while it waits for the attempt lock', async () => {
    const f = await fixture(); f.provider.loseNextResponse('createCharge'); await f.runner.daily(f.gymId);
    const row = (await f.read()).attempts[0]!;
    const intent = await f.provider.createCharge({ amount: row.amountCents, currency: 'cad', customerId: row.stripeCustomerId,
      paymentMethodId: row.savedPaymentMethod, invoiceId: row.invoiceId, attemptId: row.id,
      idempotencyKey: `${row.invoiceId}:1:create` });
    const entered = gate(), resume = gate(); let calls = 0;
    const scope: typeof db.forGym = async (gymId, fn) => {
      if (++calls === 2) { entered.release(); await resume.wait; }
      return db.forGym(gymId, fn);
    };
    const racing = createChargeRunner({ ...f.serviceOptions, scope, transitions: f.transitions, payments: async () => f.provider });
    f.clock.advance(16 * 60_000);
    const run = racing.reconcile(f.gymId); await entered.wait;
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: intent.id }).where(eq(paymentAttempts.id, row.id)));
    resume.release(); await run;
    expect((await f.read()).attempts[0]).toMatchObject({ paymentIntentId: intent.id, status: 'pending', declineCode: null });
    await f.provider.confirmCharge(intent.id, { idempotencyKey: `${row.invoiceId}:1:confirm` });
    await f.runner.reconcile(f.gymId); expect((await f.read()).payments).toHaveLength(1);
  });
});

describe('post-restore reconciliation', () => {
  it('shares the alert rule for a recorded test dispute on a mixed invoice, using the latest dispute audit', async () => {
    const f = await fixture(); await f.runner.daily(f.gymId);
    const state = await f.read(), paid = state.payments[0]!, bill = state.invoices[0]!;
    const cash = await factory('payments', f.gymId, { invoiceId: bill.id, method: 'cash' });
    f.provider.recordDispute({ id: 'dp_mixed_test', chargeId: paid.paymentIntentId!, amount: 10000, status: 'open' });
    await db.forGym(f.gymId, async tx => {
      await tx.update(invoices).set({ disputeId: 'dp_mixed_test', disputeStatus: 'open' }).where(eq(invoices.id, bill.id));
      await tx.update(payments).set({ reference: stripeTestPaymentReference }).where(eq(payments.id, paid.id));
    });
    await factory('auditEvents', f.gymId, { action: 'billing.invoice.disputed', targetType: 'invoice', targetId: bill.id,
      after: { disputeId: 'dp_mixed_test', paymentId: cash.id }, createdAt: new Date(f.clock.now().getTime() - 1000) });
    await factory('auditEvents', f.gymId, { action: 'billing.invoice.disputed', targetType: 'invoice', targetId: bill.id,
      after: { disputeId: 'dp_mixed_test', paymentId: paid.id }, createdAt: f.clock.now() });
    f.clock.advance(10 * 86400000); await f.enable(false);
    const read = vi.spyOn(f.provider, 'readPaymentObject');
    expect((await f.runner.postRestore(f.gymId, f.clock.now())).readyForOwnerReview).toBe(true);
    expect(read).not.toHaveBeenCalledWith({ kind: 'dispute', id: 'dp_mixed_test' });
    // If a newer audit identifies the unmarked payment, the marked sibling no longer suppresses the dispute.
    await factory('auditEvents', f.gymId, { action: 'billing.invoice.disputed', targetType: 'invoice', targetId: bill.id,
      after: { disputeId: 'dp_mixed_test', paymentId: cash.id }, createdAt: f.clock.now() });
    await f.runner.postRestore(f.gymId, f.clock.now());
    expect(read).toHaveBeenCalledWith({ kind: 'dispute', id: 'dp_mixed_test' });
  });
  it('refreshes only unpaid stored Checkouts, retaining open disputes on paid invoices and post-snapshot session changes', async () => {
    const f = await fixture(); await f.runner.daily(f.gymId);
    const paid = (await f.read()).invoices[0]!, intentId = (await f.read()).attempts[0]!.paymentIntentId!;
    const old = await checkout(f, paid.id);
    f.provider.recordDispute({ id: 'dp_still_open', chargeId: intentId, amount: 10000, status: 'open' });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ disputeId: 'dp_still_open', disputeStatus: 'open' }).where(eq(invoices.id, paid.id)));
    const number = await db.forGym(f.gymId, tx => allocateInvoiceNumber(tx, f.gymId));
    const unpaid = await factory('invoices', f.gymId, { householdId: f.home.id, status: 'open', number });
    const open = await checkout(f, unpaid.id);
    await f.provider.expireCheckout(open.id);
    // Historical sessions fall outside the provider change-list overlap, just as in an older snapshot.
    f.clock.advance(10 * 86400000); const snapshot = f.clock.now(); await f.enable(false);
    const read = vi.spyOn(f.provider, 'readPaymentObject');
    expect((await f.runner.postRestore(f.gymId, snapshot)).readyForOwnerReview).toBe(true);
    expect(read).not.toHaveBeenCalledWith({ kind: 'checkout', id: old.id });
    expect(read).toHaveBeenCalledWith({ kind: 'checkout', id: open.id });
    expect(read).toHaveBeenCalledWith({ kind: 'dispute', id: 'dp_still_open' });
    // Even a locally paid invoice's session is refreshed when it changes after the snapshot.
    await f.provider.completeCheckout(old.id); read.mockClear();
    await f.runner.postRestore(f.gymId, snapshot);
    expect(read).toHaveBeenCalledWith({ kind: 'checkout', id: old.id });
  });
  it.each([true, false])('uses stored processor IDs when optional invoice metadata is missing (unresolved: %s)', async unresolved => {
    const f = await fixture();
    if (unresolved) f.provider.loseNextResponse('confirmCharge');
    await f.runner.daily(f.gymId);
    const find = f.provider.findCharge.bind(f.provider);
    vi.spyOn(f.provider, 'findCharge').mockImplementation(async (ref, options) => {
      const result = await find(ref, options);
      return result.status === 'unknown' ? result : { ...result, metadata: { gymId: f.gymId } };
    });
    await f.enable(false);
    expect((await f.runner.postRestore(f.gymId, f.clock.now())).readyForOwnerReview).toBe(true);
    expect((await f.read()).payments).toHaveLength(1); expect((await f.read()).invoices[0]!.status).toBe('paid');
  });
  it('reports conflicting terminal outcomes instead of silently claiming the charge was applied', async () => {
    const f = await fixture(), confirm = f.provider.confirmCharge.bind(f.provider);
    vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, request) => {
      const outcome = await confirm(id, request);
      return outcome.status === 'unknown' ? outcome : { ...outcome, metadata: { ...outcome.metadata, invoiceId: uuidv7() } };
    });
    expect((await f.runner.daily(f.gymId)).errors).toHaveLength(1);
    expect((await f.read()).attempts[0]!.status).toBe('pending');
    f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId);
    expect((await f.read()).invoices[0]!.status).toBe('paid');
  });
  it('matches dashboard refunds and disputes by PaymentIntent and reads every page beyond thirty days', async () => {
    const f = await fixture(); f.provider.loseNextResponse('confirmCharge'); await f.runner.daily(f.gymId);
    const snapshotAt = f.clock.now(), intentId = (await f.read()).attempts[0]!.paymentIntentId!;
    f.clock.set('2028-05-01T17:00:00Z');
    const refund = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'dashboard_refund' });
    f.provider.recordDispute({ id: 'dp_dashboard', chargeId: intentId, amount: 10000, status: 'open' });
    const list = f.provider.listChangesSince.bind(f.provider);
    const pages = vi.spyOn(f.provider, 'listChangesSince').mockImplementation((since, options) => list(since, { ...options, limit: 1 }));
    const read = f.provider.readPaymentObject.bind(f.provider);
    vi.spyOn(f.provider, 'readPaymentObject').mockImplementation(async ref => {
      const result = await read(ref);
      if (result.status === 'found' && result.value.kind === 'refund') result.value.object = { ...result.value.object, metadata: { gymId: f.gymId } };
      return result;
    });
    await f.enable(false);
    expect(await f.runner.postRestore(f.gymId, snapshotAt)).toMatchObject({ readyForOwnerReview: true, issues: [] });
    expect(pages.mock.calls.length).toBeGreaterThan(1);
    expect(pages.mock.calls[0]![0].toISOString()).toBe('2028-03-01T16:55:00.000Z');
    await f.runner.postRestore(f.gymId, snapshotAt);
    const rows = await f.read();
    expect(rows.payments).toHaveLength(1); expect(rows.refunds).toHaveLength(1);
    expect(rows.refunds[0]!.processorId).toBe(refund.id);
    expect(rows.invoices[0]).toMatchObject({ status: 'partially_refunded', disputeId: 'dp_dashboard', disputeStatus: 'open' });
    expect((await f.settings.get(f.gymId)).billingEnabled).toBe(false);
  });
  it('recovers a snapshot taken before the intent ID was committed, before invalidating empty reservations', async () => {
    const f = await fixture(); f.provider.loseNextResponse('confirmCharge'); await f.runner.daily(f.gymId);
    const row = (await f.read()).attempts[0]!;
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: null }).where(eq(paymentAttempts.id, row.id)));
    f.clock.advance(16 * 60_000); await f.enable(false);
    expect((await f.runner.postRestore(f.gymId, new Date('2028-03-01T17:00:00Z'))).readyForOwnerReview).toBe(true);
    expect((await f.read()).invoices[0]!.status).toBe('paid'); expect((await f.read()).payments).toHaveLength(1);
  });
  it('lists stored intents on a gym without Stripe instead of failing, but fails when settings cannot be read', async () => {
    const f = await fixture(); f.provider.loseNextResponse('confirmCharge'); await f.runner.daily(f.gymId);
    const intent = (await f.read()).attempts[0]!.paymentIntentId!;
    f.clock.advance(16 * 60_000); await f.enable(false);
    const payments = vi.fn(async (): Promise<FakePayments> => { throw new AppError('unavailable', 'Stripe is not configured for this gym'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments });
    const job = createRunnerJobs(() => runner, f.settings, createRestoreCheckLease(() => db.appUrl)).find(job => job.id === 'billing.runner.restore')!;
    const list = vi.spyOn(f.provider, 'listChangesSince');
    expect(await runner.postRestore(f.gymId, new Date('2028-03-01T17:00:00Z'))).toMatchObject({ inspected: 1,
      readyForOwnerReview: false, stripeConfigured: false, issues: expect.arrayContaining([
        { kind: 'charge', id: intent, reason: 'stripe_not_configured' }]) });
    await expect(job.handler({ snapshotAt: '2028-03-01T17:00:00Z' }, f.context)).resolves.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    // The attempt stays pending for a check with Stripe: nothing is guessed from the database alone.
    expect((await f.read()).attempts[0]!.status).toBe('pending');
    payments.mockRejectedValueOnce(new Error('Invalid Stripe configuration'));
    await expect(job.handler({ snapshotAt: '2028-03-01T17:00:00Z' }, f.context)).rejects.toThrow('Invalid Stripe configuration');
  });
  it('keeps unmatched payments paused for manual resolution and rejects a pass while billing is enabled', async () => {
    const f = await fixture();
    await expect(f.runner.postRestore(f.gymId, f.clock.now())).rejects.toThrow('Pause billing');
    const orphan = await f.provider.createCharge({ amount: 10000, currency: 'cad', customerId: 'cus_test', paymentMethodId: 'pm_test',
      invoiceId: uuidv7(), attemptId: uuidv7(), idempotencyKey: 'orphan' });
    await f.provider.confirmCharge(orphan.id, { idempotencyKey: 'orphan:confirm' });
    await f.enable(false);
    expect(await f.runner.postRestore(f.gymId, f.clock.now())).toMatchObject({ readyForOwnerReview: false,
      issues: [{ kind: 'charge', id: orphan.id, reason: 'manual_resolution_required' }] });
    expect((await f.read()).payments).toHaveLength(0);
  });
});
