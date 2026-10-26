// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, invoices, memberships, paymentAttempts, payments, refunds, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Scenario assertions read durable jobs through the test gym's RLS scope.
import { jobs } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { zonedInstant } from '@plaingym/shared/time';
import { TestClock } from '../../../core/clock.js';
import type { CardFailure, CardSuccess, InvoiceSnapshot, RefundTransition } from '../../../core/interfaces/invoice-transitions.js';
import { FakeEmail } from '../../../infra/email/index.js';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createMembershipService } from '../memberships.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { createTransitionEffects, effectJob } from '../transitions/effects.js';
import { createTransitionNotifications } from '../transitions/notifications.js';
import { createTransitionJobs } from '../transitions/transitions.jobs.js';
import { effectCompleted, effectCreated, effectPublished, paymentRecorded, type TransitionEffect } from '../transitions/store.js';

const db = useTestDatabase(), factory = createFactories(db);
// This file has its own database; workers must not claim a previous scenario's queued work.
beforeEach(async () => { await db.forSystem(tx => tx.delete(jobs)); });

/** Real transitions and effect publisher; external email/payment providers are the only fakes. */
async function fixture(kind: InvoiceSnapshot['kind'] = 'cycle', paid = false) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'CAD', timezone: 'America/Vancouver', billingEnabled: true, memberEmailsEnabled: true });
  const clock = new TestClock('2028-03-01T20:00:00Z');
  const context = { gymId, actor: { kind: 'system' as const } };
  const household = await factory('households', gymId, { email: 'payer@example.invalid' });
  const member = await factory('members', gymId, { householdId: household.id, email: household.email });
  const plan = await factory('plans', gymId, { amountCents: 10_000, currency: 'CAD' });
  const membership = await factory('memberships', gymId, { householdId: household.id, memberId: member.id, planId: plan.id,
    status: paid ? 'active' : 'pending', amountCents: plan.amountCents, currency: plan.currency,
    startsOn: '2028-03-01', nextDueOn: '2028-03-01' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, number: 1, kind,
    status: paid ? 'paid' : 'open', amountCents: 10_000, currency: 'CAD', paidAt: paid ? clock.now() : null,
    dueOn: '2028-03-01', periodStartsOn: '2028-03-01', periodEndsOn: '2028-04-01' });
  await factory('invoiceLineItems', gymId, { householdId: household.id, invoiceId: invoice.id, membershipId: membership.id,
    kind: 'membership', amountCents: invoice.amountCents, currency: invoice.currency });
  const provider = new FakePayments(gymId, clock), email = new FakeEmail(), attemptId = uuidv7();
  const intent = await provider.createCharge({ invoiceId: invoice.id, attemptId, amount: invoice.amountCents,
    currency: invoice.currency.toLowerCase(), customerId: 'cus_test', paymentMethodId: 'pm_test', idempotencyKey: invoice.id + ':1:create' });
  const confirmed = await provider.confirmCharge(intent.id, { idempotencyKey: invoice.id + ':1:confirm' });
  if (confirmed.status !== 'succeeded' || !confirmed.latestChargeId) throw new Error('Scenario charge did not succeed');
  const attempt = await factory('paymentAttempts', gymId, { id: attemptId, invoiceId: invoice.id,
    amountCents: invoice.amountCents, currency: invoice.currency, paymentIntentId: intent.id, status: paid ? 'succeeded' : 'pending' });
  const success: CardSuccess = { invoiceId: invoice.id, attemptId: attempt.id, paymentId: uuidv7(),
    paymentIntentId: intent.id, chargeId: confirmed.latestChargeId, paidAt: clock.now().toISOString(), amountCents: invoice.amountCents, currency: 'CAD' };
  // A restored/older payment has no attribution audit; refund transitions must still accept it.
  if (paid) await factory('payments', gymId, { id: success.paymentId, invoiceId: invoice.id, method: 'card',
    amountCents: invoice.amountCents, currency: invoice.currency,
    paymentIntentId: success.paymentIntentId, chargeId: success.chargeId, paidAt: clock.now() });
  const options = { scope: db.forGym, clock }, queue = new PostgresJobs({ database: db, clock });
  const settings = createGymSettingsAccessor({ scope: db.forGym });
  const transitions = createInvoiceTransitions({ ...options, afterCommit: gym => effects.publish(gym) });
  const retry = vi.fn(async () => { throw new Error('This scenario requires the charge runner to execute retries'); });
  const effects = createTransitionEffects({ ...options, jobs: queue, settings, transitions,
    memberships: createMembershipService({ ...options, settings }),
    async payments() { return provider; },
    notifications: createTransitionNotifications({ ...options, settings,
      async prepare() { return { email, origin: 'https://gym.example.invalid' }; },
      async staffRecipients() { return ['staff@example.invalid']; } }),
    retry });
  for (const job of createTransitionJobs(() => effects)) queue.handle(job.id, job.handler);
  const failure: CardFailure = { invoiceId: invoice.id, attemptId: attempt.id, paymentIntentId: intent.id, outcome: 'failed' };
  const read = () => db.forGym(gymId, async tx => ({
    invoice: (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)))[0]!,
    membership: (await tx.select().from(memberships).where(eq(memberships.id, membership.id)))[0]!,
    attempts: await tx.select().from(paymentAttempts).orderBy(asc(paymentAttempts.attemptNumber)),
    payments: await tx.select().from(payments).orderBy(asc(payments.id)),
    refunds: await tx.select().from(refunds).orderBy(asc(refunds.id)),
    audits: await tx.select().from(auditEvents).orderBy(asc(auditEvents.id)),
    jobs: await tx.select().from(jobs).orderBy(asc(jobs.id)),
  }));
  const drain = async () => {
    for (let count = 0; count < 20; count++) if (!await queue.runNext()) return count;
    throw new Error('Scenario queue did not finish within 20 jobs');
  };
  return { clock, context, invoice, membership, transitions, provider, email, retry, success, failure, read, drain };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type State = Awaited<ReturnType<Fixture['read']>>;
