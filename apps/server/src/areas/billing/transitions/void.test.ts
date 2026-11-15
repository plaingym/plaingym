// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, invoices, memberships, payments, refunds, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { FakeMembershipLifecycle } from '../../../core/interfaces/membership-lifecycle.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { createSignedLinksService } from '../../links/service.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createChargeRunner } from '../runner/index.js';
import { createReconciliation } from '../runner/reconciliation.js';
import { createInvoiceTransitions } from './index.js';
import { createTransitionEffects } from './effects.js';
import { createTransitionJobs } from './transitions.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(status = 'open', kind = 'cycle') {
  const gymId = uuidv7(), clock = new TestClock('2026-11-14T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', timezone: 'UTC', billingEnabled: true, memberEmailsEnabled: true });
  const user = await factory('authUser', gymId), household = await factory('households', gymId, { stripeCustomerId: 'cus_test' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, kind, status, number: status === 'draft' ? null : 1,
    currency: 'USD', dueOn: '2026-11-14', periodStartsOn: '2026-11-14', periodEndsOn: '2026-12-14' });
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } }, options = { scope: db.forGym, clock };
  const transitions = createInvoiceTransitions(options), settings = createGymSettingsAccessor(options);
  const provider = new FakePayments(gymId, clock), jobs = new FakeJobs(clock);
  const notifications = { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}), staffNotice: vi.fn(async () => {}) };
  const retry = vi.fn(async () => {}), effects = createTransitionEffects({ ...options, settings, jobs, transitions, notifications, retry,
    memberships: new FakeMembershipLifecycle(), payments: async () => provider });
  for (const job of createTransitionJobs(() => effects)) jobs.handle(job.id, job.handler);
  const drain = async () => { await effects.publish(gymId); while (await jobs.runNext()) { /* drain due jobs */ } };
  const request = { invoiceId: invoice.id, reason: '  Issued in error  ' };
  const links = createSignedLinksService(options);
  const linkRequest = { purpose: 'pay_invoice' as const, invoiceId: invoice.id, householdId: household.id, expiresAt: '2026-12-01T12:00:00Z' };
  return { gymId, clock, context, options, household, invoice, transitions, settings, provider, jobs, notifications, retry, effects, drain, request, links, linkRequest };
}

