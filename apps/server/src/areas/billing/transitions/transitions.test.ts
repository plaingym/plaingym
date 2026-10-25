// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { auditEvents, invoiceLineItems, invoices, members, memberships, paymentAttempts, payments, refunds, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { setLogSink } from '../../../core/log.js';
import { FakePayments, normalizeChargeOutcome } from '../../../infra/payments/index.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakeEmail } from '../../../infra/email/index.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { replayTransport } from '../../../infra/payments/transport.js';
import type { Tape } from '../../../infra/payments/recording.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createMembershipService } from '../memberships.js';
import { createSignedLinksService } from '../../links/service.js';
import { createInvoiceTransitions } from './index.js';
import { createTransitionEffects } from './effects.js';
import { createTransitionJobs } from './transitions.jobs.js';
import { createTransitionNotifications } from './notifications.js';
import { applyChargeOutcome } from './outcomes.js';
import { effectCreated, effectCompleted } from './store.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(kind: 'cycle' | 'one_off' = 'cycle') {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'CAD', timezone: 'America/Vancouver', billingEnabled: true, memberEmailsEnabled: true });
  const clock = new TestClock('2028-03-10T17:00:00Z'), context = { gymId, actor: { kind: 'system' as const } };
  const household = await factory('households', gymId, { email: 'payer@example.invalid' });
  const member = await factory('members', gymId, { householdId: household.id, email: household.email });
  const plan = await factory('plans', gymId);
  const membership = await factory('memberships', gymId, { householdId: household.id, memberId: member.id, planId: plan.id });
  const invoice = await factory('invoices', gymId, { householdId: household.id, kind, status: 'processing', number: 1,
    dueOn: '2028-03-10', periodStartsOn: '2028-03-10', periodEndsOn: '2028-04-10' });
  await factory('invoiceLineItems', gymId, { householdId: household.id, invoiceId: invoice.id, membershipId: membership.id, kind: 'membership' });
  const provider = new FakePayments(gymId, clock);
  const attemptId = uuidv7();
  const intent = await provider.createCharge({ amount: invoice.amountCents, currency: 'cad', customerId: 'cus_test', paymentMethodId: 'pm_test',
    invoiceId: invoice.id, attemptId, idempotencyKey: `${invoice.id}:1:create` });
  const attempt = await factory('paymentAttempts', gymId, { id: attemptId, invoiceId: invoice.id, paymentIntentId: intent.id });
  const options = { scope: db.forGym, clock }, transitions = createInvoiceTransitions(options);
  const settings = createGymSettingsAccessor({ scope: db.forGym });
  const lifecycle = createMembershipService({ ...options, settings });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), retry = vi.fn(async () => {});
  const notifications = createTransitionNotifications({ ...options, settings,
    async prepare() { return { email, origin: 'https://gym.example.invalid' }; }, async staffRecipients() { return ['staff@example.invalid']; } });
  const effectOptions = { ...options, jobs, settings, transitions, memberships: lifecycle, async payments() { return provider; }, notifications, retry };
  const effects = createTransitionEffects(effectOptions);
  for (const job of createTransitionJobs(() => effects)) jobs.handle(job.id, job.handler);
  const success = { invoiceId: invoice.id, paymentId: uuidv7(), attemptId, paymentIntentId: intent.id,
    chargeId: 'ch_' + intent.id, amountCents: invoice.amountCents, currency: 'CAD', paidAt: clock.now().toISOString() };
  const failure = { invoiceId: invoice.id, attemptId, paymentIntentId: intent.id, outcome: 'failed' as const };
  const manual = { invoiceId: invoice.id, paymentId: uuidv7(), amountCents: invoice.amountCents, currency: 'CAD',
    paidAt: clock.now().toISOString(), method: 'cash' as const, reference: 'receipt-1' };
  const read = async () => db.forGym(gymId, async tx => ({
    invoice: (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)))[0]!,
    payments: await tx.select().from(payments), refunds: await tx.select().from(refunds), attempts: await tx.select().from(paymentAttempts),
    audits: await tx.select().from(auditEvents),
  }));
  const drain = async () => { await effects.publish(gymId); while (await jobs.runNext()) { /* all currently due work */ } };
  return { gymId, clock, context, household, member, membership, invoice, provider, attempt, options, transitions, settings,
    lifecycle, jobs, email, retry, notifications, effectOptions, effects, success, failure, manual, read, drain };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const stateEvents = (f: Awaited<ReturnType<Fixture['read']>>) => f.audits.filter(a => a.targetType === 'invoice' && a.action !== 'billing.invoice.dunning_started');