function expectWork(state: State, kinds: TransitionEffect['kind'][], completed = false) {
  const created = state.audits.filter(row => row.action === effectCreated);
  expect(created.map(row => (row.after as TransitionEffect).kind).sort()).toEqual([...kinds].sort());
  expect(state.audits.filter(row => row.action === effectPublished).map(row => row.targetId).sort())
    .toEqual(created.map(row => row.targetId).sort());
  expect(state.jobs).toHaveLength(kinds.length);
  for (const row of created) expect(state.jobs).toContainEqual(expect.objectContaining({ name: effectJob,
    status: completed && (row.after as TransitionEffect).kind !== 'retry' ? 'succeeded' : 'pending',
    payload: { version: 1, timezone: 'America/Vancouver', value: { effectId: row.targetId } } }));
  if (completed) expect(state.audits.filter(row => row.action === effectCompleted).map(row => row.targetId).sort())
    .toEqual(created.filter(row => (row.after as TransitionEffect).kind !== 'retry').map(row => row.targetId).sort());
}
function expectActivation(f: Fixture, state: State) {
  expect(state.membership).toMatchObject({ status: 'active', revision: f.membership.revision + 1 });
  expect(state.audits.filter(row => row.action === 'billing.membership.activated'))
    .toMatchObject([{ targetId: f.membership.id }]);
}