describe('staff invoice void with real PostgreSQL', () => {
  it.each(['open', 'past_due'])('voids an %s invoice, revokes only its pay links and audits the reason once', async status => {
    const f = await fixture(status), first = await f.links.create(f.context, f.linkRequest), second = await f.links.create(f.context, f.linkRequest);
    const card = await f.links.create(f.context, { purpose: 'update_card', householdId: f.household.id, expiresAt: f.linkRequest.expiresAt });
    const member = await factory('members', f.gymId, { householdId: f.household.id });
    const plan = await factory('plans', f.gymId, { currency: 'USD' });
    const membership = await factory('memberships', f.gymId, { memberId: member.id, householdId: f.household.id, planId: plan.id,
      currency: 'USD', status: 'active' });
    expect(await f.transitions.voidInvoice(f.context, f.request)).toMatchObject({ outcome: 'applied', invoice: { status: 'void', paidAt: null } });
    expect((await f.transitions.voidInvoice(f.context, f.request)).outcome).toBe('ignored');
    for (const item of [first, second]) {
      expect((await f.links.get(f.gymId, item.link.id)).revokedAt).toBe(f.clock.now().toISOString());
      expect(await f.links.resolve(f.gymId, item.token)).toEqual({ status: 'revoked' });
    }
    expect((await f.links.get(f.gymId, card.link.id)).revokedAt).toBeNull();
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.invoice.voided')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorKind: 'user', actorUserId: f.context.actor.userId,
      before: { status }, after: { status: 'void', reason: 'Issued in error' } });
    expect((await db.forGym(f.gymId, tx => tx.select().from(memberships).where(eq(memberships.id, membership.id))))[0]?.status).toBe('active');
    await expect(f.links.create(f.context, f.linkRequest)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.transitions.manualPayment(f.context, { invoiceId: f.invoice.id, paymentId: uuidv7(), method: 'cash',
      amountCents: f.invoice.amountCents, currency: 'USD', paidAt: f.clock.now().toISOString() })).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['pending', 'requires_action'])('refuses any %s attempt even when a newer attempt has failed', async status => {
    const f = await fixture();
    await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, status, currency: 'USD' });
    await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, status: 'failed', attemptNumber: 2, currency: 'USD' });
    await expect(f.transitions.voidInvoice(f.context, f.request)).rejects.toMatchObject({ code: 'conflict',
      details: { reason: [status === 'pending' ? 'pending_attempt' : 'action_required'] } });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).toEqual([]);
  });
  it.each(['session', 'expired_session', 'reservation'])('refuses a Checkout %s without revoking its links', async kind => {
    const f = await fixture(), link = await f.links.create(f.context, f.linkRequest);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: kind === 'reservation' ? null : 'cs_test',
      checkoutExpiresAt: new Date(kind === 'expired_session' ? '2026-11-13T12:00:00Z' : '2026-11-15T12:00:00Z') }).where(eq(invoices.id, f.invoice.id)));
    await expect(f.transitions.voidInvoice(f.context, f.request)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['checkout_reserved'] } });
    expect((await f.links.get(f.gymId, link.link.id)).revokedAt).toBeNull();
  });
  it.each(['draft', 'processing', 'paid', 'partially_refunded', 'refunded'])('refuses a %s invoice', async status => {
    const f = await fixture(status);
    await expect(f.transitions.voidInvoice(f.context, f.request)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects a blank reason and another gym before writing', async () => {
    const f = await fixture(), other = await fixture();
    await expect(f.transitions.voidInvoice(f.context, { ...f.request, reason: '   ' })).rejects.toThrow();
    await expect(f.transitions.voidInvoice(other.context, f.request)).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).toEqual([]);
  });
  it('serializes concurrent voids and link creation without leaving a payable credential', async () => {
    const f = await fixture();
    await f.links.create(f.context, f.linkRequest);
    const results = await Promise.allSettled([
      f.transitions.voidInvoice(f.context, f.request), f.transitions.voidInvoice(f.context, f.request),
      f.links.create(f.context, f.linkRequest),
    ]);
    for (const entry of results) if (entry.status === 'rejected') expect(entry.reason).toMatchObject({ code: 'conflict' });
    await f.transitions.voidInvoice(f.context, f.request);
    const rows = await f.links.list(f.gymId, { householdId: f.household.id, purpose: 'pay_invoice' });
    expect(rows.data.every(link => link.revokedAt !== null)).toBe(true);
  });
  it('stops queued dunning and retries, and every runner collection mode', async () => {
    const f = await fixture();
    const attempt = await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, paymentIntentId: 'pi_decline', currency: 'USD' });
    await f.transitions.cardFailed(f.context, { invoiceId: f.invoice.id, attemptId: attempt.id, paymentIntentId: 'pi_decline', outcome: 'failed' });
    await f.effects.publish(f.gymId);
    await f.transitions.voidInvoice(f.context, f.request);
    f.clock.advance(8 * 86400_000); await f.drain();
    expect(f.notifications.dunning).not.toHaveBeenCalled(); expect(f.retry).not.toHaveBeenCalled();
    const resolveProvider = vi.fn(async () => f.provider);
    const runner = createChargeRunner({ ...f.options, settings: f.settings, transitions: f.transitions, jobs: f.jobs, payments: resolveProvider });
    for (const request of [{ mode: 'automatic' }, { mode: 'retry' }, { mode: 'staff', context: f.context }] as const)
      expect(await runner.charge(f.gymId, f.invoice.id, request)).toEqual({ status: 'skipped', reason: 'not_payable' });
    expect(resolveProvider).not.toHaveBeenCalled();
  });
  it.each([undefined, 'confirm_abandoned', 'intent_canceled'])('records and refunds a late success once, including %s attempts', async declineCode => {
    const f = await fixture(), attemptId = uuidv7();
    const intent = await f.provider.createCharge({ invoiceId: f.invoice.id, attemptId, amount: f.invoice.amountCents,
      currency: 'usd', customerId: 'cus_test', paymentMethodId: 'pm_test', idempotencyKey: 'late:create' });
    await factory('paymentAttempts', f.gymId, { id: attemptId, invoiceId: f.invoice.id, status: 'failed', currency: 'USD',
      paymentIntentId: intent.id, declineCode: declineCode ?? null });
    await f.transitions.voidInvoice(f.context, f.request);
    const outcome = await f.provider.confirmCharge(intent.id, { idempotencyKey: 'late:confirm' });
    if (outcome.status !== 'succeeded') throw new Error('Expected successful card fixture');
    const request = { invoiceId: f.invoice.id, attemptId, paymentId: uuidv7(), paymentIntentId: intent.id,
      chargeId: outcome.latestChargeId!, amountCents: f.invoice.amountCents, currency: 'USD', paidAt: f.clock.now().toISOString() };
    const refund = vi.spyOn(f.provider, 'refund');
    const reconciliation = createReconciliation({ ...f.options, settings: f.settings, transitions: f.transitions, payments: async () => f.provider });
    expect(await reconciliation.apply(f.gymId, outcome)).toBe(true);
    expect((await f.transitions.cardSucceeded(f.context, request)).outcome).toBe('ignored');
    expect((await f.transitions.cardSucceeded(f.context, { ...request, paymentId: uuidv7() })).outcome).toBe('ignored');
    await f.drain(); await f.drain();
    const stored = await db.forGym(f.gymId, async tx => ({ payments: await tx.select().from(payments), refunds: await tx.select().from(refunds),
      invoice: (await tx.select().from(invoices).where(eq(invoices.id, f.invoice.id)))[0], audits: await tx.select().from(auditEvents) }));
    expect(stored.payments).toHaveLength(1); expect(stored.refunds).toHaveLength(1);
    expect(stored.refunds[0]).toMatchObject({ status: 'succeeded', reason: 'duplicate_payment', amountCents: f.invoice.amountCents });
    expect(stored.invoice).toMatchObject({ status: 'void', paidAt: null });
    expect(stored.audits.find(event => event.action === 'billing.payment.recorded')?.after).toMatchObject({ accepted: false });
    expect(refund).toHaveBeenCalledTimes(1); expect(f.notifications.staffNotice).toHaveBeenCalledTimes(1);
    expect(f.notifications.receipt).not.toHaveBeenCalled(); expect(f.notifications.dunning).not.toHaveBeenCalled();
  });
});