async function succeed(f: Fixture) { await f.provider.confirmCharge(f.success.paymentIntentId, { idempotencyKey: `${f.invoice.id}:1:confirm` }); }

describe('invoice transitions with real PostgreSQL', () => {
  it.each(['4242', '0341', '3184'])('applies the recorded synthetic Stripe API fixture for card %s through the real adapter', async card => {
    const f = await fixture();
    const stored = JSON.parse(await readFile(new URL('../../../infra/payments/stripe.synthetic.json', import.meta.url), 'utf8')) as { tapes: Record<string, Tape> };
    // Bind only fixture identifiers and money to this test's isolated gym; preserve all provider lifecycle data.
    const tape = JSON.parse(JSON.stringify(stored.tapes[`extended > normalizes card ${card} after the setup fixture`]), (key, value: unknown) => {
      if (key === 'attempt_id') return f.attempt.id;
      if (key === 'amount') return 10000;
      if (key === 'currency') return 'cad';
      return typeof value === 'string' ? value.replaceAll('00000000-0000-7000-8000-000000000001', f.gymId)
        .replaceAll('invoice_fixture', f.invoice.id) : value;
    }) as Tape;
    const transport = replayTransport(tape, f.gymId);
    const provider = new StripePayments(f.gymId, { transport, webhookSecret: 'fixture-signing-secret', clock: f.clock });
    const created = await provider.createCharge({ amount: 10000, currency: 'cad', customerId: 'cus_fixture', paymentMethodId: `pm_${card}`,
      invoiceId: f.invoice.id, attemptId: f.attempt.id, idempotencyKey: `${f.invoice.id}:1:create` });
    const outcome = await provider.confirmCharge(created.id, { idempotencyKey: `${f.invoice.id}:1:create:confirm` });
    const reread = await provider.findCharge({ kind: 'charge', id: created.id });
    transport.assertConsumed();
    expect((await applyChargeOutcome(f.transitions, f.context, { ...f.success, chargeId: 'ch_2' }, outcome))?.outcome).toBe('applied');
    expect((await applyChargeOutcome(f.transitions, f.context, { ...f.success, paymentId: uuidv7(), chargeId: 'ch_2' }, reread))?.outcome).toBe('ignored');
    expect((await f.read()).invoice.status).toBe(card === '4242' ? 'paid' : 'past_due');
    expect((await f.read()).attempts[0]!.status).toBe(card === '4242' ? 'succeeded' : card === '3184' ? 'requires_action' : 'failed');
  });
  it.each(['runner first', 'webhook first'])('records one payment, activation and receipt with %s and different local IDs', async order => {
    const f = await fixture(); await succeed(f);
    const first = order === 'runner first' ? f.success : { ...f.success, paymentId: uuidv7() };
    const second = order === 'runner first' ? { ...f.success, paymentId: uuidv7() } : f.success;
    expect((await f.transitions.cardSucceeded(f.context, first)).outcome).toBe('applied');
    expect((await f.transitions.cardSucceeded(f.context, second)).outcome).toBe('ignored');
    expect((await f.transitions.cardSucceeded(f.context, first)).outcome).toBe('ignored');
    await f.drain(); await f.drain();
    const rows = await f.read();
    expect(rows.payments).toHaveLength(1); expect(stateEvents(rows)).toHaveLength(1);
    expect(rows.invoice.status).toBe('paid'); expect(rows.attempts[0]!.status).toBe('succeeded');
    expect(await f.lifecycle.get(f.gymId, f.membership.id)).toMatchObject({ status: 'active', revision: 2 });
    expect(f.email.messages).toHaveLength(1); expect(f.email.messages[0]!.subject).toContain('Receipt');
    expect(rows.audits.filter(row => row.action === 'billing.membership.activated')).toHaveLength(1);
  });
  it('replays a failure once, emits signed dunning links, and schedules days 3/7/14 across DST', async () => {
    const f = await fixture();
    expect((await f.transitions.cardFailed(f.context, f.failure)).invoice.status).toBe('past_due');
    expect((await f.transitions.cardFailed(f.context, f.failure)).outcome).toBe('ignored');
    await Promise.all([f.effects.publish(f.gymId), f.effects.publish(f.gymId)]);
    await f.drain();
    expect(f.email.messages).toHaveLength(1); expect(stateEvents(await f.read())).toHaveLength(1);
    const retryJobs = f.jobs.jobs.filter(job => job.runAt > f.clock.now());
    expect(retryJobs.map(job => job.runAt.toISOString())).toEqual(['2028-03-13T16:00:00.000Z', '2028-03-17T16:00:00.000Z', '2028-03-24T16:00:00.000Z']);
    const tokens = [...f.email.messages[0]!.text.matchAll(/https:\/\/gym.example.invalid\/l\/([\w-]+)/g)].map(m => m[1]!);
    expect(tokens).toHaveLength(2);
    const links = createSignedLinksService(f.options);
    expect(await links.resolve(f.gymId, tokens[0]!)).toMatchObject({ status: 'active', principal: { householdId: f.household.id,
      link: { purpose: 'pay_invoice', invoiceId: f.invoice.id } } });
    expect(await links.resolve(f.gymId, tokens[1]!)).toMatchObject({ status: 'active', principal: { link: { purpose: 'update_card' } } });
    expect(JSON.stringify((await f.read()).audits)).not.toContain(tokens[0]);
  });
  it('serializes concurrent runner/webhook successes and concurrent failures', async () => {
    const f = await fixture();
    expect((await Promise.all([f.transitions.cardSucceeded(f.context, f.success),
      f.transitions.cardSucceeded(f.context, { ...f.success, paymentId: uuidv7() })])).map(r => r.outcome).sort()).toEqual(['applied', 'ignored']);
    expect((await f.read()).payments).toHaveLength(1); expect(stateEvents(await f.read())).toHaveLength(1);
    const failed = await fixture();
    expect((await Promise.all([failed.transitions.cardFailed(failed.context, failed.failure),
      failed.transitions.cardFailed(failed.context, failed.failure)])).map(r => r.outcome).sort()).toEqual(['applied', 'ignored']);
    expect(stateEvents(await failed.read())).toHaveLength(1);
    expect((await failed.read()).audits.filter(a => a.action === effectCreated)).toHaveLength(4);
  });
  it.each([
    { code: 'authentication_required' },
    { raw: { code: 'authentication_required' } },
    { error: { payment_intent: { last_payment_error: { code: 'authentication_required' } } } },
    { payment_intent: { last_payment_error: { code: 'authentication_required' } } },
  ])('routes thrown authentication_required shape %j through the fake and into action-needed', async error => {
    const f = await fixture(); f.provider.respondNextConfirmation({ error });
    const outcome = await f.provider.confirmCharge(f.success.paymentIntentId, { idempotencyKey: 'confirm' });
    expect(outcome.status).toBe('action_required');
    await applyChargeOutcome(f.transitions, f.context, f.success, outcome); await f.drain();
    expect((await f.read()).attempts[0]).toMatchObject({ status: 'requires_action', declineCode: 'authentication_required' });
    expect((await f.read()).invoice.status).toBe('past_due'); expect(f.email.messages[0]!.subject).toContain('Authentication');
    await f.transitions.cardFailed(f.context, f.failure);
    expect((await f.read()).attempts[0]!.status).toBe('requires_action');
  });
  it.each(['requires_action', 'requires_payment_method'])('recognizes provider %s with authentication_required in last_payment_error', async status => {
    const f = await fixture();
    const outcome = normalizeChargeOutcome({ id: f.success.paymentIntentId, status, amount: 10000, currency: 'cad',
      customerId: 'cus_test', metadata: { gymId: f.gymId, invoiceId: f.invoice.id, attemptId: f.attempt.id },
      last_payment_error: { code: 'authentication_required' } });
    await applyChargeOutcome(f.transitions, f.context, f.success, outcome); await f.drain();
    expect((await f.read()).attempts[0]!.status).toBe('requires_action'); expect(f.email.messages[0]!.subject).toContain('Authentication');
  });
  it.each(['failed', 'requires_action', 'canceled'] as const)('ignores late %s after payment and cancels queued dunning/retries', async outcome => {
    const f = await fixture(); await f.transitions.cardFailed(f.context, f.failure);
    await f.transitions.cardSucceeded(f.context, f.success);
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome }); await f.drain();
    f.clock.set('2028-03-25T17:00:00Z'); await f.drain();
    expect((await f.read()).invoice.status).toBe('paid'); expect(f.retry).not.toHaveBeenCalled();
    expect(f.email.messages).toHaveLength(1); expect(f.email.messages[0]!.subject).toContain('Receipt');
    expect((await f.read()).attempts[0]!.status).toBe('succeeded');
  });
  it('records old attempt diagnostics without changing an invoice or scheduling obsolete dunning', async () => {
    const f = await fixture(); await f.transitions.cardFailed(f.context, f.failure);
    await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, attemptNumber: 2, paymentIntentId: 'pi_new' });
    const before = await f.read();
    expect((await f.transitions.cardFailed(f.context, { ...f.failure, outcome: 'requires_action' })).outcome).toBe('ignored');
    const after = await f.read();
    expect(after.invoice).toEqual(before.invoice);
    expect(after.audits.filter(a => a.action === effectCreated)).toHaveLength(4);
    expect(after.attempts.find(a => a.id === f.attempt.id)!.status).toBe('requires_action');
    await f.drain(); expect(f.email.messages).toEqual([]);
  });
  it('keeps paid final while recording a failure for a different attempt', async () => {
    const f = await fixture(); await f.transitions.manualPayment(f.context, f.manual);
    await f.transitions.cardFailed(f.context, f.failure);
    expect((await f.read()).invoice.status).toBe('paid'); expect((await f.read()).attempts[0]!.status).toBe('failed');
    expect((await f.read()).audits.filter(a => a.action === effectCreated)).toHaveLength(2);
  });
  it('never downgrades a paid invoice for a later attempt or an old created/pending snapshot', async () => {
    const f = await fixture(); await f.transitions.cardSucceeded(f.context, f.success);
    const attempt = await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, attemptNumber: 2, paymentIntentId: 'pi_later' });
    const before = (await f.read()).invoice;
    await f.transitions.cardFailed(f.context, { ...f.failure, attemptId: attempt.id, paymentIntentId: 'pi_later', outcome: 'requires_action' });
    const pending = normalizeChargeOutcome({ id: f.success.paymentIntentId, status: 'requires_confirmation', amount: 10000, currency: 'cad',
      customerId: 'cus_test', metadata: { gymId: f.gymId, invoiceId: f.invoice.id } });
    expect(await applyChargeOutcome(f.transitions, f.context, f.success, pending)).toBeNull();
    expect((await f.read()).invoice).toEqual(before);
    expect((await f.read()).attempts.find(a => a.id === attempt.id)!.status).toBe('requires_action');
  });
  it.each(['failed', 'requires_action', 'canceled'] as const)('one-off %s stays open and never creates dunning or retry work', async outcome => {
    const f = await fixture('one_off');
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome }); await f.drain();
    expect((await f.read()).invoice.status).toBe('open'); expect(f.jobs.jobs).toEqual([]); expect(f.email.messages).toEqual([]);
    expect((await f.read()).audits.filter(a => a.action === effectCreated)).toEqual([]);
  });
  it('persists cancellation across a service restart and ignores stale success even without attemptId', async () => {
    const f = await fixture(); await f.transitions.cardFailed(f.context, { ...f.failure, outcome: 'canceled' });
    const restored = createInvoiceTransitions(f.options);
    const { attemptId: _attemptId, ...withoutAttempt } = f.success;
    expect(_attemptId).toBe(f.attempt.id);
    expect((await restored.cardSucceeded(f.context, withoutAttempt)).outcome).toBe('ignored');
    expect((await f.read()).payments).toEqual([]); expect((await f.read()).attempts[0]!.declineCode).toBe('intent_canceled');
  });
  it('records manual payments idempotently and rejects reused IDs or another manual payment', async () => {
    const f = await fixture();
    expect((await f.transitions.manualPayment(f.context, f.manual)).outcome).toBe('applied');
    expect((await f.transitions.manualPayment(f.context, f.manual)).outcome).toBe('ignored');
    await expect(f.transitions.manualPayment(f.context, { ...f.manual, reference: 'changed' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.transitions.manualPayment(f.context, { ...f.manual, paymentId: uuidv7() })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.read()).payments).toHaveLength(1);
  });
  it('rejects reused processor IDs with changed charge details and rejects a reused payment UUID', async () => {
    const f = await fixture(); await f.transitions.cardSucceeded(f.context, f.success);
    await expect(f.transitions.cardSucceeded(f.context, { ...f.success, paymentId: uuidv7(), chargeId: 'ch_other' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.transitions.manualPayment(f.context, { ...f.manual, paymentId: f.success.paymentId })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.read()).payments).toHaveLength(1);
  });
  it('automatically refunds an already-paid pay-link payment once, with a staff notice and unchanged invoice', async () => {
    const f = await fixture(); await f.transitions.manualPayment(f.context, f.manual); await f.drain();
    const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', invoiceId: f.invoice.id,
      amount: 10000, currency: 'cad', successUrl: 'https://gym.example.invalid', cancelUrl: 'https://gym.example.invalid',
      saveForOffSession: false, idempotencyKey: 'pay-link' });
    const checkout = f.provider.completeCheckout(session.id);
    const success = { ...f.success, paymentIntentId: checkout.chargeId!, chargeId: 'ch_checkout', attemptId: undefined };
    const { attemptId: _attemptId, ...request } = success;
    expect(_attemptId).toBeUndefined();
    const paidBefore = (await f.read()).invoice;
    expect((await f.transitions.cardSucceeded(f.context, request)).outcome).toBe('duplicate_payment');
    expect((await f.transitions.cardSucceeded(f.context, { ...request, paymentId: uuidv7() })).outcome).toBe('ignored');
    await f.drain(); await f.drain();
    const rows = await f.read(); expect(rows.payments).toHaveLength(2); expect(rows.refunds).toHaveLength(1);
    expect(rows.refunds[0]).toMatchObject({ status: 'succeeded', amountCents: 10000, reason: 'duplicate_payment' });
    expect(rows.invoice).toEqual(paidBefore);
    expect(f.email.messages.filter(m => m.to === 'staff@example.invalid')).toHaveLength(1);
    expect(f.email.messages.filter(m => m.to === 'payer@example.invalid')).toHaveLength(1);
  });
  it('recovers a lost duplicate-refund response after restart without issuing a second refund', async () => {
    const f = await fixture(); await succeed(f); await f.transitions.manualPayment(f.context, f.manual);
    await f.transitions.cardSucceeded(f.context, f.success);
    f.provider.loseNextResponse('refund'); await f.drain();
    expect((await f.read()).refunds[0]!.status).toBe('pending');
    f.clock.set('2028-03-10T17:00:02Z');
    const restored = createTransitionEffects({ ...f.effectOptions, transitions: createInvoiceTransitions(f.options) });
    const job = f.jobs.jobs.find(j => j.status === 'queued' && j.runAt <= f.clock.now())!;
    await restored.run((job.payload as { effectId: string }).effectId,
      { jobId: job.id, gymId: f.gymId, timezone: 'America/Vancouver', attempt: 2, clock: f.clock });
    expect((await f.read()).refunds[0]!.status).toBe('succeeded');
    const changes = await f.provider.listChangesSince(new Date('2028-03-10T00:00:00Z'));
    expect(new Set(changes.changes.filter(c => c.kind === 'refund').map(c => c.object.id)).size).toBe(1);
    expect((await f.read()).invoice.status).toBe('paid');
  });
  it('applies partial and full refunds once and ignores late failure/pending snapshots', async () => {
    const f = await fixture(); await f.transitions.cardSucceeded(f.context, f.success);
    const refund = { invoiceId: f.invoice.id, paymentId: f.success.paymentId, refundId: uuidv7(), processorId: 're_1',
      amountCents: 4000, currency: 'CAD', status: 'pending' as const };
    expect((await f.transitions.refund(f.context, refund)).invoice.status).toBe('paid');
    expect((await f.transitions.refund(f.context, { ...refund, status: 'succeeded' })).invoice.status).toBe('partially_refunded');
    expect((await f.transitions.refund(f.context, { ...refund, status: 'failed' })).outcome).toBe('ignored');
    expect((await f.transitions.refund(f.context, refund)).outcome).toBe('ignored');
    expect((await f.transitions.refund(f.context, { ...refund, status: 'succeeded' })).outcome).toBe('ignored');
    expect((await f.transitions.refund(f.context, { ...refund, refundId: uuidv7(), processorId: 're_2', amountCents: 6000, status: 'succeeded' })).invoice.status).toBe('refunded');
    await f.transitions.cardFailed(f.context, f.failure); expect((await f.read()).invoice.status).toBe('refunded');
    expect((await f.read()).refunds).toHaveLength(2);
    expect((await f.transitions.cardSucceeded(f.context, f.success)).invoice.status).toBe('refunded');
  });
  it('reserves pending refunds and serializes concurrent refunds to prevent over-refunding', async () => {
    const f = await fixture(); await f.transitions.cardSucceeded(f.context, f.success);
    const refund = { invoiceId: f.invoice.id, paymentId: f.success.paymentId, refundId: uuidv7(), processorId: 're_a',
      amountCents: 8000, currency: 'CAD', status: 'pending' as const };
    const results = await Promise.allSettled([f.transitions.refund(f.context, refund),
      f.transitions.refund(f.context, { ...refund, refundId: uuidv7(), processorId: 're_b' })]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await f.read()).refunds).toHaveLength(1); expect((await f.read()).invoice.status).toBe('paid');
    await expect(f.transitions.refund(f.context, { ...refund, currency: 'USD' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('deduplicates processor refunds, rejects changed refund IDs, and releases failed reservations', async () => {
    const f = await fixture(); await f.transitions.cardSucceeded(f.context, f.success);
    const request = { invoiceId: f.invoice.id, paymentId: f.success.paymentId, refundId: uuidv7(), processorId: 're_a',
      amountCents: 8000, currency: 'CAD', status: 'pending' as const };
    await f.transitions.refund(f.context, request);
    await expect(f.transitions.refund(f.context, { ...request, amountCents: 7000 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.transitions.refund(f.context, { ...request, refundId: uuidv7() })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.transitions.refund(f.context, { ...request, status: 'failed' })).invoice.status).toBe('paid');
    expect((await f.transitions.refund(f.context, { ...request, status: 'succeeded' })).outcome).toBe('ignored');
    expect((await f.transitions.refund(f.context, { ...request, refundId: uuidv7(), processorId: 're_b', amountCents: 10000, status: 'succeeded' })).invoice.status).toBe('refunded');
  });
  it('ignores unknown/pending provider outcomes and rejects cross-gym outcome metadata', async () => {
    const f = await fixture();
    const outcome = await f.provider.findCharge({ kind: 'charge', id: f.success.paymentIntentId });
    expect(await applyChargeOutcome(f.transitions, f.context, f.success, outcome)).toBeNull();
    expect(await applyChargeOutcome(f.transitions, f.context, f.success, { status: 'unknown', reference: { kind: 'charge', id: 'missing' } })).toBeNull();
    await succeed(f);
    const paid = await f.provider.findCharge({ kind: 'charge', id: f.success.paymentIntentId });
    await expect(applyChargeOutcome(f.transitions, { ...f.context, gymId: uuidv7() }, f.success, paid)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.read()).payments).toEqual([]);
  });
  it('rejects wrong amounts, identity reuse, mismatched attempts, draft/void and cross-gym resources', async () => {
    const f = await fixture(), stranger = await fixture();
    await expect(f.transitions.cardSucceeded(f.context, { ...f.success, currency: 'USD' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.transitions.cardSucceeded(f.context, { ...f.success, amountCents: 9999 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.transitions.cardSucceeded(f.context, { ...f.success, paymentIntentId: 'pi_wrong' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.transitions.cardSucceeded(stranger.context, f.success)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.transitions.cardFailed(stranger.context, f.failure)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.transitions.manualPayment(stranger.context, f.manual)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.transitions.refund(stranger.context, { invoiceId: f.invoice.id, paymentId: uuidv7(), refundId: uuidv7(), amountCents: 1, currency: 'CAD', status: 'pending' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, f.invoice.id)));
    await expect(f.transitions.cardSucceeded(f.context, f.success)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.read()).payments).toEqual([]);
  });
  it('recovers committed effects after a process/queue outage and retries failed email delivery', async () => {
    const f = await fixture(); await f.transitions.cardSucceeded(f.context, f.success);
    expect((await f.read()).audits.filter(a => a.action === effectCreated)).toHaveLength(2);
    f.email.respondNext(new Error('SMTP unavailable')); await f.drain();
    expect(f.email.messages).toEqual([]); expect((await f.read()).invoice.status).toBe('paid');
    f.clock.set('2028-03-10T17:00:02Z'); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    const work = (await f.read()).audits.filter(a => a.action === effectCompleted);
    expect(work).toHaveLength(2);
  });
  it('retries only on days 3/7/14 and leaves an unpaid invoice past_due after the last retry', async () => {
    const f = await fixture(); await f.transitions.cardFailed(f.context, f.failure); await f.drain();
    for (const day of ['13', '17', '24']) { f.clock.set(`2028-03-${day}T16:00:00Z`); await f.drain(); }
    expect(f.retry).toHaveBeenCalledTimes(3); expect((await f.read()).invoice.status).toBe('past_due');
  });
  it.each(['frozen', 'cancelled'])('does not resume or revive a %s membership', async status => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ status }).where(eq(memberships.id, f.membership.id)));
    await f.transitions.cardSucceeded(f.context, f.success); await f.drain();
    expect((await f.lifecycle.get(f.gymId, f.membership.id)).status).toBe(status);
    expect((await f.read()).audits.filter(a => a.action === 'billing.membership.activated')).toEqual([]);
  });
  it('does not end a trial when only its sign-up fee is paid', async () => {
    const f = await fixture('one_off');
    await db.forGym(f.gymId, async tx => {
      await tx.update(memberships).set({ status: 'trial', trialEndsOn: '2028-03-20' }).where(eq(memberships.id, f.membership.id));
      await tx.update(invoiceLineItems).set({ kind: 'signup_fee' }).where(eq(invoiceLineItems.invoiceId, f.invoice.id));
    });
    await f.transitions.cardSucceeded(f.context, f.success); await f.drain();
    expect((await f.lifecycle.get(f.gymId, f.membership.id)).status).toBe('trial');
  });
  it('revokes undisclosed dunning links when delivery fails, then retries with usable links', async () => {
    const f = await fixture(); await f.transitions.cardFailed(f.context, f.failure);
    f.email.respondNext(new Error('SMTP down')); await f.drain();
    const links = await db.forGym(f.gymId, tx => tx.select().from(signedLinks));
    expect(links).toHaveLength(2); expect(links.every(link => link.revokedAt !== null)).toBe(true);
    f.clock.set('2028-03-10T17:00:02Z'); await f.drain(); expect(f.email.messages).toHaveLength(1);
  });
  it('suppresses disabled/opted-out payer email without exposing signed tokens', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(members).set({ emailOptOut: true }).where(eq(members.id, f.member.id)));
    await f.transitions.cardFailed(f.context, f.failure); await f.drain(); expect(f.email.messages).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks))).toEqual([]);
  });
  it('never lets another gym run an effect', async () => {
    const f = await fixture(), stranger = await fixture(); await f.transitions.cardSucceeded(f.context, f.success);
    const event = (await f.read()).audits.find(a => a.action === effectCreated)!;
    await expect(f.effects.run(event.targetId, { gymId: stranger.gymId, jobId: uuidv7(), timezone: 'UTC', attempt: 1, clock: f.clock }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
  it('publishes effects right after commit, and a failed publish neither fails the transition nor loses work', async () => {
    const f = await fixture();
    const published = createInvoiceTransitions({ ...f.options, afterCommit: gymId => f.effects.publish(gymId) });
    expect((await published.cardFailed(f.context, f.failure)).outcome).toBe('applied');
    expect(f.jobs.jobs).toHaveLength(4);
    const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
    try {
      const failing = createInvoiceTransitions({ ...f.options, afterCommit: async () => { throw new Error('queue unavailable'); } });
      expect((await failing.cardSucceeded(f.context, f.success)).outcome).toBe('applied');
    } finally { setLogSink(previous); }
    expect(lines.map(line => JSON.parse(line).event)).toEqual(['billing.transitions.publish_failed']);
    expect((await f.read()).invoice.status).toBe('paid');
    expect(await f.effects.publish(f.gymId)).toBe(2);
  });
  it('records the processor Charge ID from the provider outcome when the caller has none', async () => {
    const f = await fixture();
    const outcome = await f.provider.confirmCharge(f.success.paymentIntentId, { idempotencyKey: `${f.invoice.id}:1:confirm` });
    if (outcome.status !== 'succeeded') throw new Error('Expected a successful charge');
    const { chargeId: _chargeId, ...identity } = f.success;
    expect(_chargeId).not.toBe(outcome.latestChargeId);
    expect((await applyChargeOutcome(f.transitions, f.context, identity, outcome))?.outcome).toBe('applied');
    expect((await f.read()).payments).toMatchObject([{ paymentIntentId: outcome.id, chargeId: outcome.latestChargeId }]);
    expect(outcome.latestChargeId).toMatch(/^ch_/);
  });
  it('sweeps hourly and publishes only effects inside its window', async () => {
    expect(createTransitionJobs().find(job => job.id === 'billing.transitions.publish')?.cron).toBe('11 * * * *');
    const f = await fixture(); await f.transitions.cardFailed(f.context, f.failure);
    f.clock.set('2028-04-10T17:00:00Z');
    expect(await f.effects.publish(f.gymId)).toBe(0);
    f.clock.set('2028-03-11T17:00:00Z');
    expect(await f.effects.publish(f.gymId)).toBe(4);
  });
});