describe('billing scenarios: PostgreSQL invoice transitions and published effects', () => {
  // These are transition inputs from independent callers, not an inbox/runner integration.
  it('keeps the first caller\'s local payment ID when success is replayed and runs its follow-up work once', async () => {
    const f = await fixture();
    const replay = { ...f.success, paymentId: uuidv7() };
    expect((await f.transitions.cardSucceeded(f.context, f.success)).outcome).toBe('applied');
    expect((await f.transitions.cardSucceeded(f.context, replay)).outcome).toBe('ignored');
    const state = await f.read();
    expect(state.payments).toMatchObject([{ id: f.success.paymentId, paymentIntentId: f.success.paymentIntentId,
      chargeId: f.success.chargeId, amountCents: f.invoice.amountCents }]);
    expectWork(state, ['receipt', 'activate_memberships']);
    expect(state.audits.filter(row => row.action === paymentRecorded)).toHaveLength(1);
    expect(state.audits.filter(row => row.action === 'billing.invoice.paid')).toHaveLength(1);
    expect(state.attempts).toMatchObject([{ status: 'succeeded' }]);
    expect(state.invoice).toMatchObject({ status: 'paid', paidAt: new Date(f.success.paidAt) });
    expect(state.membership.status).toBe('pending');
    expect(await f.drain()).toBe(2);
    await f.transitions.cardSucceeded(f.context, replay);
    expect(await f.drain()).toBe(0);
    expect(f.email.messages).toMatchObject([{ to: 'payer@example.invalid', subject: 'Receipt for invoice 1' }]);
    const after = await f.read();
    expectActivation(f, after);
    expectWork(after, ['receipt', 'activate_memberships'], true);
  });

  it('serializes concurrent caller successes into one payment, receipt and membership activation', async () => {
    const f = await fixture(), requests = [f.success, { ...f.success, paymentId: uuidv7() }];
    const results = await Promise.all(requests.map(request => f.transitions.cardSucceeded(f.context, request)));
    expect(results.map(result => result.outcome).sort()).toEqual(['applied', 'ignored']);
    const state = await f.read();
    expect(state.payments).toMatchObject([{ id: requests[results.findIndex(result => result.outcome === 'applied')]!.paymentId }]);
    expect(state.invoice.status).toBe('paid');
    expectWork(state, ['receipt', 'activate_memberships']);
    expect(await f.drain()).toBe(2);
    await Promise.all(requests.map(request => f.transitions.cardSucceeded(f.context, request)));
    expect(await f.drain()).toBe(0);
    expect(f.email.messages).toMatchObject([{ to: 'payer@example.invalid', subject: 'Receipt for invoice 1' }]);
    const after = await f.read();
    expectActivation(f, after);
    expectWork(after, ['receipt', 'activate_memberships'], true);
  });

  it.each(['failed', 'requires_action'] as const)('deduplicates a cycle %s result and requests dunning once', async outcome => {
    const f = await fixture(), failure: CardFailure = { ...f.failure, outcome };
    expect(await f.transitions.cardFailed(f.context, failure)).toMatchObject({ outcome: 'applied', invoice: { status: 'past_due' } });
    expect(await f.transitions.cardFailed(f.context, failure)).toMatchObject({ outcome: 'ignored' });
    const state = await f.read();
    expectWork(state, ['dunning', 'retry', 'retry']);
    expect(state.jobs.map(job => job.runAt).sort((a, b) => a.getTime() - b.getTime())).toEqual([
      f.clock.now(), zonedInstant('2028-03-04', '09:00', 'America/Vancouver', { gap: 'shift' }),
      zonedInstant('2028-03-08', '09:00', 'America/Vancouver', { gap: 'shift' }),
    ]);
    expect(state.audits.filter(row => row.action === 'billing.invoice.dunning_started')).toHaveLength(1);
    expect(state.attempts).toMatchObject([{ status: outcome }]);
    expect(state.payments).toEqual([]);
    expect(await f.drain()).toBe(1);
    await f.transitions.cardFailed(f.context, failure);
    expect(await f.drain()).toBe(0);
    expect(f.email.messages).toMatchObject([{ to: 'payer@example.invalid',
      subject: outcome === 'requires_action' ? 'Authentication needed for invoice 1' : 'Payment needed for invoice 1' }]);
    expectWork(await f.read(), ['dunning', 'retry', 'retry'], true);
    expect(f.retry).not.toHaveBeenCalled();
  });

  it.each(['failed', 'requires_action'] as const)('leaves a one-off %s open and never requests dunning', async outcome => {
    const f = await fixture('one_off');
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome });
    f.clock.set('2028-03-15T20:00:00Z');
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome });
    const state = await f.read();
    expect(state.invoice.status).toBe('open');
    expect(state.attempts).toMatchObject([{ status: outcome }]);
    expectWork(state, []);
    expect(state.payments).toEqual([]);
  });

  it.each(['failed', 'requires_action', 'canceled'] as const)('never un-pays a paid invoice after a late %s for the same attempt', async outcome => {
    const f = await fixture();
    await f.transitions.cardSucceeded(f.context, f.success);
    f.clock.set('2028-03-15T19:00:00Z');
    expect(await f.transitions.cardFailed(f.context, { ...f.failure, outcome })).toMatchObject({ outcome: 'ignored', invoice: { status: 'paid', paidAt: f.success.paidAt } });
    const state = await f.read();
    expectWork(state, ['receipt', 'activate_memberships']);
    expect(state.invoice).toMatchObject({ status: 'paid', paidAt: new Date(f.success.paidAt) });
    expect(state.attempts).toMatchObject([{ status: 'succeeded' }]);
  });

  it('ignores an older attempt failure after a retry succeeds', async () => {
    const f = await fixture();
    await f.transitions.cardFailed(f.context, f.failure);
    f.clock.set('2028-03-04T20:00:00Z');
    const retry = await factory('paymentAttempts', f.context.gymId, { invoiceId: f.invoice.id, attemptNumber: 2,
      amountCents: f.invoice.amountCents, currency: f.invoice.currency, paymentIntentId: 'pi_retry', status: 'pending' });
    await f.transitions.cardSucceeded(f.context, { ...f.success, attemptId: retry.id, paymentId: uuidv7(),
      paymentIntentId: 'pi_retry', chargeId: 'ch_retry', paidAt: f.clock.now().toISOString() });
    const before = await f.read();
    await f.transitions.cardFailed(f.context, f.failure);
    expect(await f.read()).toEqual(before);
    expect(before.invoice.status).toBe('paid');
    expect(before.payments).toMatchObject([{ paymentIntentId: 'pi_retry' }]);
    expect(before.attempts).toMatchObject([{ status: 'failed' }, { status: 'succeeded' }]);
    expectWork(before, ['dunning', 'retry', 'retry', 'receipt', 'activate_memberships']);
  });

  it('applies a success after a failure without allowing failure replay to downgrade it', async () => {
    const f = await fixture();
    await f.transitions.cardFailed(f.context, f.failure);
    await f.transitions.cardSucceeded(f.context, f.success);
    await f.transitions.cardFailed(f.context, f.failure);
    const state = await f.read();
    expect(state.invoice.status).toBe('paid');
    expect(state.payments).toHaveLength(1);
    expectWork(state, ['dunning', 'retry', 'retry', 'receipt', 'activate_memberships']);
  });

  it('never resurrects an intent cancelled by reconciliation', async () => {
    const f = await fixture();
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome: 'canceled' });
    expect(await f.transitions.cardSucceeded(f.context, f.success)).toMatchObject({ outcome: 'ignored', invoice: { status: 'past_due' } });
    const state = await f.read();
    expect(state.payments).toEqual([]);
    expect(state.attempts).toMatchObject([{ status: 'failed', declineCode: 'intent_canceled' }]);
    expectWork(state, ['dunning', 'retry', 'retry']);
  });

  it.each(['cash', 'check'] as const)('records %s once and reserves a refund for a late Checkout payment without paying twice', async method => {
    const f = await fixture();
    const manual = { invoiceId: f.invoice.id, paymentId: uuidv7(), amountCents: 10_000, currency: 'CAD',
      paidAt: f.clock.now().toISOString(), method };
    await f.transitions.manualPayment(f.context, manual);
    expect((await f.transitions.manualPayment(f.context, manual)).outcome).toBe('ignored');
    const checkoutSuccess: CardSuccess = { invoiceId: f.invoice.id, paymentId: f.success.paymentId,
      paymentIntentId: f.success.paymentIntentId, chargeId: f.success.chargeId, paidAt: f.success.paidAt,
      amountCents: f.success.amountCents, currency: f.success.currency };
    expect(await f.transitions.cardSucceeded(f.context, checkoutSuccess)).toMatchObject({ outcome: 'duplicate_payment', invoice: { status: 'paid' } });
    await f.transitions.cardSucceeded(f.context, checkoutSuccess);
    const state = await f.read();
    expect(state.payments).toHaveLength(2);
    expect(state.payments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manual.paymentId, method }),
      expect.objectContaining({ id: f.success.paymentId, method: 'card' }),
    ]));
    const recorded = state.audits.filter(row => row.action === paymentRecorded);
    expect(recorded).toHaveLength(2);
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: manual.paymentId, after: expect.objectContaining({ accepted: true }) }),
      expect.objectContaining({ targetId: f.success.paymentId, after: expect.objectContaining({ accepted: false }) }),
    ]));
    expect(state.refunds).toMatchObject([{ paymentId: f.success.paymentId, amountCents: 10_000, status: 'pending', reason: 'duplicate_payment' }]);
    expect(state.invoice.status).toBe('paid');
    expectWork(state, ['receipt', 'activate_memberships', 'refund_duplicate', 'staff_notice']);
    const refund = vi.spyOn(f.provider, 'refund');
    expect(await f.drain()).toBe(4);
    await f.transitions.manualPayment(f.context, manual);
    await f.transitions.cardSucceeded(f.context, checkoutSuccess);
    expect(await f.drain()).toBe(0);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith({ chargeId: f.success.paymentIntentId, amount: f.invoice.amountCents,
      idempotencyKey: `invoice:${f.invoice.id}:duplicate:${f.success.paymentId}` });
    expect(f.email.messages).toHaveLength(2);
    expect(f.email.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: 'payer@example.invalid', subject: 'Receipt for invoice 1' }),
      expect.objectContaining({ to: 'staff@example.invalid', subject: 'Duplicate payment for invoice 1' }),
    ]));
    const after = await f.read();
    expect(after.refunds).toMatchObject([{ paymentId: f.success.paymentId, amountCents: f.invoice.amountCents, status: 'succeeded' }]);
    expect(after.invoice.status).toBe('paid');
    expectActivation(f, after);
    expectWork(after, ['receipt', 'activate_memberships', 'refund_duplicate', 'staff_notice'], true);
  });

  it.each(['card success', 'restored payment'] as const)('reserves partial then full refunds once and ignores late failures: %s', async origin => {
    const f = await fixture('cycle', origin === 'restored payment');
    if (origin === 'card success') await f.transitions.cardSucceeded(f.context, f.success);
    const partial: RefundTransition = { invoiceId: f.invoice.id, paymentId: f.success.paymentId,
      refundId: uuidv7(), processorId: 're_partial', amountCents: 3000, currency: 'CAD', status: 'pending' };
    expect((await f.transitions.refund(f.context, partial)).invoice.status).toBe('paid');
    expect((await f.read()).refunds).toMatchObject([{ id: partial.refundId, status: 'pending', resolvedAt: null }]);
    expect((await f.transitions.refund(f.context, { ...partial, status: 'succeeded' })).invoice.status).toBe('partially_refunded');
    expect((await f.transitions.refund(f.context, { ...partial, status: 'succeeded' })).outcome).toBe('ignored');
    const rest: RefundTransition = { ...partial, refundId: uuidv7(), processorId: 're_rest', amountCents: 7000, status: 'succeeded' };
    expect((await f.transitions.refund(f.context, rest)).invoice.status).toBe('refunded');
    await f.transitions.refund(f.context, { ...rest, status: 'failed' });
    await f.transitions.cardFailed(f.context, f.failure);
    const state = await f.read();
    expect(state.invoice.status).toBe('refunded');
    expect(state.refunds).toHaveLength(2);
    expect(state.refunds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: partial.refundId, status: 'succeeded', amountCents: 3000, resolvedAt: f.clock.now() }),
      expect.objectContaining({ id: rest.refundId, status: 'succeeded', amountCents: 7000, resolvedAt: f.clock.now() }),
    ]));
    expect(state.audits.filter(row => row.action === 'billing.refund.recorded')).toHaveLength(3);
    expect(state.audits.filter(row => row.action === 'billing.invoice.refunded')).toHaveLength(2);
    expect(state.audits.filter(row => row.action === paymentRecorded)).toHaveLength(origin === 'card success' ? 1 : 0);
    expectWork(state, origin === 'card success' ? ['receipt', 'activate_memberships'] : []);
  });

  it.each(['card success', 'restored payment'] as const)('a failed refund leaves the invoice paid and releases its reservation: %s', async origin => {
    const f = await fixture('cycle', origin === 'restored payment');
    if (origin === 'card success') await f.transitions.cardSucceeded(f.context, f.success);
    const request: RefundTransition = { invoiceId: f.invoice.id, paymentId: f.success.paymentId,
      refundId: uuidv7(), amountCents: 10_000, currency: 'CAD', status: 'pending' };
    const nextId = uuidv7();
    await f.transitions.refund(f.context, request);
    await expect(f.transitions.refund(f.context, { ...request, refundId: nextId, amountCents: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.transitions.refund(f.context, { ...request, status: 'failed' })).invoice.status).toBe('paid');
    expect((await f.read()).invoice.status).toBe('paid');
    expect((await f.transitions.refund(f.context, { ...request, refundId: nextId, status: 'succeeded' })).invoice.status).toBe('refunded');
    const state = await f.read();
    expect(state.refunds).toHaveLength(2);
    expect(state.refunds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: request.refundId, status: 'failed', amountCents: 10_000 }),
      expect.objectContaining({ id: nextId, status: 'succeeded', amountCents: 10_000 }),
    ]));
    expect(state.payments).toHaveLength(1);
    expect(state.audits.filter(row => row.action === 'billing.refund.recorded')).toHaveLength(3);
    expect(state.audits.filter(row => row.action === paymentRecorded)).toHaveLength(origin === 'card success' ? 1 : 0);
    expectWork(state, origin === 'card success' ? ['receipt', 'activate_memberships'] : []);
  });
});
