// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { allocateInvoiceNumber, invoices, paymentAttempts, uuidv7 } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import type { FakePayments } from '../../../infra/payments/index.js';
import { createChargeRunner } from './index.js';
import { createRunnerJobs } from './runner.jobs.js';
import { useRunnerFixture, gate } from './runner.fixture.test-helper.js';

const { db, factory, fixture, checkout } = useRunnerFixture();

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
    await expect(job.handler({}, f.context)).rejects.toThrow('remain unresolved');
    expect(payments).toHaveBeenCalledWith(f.gymId);
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
    const job = createRunnerJobs(() => runner, f.settings).find(job => job.id === 'billing.runner.restore')!;
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
