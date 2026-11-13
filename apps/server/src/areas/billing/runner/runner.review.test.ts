// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, invoices, paymentAttempts, paymentMethods, uuidv7 } from '@plaingym/db';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createChargeRunner } from './index.js';
import { createRunnerJobs } from './runner.jobs.js';
import { createBillingStanding } from '../kiosk-standing.js';
import { useRunnerFixture } from './runner.fixture.test-helper.js';

const { db, factory, fixture, invoice, checkout, oneOff } = useRunnerFixture();

describe('runner review regression cases with PostgreSQL', () => {
  it.each(['revoked', 'customer_changed'] as const)('cancels without confirming when eligibility changes after create: %s', async change => {
    const f = await fixture(), bill = await invoice(f), create = f.provider.createCharge.bind(f.provider);
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      const intent = await create(request);
      await db.forGym(f.gymId, async tx => {
        if (change === 'revoked') await tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false }).where(eq(paymentMethods.householdId, f.home.id));
        else await tx.update(households).set({ stripeCustomerId: 'cus_changed' }).where(eq(households.id, f.home.id));
      });
      return intent;
    });
    const confirm = vi.spyOn(f.provider, 'confirmCharge'), cancel = vi.spyOn(f.provider, 'cancelCharge');
    expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'collection_changed' });
    expect(confirm).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
    const rows = await f.read(); expect(rows.payments).toHaveLength(0);
    // The member never had a chance to pay: no decline, dunning or retries, and the kiosk still lets them in.
    expect(rows.attempts[0]).toMatchObject({ status: 'failed', declineCode: 'confirm_abandoned' });
    expect(rows.invoices.find(row => row.id === bill.id)).toMatchObject({ status: 'open' });
    expect(rows.audits.filter(row => row.action === 'billing.invoice.dunning_started' || row.action === 'billing.invoice.payment_failed'
      || row.action === 'billing.transition.effect.created')).toEqual([]);
    expect(await createBillingStanding(db.forGym).check({ gymId: f.gymId, memberId: f.member.id, clock: f.clock })).toEqual({ status: 'ok' });
    // The next daily run collects it once the household is chargeable again.
    await db.forGym(f.gymId, async tx => {
      await tx.update(households).set({ stripeCustomerId: 'cus_test' }).where(eq(households.id, f.home.id));
      await tx.update(paymentMethods).set({ revokedAt: null, isDefault: true }).where(eq(paymentMethods.householdId, f.home.id));
    });
    f.clock.set('2028-03-02T17:00:00Z'); expect((await f.runner.daily(f.gymId)).attempted).toBe(1);
    // The run also generates the next cycle invoice, which can share the bill's due date.
    expect((await f.read()).invoices.find(row => row.id === bill.id)).toMatchObject({ status: 'paid' });
  });
  it('does not cancel an intent already saved by another caller after losing compare-and-set', async () => {
    const f = await fixture(), bill = await invoice(f), create = f.provider.createCharge.bind(f.provider);
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      const intent = await create(request);
      await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: intent.id }).where(eq(paymentAttempts.id, request.attemptId!)));
      return intent;
    });
    const cancel = vi.spyOn(f.provider, 'cancelCharge'), confirm = vi.spyOn(f.provider, 'confirmCharge');
    expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'reservation_lost' });
    expect(cancel).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect((await f.read()).attempts[0]).toMatchObject({ status: 'pending', resolvedAt: null });
  });
  it('zero settlement respects enablement and review holds, and never touches an attached Checkout', async () => {
    const f = await fixture({ enabled: false }), bill = await invoice(f);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ amountCents: 0, needsReview: true, checkoutSessionId: 'cs_not_touched' })
      .where(eq(invoices.id, bill.id)));
    const provider = vi.fn(async () => { throw new Error('Unexpected provider call'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: provider });
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'billing_disabled' });
    await f.enable(true);
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'needs_review' });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ needsReview: false }).where(eq(invoices.id, bill.id)));
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'settled_zero' });
    expect(provider).not.toHaveBeenCalled(); expect((await f.read()).attempts).toHaveLength(0);
  });
  it.each(['no_saved_card', 'pending_attempt', 'already_attempted', 'needs_review', 'not_due'] as const)(
    'checks %s before touching Checkout or resolving a provider', async reason => {
      const f = await fixture(), bill = await oneOff(f, 'membership'); await checkout(f, bill.id);
      await db.forGym(f.gymId, async tx => {
        if (reason === 'no_saved_card') await tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.householdId, f.home.id));
        if (reason === 'needs_review') await tx.update(invoices).set({ needsReview: true }).where(eq(invoices.id, bill.id));
        if (reason === 'not_due') await tx.update(invoices).set({ dueOn: '2028-04-01' }).where(eq(invoices.id, bill.id));
      });
      if (reason === 'pending_attempt' || reason === 'already_attempted') await factory('paymentAttempts', f.gymId,
        { invoiceId: bill.id, status: reason === 'pending_attempt' ? 'pending' : 'failed' });
      const provider = vi.fn(async () => f.provider), expire = vi.spyOn(f.provider, 'expireCheckout');
      const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: provider });
      expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason });
      expect((await runner.daily(f.gymId)).errors).toEqual([]);
      expect(expire).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    });
  it('rechecks Checkout identity under the reservation lock', async () => {
    const f = await fixture(), bill = await oneOff(f, 'membership'); const session = await checkout(f, bill.id);
    const expire = f.provider.expireCheckout.bind(f.provider);
    vi.spyOn(f.provider, 'expireCheckout').mockImplementationOnce(async id => {
      const result = await expire(id);
      await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: 'cs_replaced' }).where(eq(invoices.id, bill.id)));
      return result;
    });
    expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'checkout_changed' });
    expect((await f.read()).attempts).toHaveLength(0); expect(session.id).not.toBe('cs_replaced');
  });
  it.each(['paid', 'void'])('keeps a %s historical cycle unchanged while holding the late membership and advancing to the next cycle', async status => {
    const f = await fixture({ now: '2028-04-01T17:00:00Z' }); const old = await invoice(f);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status }).where(eq(invoices.id, old.id)));
    await f.runner.daily(f.gymId); await f.runner.daily(f.gymId);
    const rows = await f.read();
    expect(rows.invoices).toHaveLength(3);
    expect(rows.invoices.find(row => row.id === old.id)).toMatchObject({ status, needsReview: false });
    expect(rows.invoices.find(row => row.kind === 'one_off')).toMatchObject({ status: 'open', needsReview: true, dueOn: '2028-03-01' });
    expect(rows.invoices.find(row => row.dueOn === '2028-04-01')).toMatchObject({ status: 'paid', kind: 'cycle' });
    expect(rows.memberships[0]!.nextDueOn).toBe('2028-05-01');
    expect(rows.audits.filter(row => row.action === 'billing.runner.cycle_conflict')).toHaveLength(1);
  });
  it.each(['cancel', 'succeeded'])('resolves an action-needed intent before a retry: %s', async outcome => {
    const f = await fixture(); f.provider.respondNextConfirmation('authentication_required'); await f.runner.daily(f.gymId);
    const first = (await f.read()).attempts[0]!;
    if (outcome === 'succeeded') await f.provider.confirmCharge(first.paymentIntentId!, { idempotencyKey: 'completed_authentication' });
    const cancel = vi.spyOn(f.provider, 'cancelCharge'), create = vi.spyOn(f.provider, 'createCharge');
    f.clock.set('2028-03-04T17:00:00Z'); await f.runner.retry(first.invoiceId, f.context);
    expect(cancel).toHaveBeenCalledWith(first.paymentIntentId);
    expect(create).toHaveBeenCalledTimes(outcome === 'cancel' ? 1 : 0);
    const rows = await f.read(); expect(rows.invoices[0]!.status).toBe('paid'); expect(rows.payments).toHaveLength(1);
    expect(rows.attempts).toHaveLength(outcome === 'cancel' ? 2 : 1);
    if (outcome === 'cancel') expect(rows.attempts[0]!.declineCode).toBe('intent_canceled');
  });
  it('allows an audited staff charge after a declined one-off, without dunning', async () => {
    const f = await fixture(), bill = await oneOff(f), user = await factory('authUser', f.gymId);
    const request = { mode: 'staff' as const, context: { gymId: f.gymId, actor: { kind: 'user' as const, userId: user.id } } };
    f.provider.respondNextConfirmation('declined');
    expect(await f.runner.charge(f.gymId, bill.id, request)).toEqual({ status: 'failed' });
    expect((await f.read()).invoices[0]!.status).toBe('open');
    expect(await f.runner.charge(f.gymId, bill.id, request)).toEqual({ status: 'succeeded' });
    const rows = await f.read(); expect(rows.attempts).toHaveLength(2);
    expect(rows.audits.filter(row => row.action === 'billing.runner.reserved').every(row => row.actorUserId === user.id)).toBe(true);
    expect(rows.audits.find(row => row.action === 'billing.invoice.paid')!.actorUserId).toBe(user.id);
    expect(rows.audits.some(row => row.action === 'billing.invoice.dunning_started')).toBe(false);
    await expect(f.runner.charge(f.gymId, bill.id, { ...request, context: { ...request.context, gymId: uuidv7() } })).rejects.toThrow('actor');
  });
  it.each(['billing.runner.daily', 'billing.runner.reconcile'])('fails loudly for enabled gyms when %s is not configured', async id => {
    const enabled = await fixture(), disabled = await fixture({ enabled: false });
    const settings = createGymSettingsAccessor({ scope: db.forGym });
    const job = createRunnerJobs(() => undefined, settings).find(job => job.id === id)!;
    await expect(job.handler({}, enabled.context)).rejects.toThrow('Charge runner is not configured');
    await expect(job.handler({}, disabled.context)).resolves.toBeUndefined();
  });
  it.each(['won', 'lost', 'closed'])('preserves terminal %s disputes, rejects another dispute, and audits before/after', async terminal => {
    const f = await fixture(); await f.runner.daily(f.gymId); await f.enable(false);
    const intentId = (await f.read()).attempts[0]!.paymentIntentId!;
    f.provider.recordDispute({ id: 'dp_original', chargeId: intentId, amount: 10000, status: 'open' });
    await f.runner.postRestore(f.gymId, f.clock.now());
    f.provider.recordDispute({ id: 'dp_original', chargeId: intentId, amount: 10000, status: terminal as 'won' | 'lost' | 'closed' });
    await f.runner.postRestore(f.gymId, f.clock.now());
    f.provider.recordDispute({ id: 'dp_original', chargeId: intentId, amount: 10000, status: 'open' });
    f.provider.recordDispute({ id: 'dp_other', chargeId: intentId, amount: 10000, status: 'open' });
    const result = await f.runner.postRestore(f.gymId, f.clock.now());
    expect(result.readyForOwnerReview).toBe(false); expect(result.issues).toContainEqual({ kind: 'dispute', id: 'dp_other', reason: 'manual_resolution_required' });
    const rows = await f.read(); expect(rows.invoices[0]).toMatchObject({ disputeId: 'dp_original', disputeStatus: terminal });
    const audits = rows.audits.filter(row => row.action === 'billing.invoice.disputed');
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ before: { disputeId: null, disputeStatus: null }, after: { disputeId: 'dp_original', disputeStatus: 'open', paymentId: rows.payments[0]!.id } }),
      expect.objectContaining({ before: { disputeId: 'dp_original', disputeStatus: 'open' }, after: { disputeId: 'dp_original', disputeStatus: terminal, paymentId: rows.payments[0]!.id } }),
    ]));
  });
});
