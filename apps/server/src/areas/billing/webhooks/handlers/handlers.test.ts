// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, invoices, paymentAttempts, paymentMethods, payments, refunds, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../../core/clock.js';
import { createApp } from '../../../../app.js';
import { createServerRegistry } from '../../../../core/registry.js';
import { FakeJobs } from '../../../../infra/jobs/index.js';
import { FakeEmail } from '../../../../infra/email/index.js';
import { FakePayments, type PaymentObjectReference, type Payments } from '../../../../infra/payments/index.js';
import { StripePayments } from '../../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../../infra/payments/stripe-fixtures.js';
import type { ObjectData } from '../../../../infra/payments/transport.js';
import { recordingTransport, replayTransport } from '../../../../infra/payments/transport.js';
import { FixtureRecorder, type Tape } from '../../../../infra/payments/recording.js';
import { createGymSettingsAccessor } from '../../../settings/settings.js';
import { createWebhookHealthQuery, createWebhookInbox, type WebhookHandler } from '../inbox.js';
import { createWebhookInboxRoutes } from '../inbox.routes.js';
import { createWebhookInboxJobs } from '../inbox.jobs.js';
import { createTransitionJobs } from '../../transitions/transitions.jobs.js';
import { composeBillingWebhooks } from './composition.js';
import { billingWebhookTypes, registerBillingWebhookHandlers } from './index.js';

const db = useTestDatabase(), factory = createFactories(db);
const secret = 'whsec_SYNTHETIC';
async function fixture(kind: 'cycle' | 'one_off' = 'cycle') {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true, memberEmailsEnabled: true });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture', email: 'payer@example.invalid' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, currency: 'USD', status: 'open', kind,
    number: 1, periodStartsOn: '2026-10-01', periodEndsOn: '2026-11-01' });
  const attempt = await factory('paymentAttempts', gymId, { invoiceId: invoice.id, currency: 'USD', paymentIntentId: 'pi_1' });
  const transport = new StripeFixtures(gymId, Math.floor(clock.now().getTime() / 1000));
  const metadata = { gym_id: gymId, invoice_id: invoice.id, attempt_id: attempt.id };
  transport.objects.set('pi_1', { id: 'pi_1', object: 'payment_intent', amount: 10000, currency: 'usd', customer: 'cus_fixture',
    payment_method: 'pm_4242', status: 'succeeded', latest_charge: 'ch_2', metadata });
  transport.objects.set('ch_2', { id: 'ch_2', object: 'charge', payment_intent: 'pi_1', metadata: {}, created: transport.now });
  const provider = new StripePayments(gymId, { clock, transport, webhookSecret: secret });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), settings = createGymSettingsAccessor({ scope: db.forGym });
  const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock, jobs, gymSettings: settings,
    async paymentsFor() { return provider; } });
  const composed = composeBillingWebhooks({ scope: db.forGym, clock, jobs, settings, inbox,
    async paymentsFor() { return provider; }, async prepare() { return { email, origin: 'https://gym.example.invalid' }; },
    async staffRecipients() { return ['owner@example.invalid']; } });
  const registrations = [...createWebhookInboxJobs(inbox), ...createTransitionJobs(() => composed.effects)];
  createServerRegistry({ jobs: registrations }).registerJobs(jobs, new Set());
  const handlers = new Map<string, WebhookHandler>();
  registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } },
    { scope: db.forGym, clock, transitions: composed.transitions });
  const context = { gymId, clock, timezone: 'UTC', attempt: 1, jobId: uuidv7(), payments: provider };
  const run = async (type: string, reference: PaymentObjectReference = { kind: 'charge', id: 'pi_1' }, override: Payments = provider) => {
    const history = vi.spyOn(override, 'listChangesSince').mockRejectedValue(new Error('Handlers must not scan payment history'));
    try { await handlers.get(type)!({ id: 'evt_' + uuidv7(), type, gymId, objectId: reference.id, objectKind: reference.kind }, { ...context, payments: override }); }
    finally { expect(history).not.toHaveBeenCalled(); }
  };
  const read = () => db.forGym(gymId, async tx => ({
    invoice: (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)))[0]!,
    payments: await tx.select().from(payments), refunds: await tx.select().from(refunds),
    methods: await tx.select().from(paymentMethods), attempts: await tx.select().from(paymentAttempts), audits: await tx.select().from(auditEvents),
  }));
  const drain = async () => { for (let n = 0; n < 30 && await jobs.runNext(); n++) { /* bounded, due jobs only */ } };
  return { gymId, clock, household, invoice, attempt, provider, transport, jobs, email, inbox, composed, handlers, context, run, read, drain };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function refund(f: Fixture, id = 're_dashboard', amount = 2500, status = 'succeeded') {
  f.transport.objects.set(id, { id, object: 'refund', charge: 'ch_2', amount, currency: 'usd', status, metadata: {}, created: 1792929600 });
}
function setup(f: Fixture, id = 'seti_new', method = 'pm_3155') {
  f.transport.objects.set(id, { id, object: 'setup_intent', customer: 'cus_fixture', status: 'succeeded',
    payment_method: method, metadata: { gym_id: f.gymId } });
}
// The existing adapter tapes cover intents/refunds; synthetic current objects supply additional lifecycle states.
async function recordedIntent(f: Fixture, card: string) {
  const stored = JSON.parse(await readFile(new URL('../../../../infra/payments/stripe.synthetic.json', import.meta.url), 'utf8')) as { tapes: Record<string, Tape> };
  const tape = JSON.parse(JSON.stringify(stored.tapes[`extended > normalizes card ${card} after the setup fixture`]), (key, value: unknown) => {
    if (key === 'attempt_id') return f.attempt.id;
    if (key === 'amount') return 10000;
    return typeof value === 'string' ? value.replaceAll('00000000-0000-7000-8000-000000000001', f.gymId)
      .replaceAll('invoice_fixture', f.invoice.id) : value;
  }) as Tape;
  // The opt-in accounting lookup adds one Charge read; the shared adapter tape keeps its original request sequence.
  if (card === '4242') tape.exchanges.push({ operation: 'stripe', input: { method: 'GET', path: '/v1/charges/ch_2' },
    output: { id: 'ch_2', object: 'charge', payment_intent: 'pi_1', created: f.transport.now } });
  const transport = replayTransport(tape, f.gymId), provider = new StripePayments(f.gymId, { transport, clock: f.clock, webhookSecret: secret });
  const created = await provider.createCharge({ amount: 10000, currency: 'usd', customerId: 'cus_fixture', paymentMethodId: 'pm_' + card,
    invoiceId: f.invoice.id, attemptId: f.attempt.id, idempotencyKey: `${f.invoice.id}:1:create` });
  await provider.confirmCharge(created.id, { idempotencyKey: `${f.invoice.id}:1:create:confirm` });
  return { provider, transport };
}

describe('billing webhook handlers with PostgreSQL and Stripe adapter fixtures', () => {
  it.each([
    ['4242', 'payment_intent.succeeded', 'paid', 'succeeded'],
    ['0341', 'payment_intent.payment_failed', 'past_due', 'failed'],
    ['3184', 'payment_intent.requires_action', 'past_due', 'requires_action'],
  ])('applies recorded %s through the real adapter, transitions and effect worker', async (card, type, status, attemptStatus) => {
    const f = await fixture(), recorded = await recordedIntent(f, card!);
    await f.run(type!, undefined, recorded.provider); recorded.transport.assertConsumed();
    const rows = await f.read(); expect(rows.invoice.status).toBe(status); expect(rows.attempts[0]!.status).toBe(attemptStatus);
    await f.drain(); expect(f.email.messages).toHaveLength(1);
    if (status === 'paid') expect(rows.payments[0]!.chargeId).toBe('ch_2');
  });
  it.each(['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.requires_action'])(
  're-reads current success regardless of %s delivery and replays once', async type => {
    const f = await fixture();
    await Promise.all([f.run(type), f.run(type)]); await f.run(type); await f.drain();
    const rows = await f.read(); expect(rows.invoice.status).toBe('paid'); expect(rows.payments).toHaveLength(1);
    expect(rows.audits.filter(a => a.action === 'billing.invoice.paid')).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
  });
  it.each(['cycle', 'one_off'] as const)('replays %s failures and authentication-needed without duplicate dunning', async kind => {
    const f = await fixture(kind), intent = f.transport.objects.get('pi_1')!;
    intent.status = 'requires_payment_method'; intent.last_payment_error = { code: 'card_declined' };
    await f.run('payment_intent.payment_failed'); await f.run('payment_intent.payment_failed');
    intent.last_payment_error = { code: 'authentication_required' };
    await f.run('payment_intent.requires_action'); await f.run('payment_intent.requires_action');
    expect((await f.read()).invoice.status).toBe(kind === 'cycle' ? 'past_due' : 'open');
    await f.drain(); expect(f.email.messages).toHaveLength(kind === 'cycle' ? 2 : 0);
    intent.status = 'succeeded'; await f.run('payment_intent.succeeded');
    intent.status = 'requires_payment_method'; await f.run('payment_intent.payment_failed');
    expect((await f.read()).invoice.status).toBe('paid');
  });
  it('ignores an older attempt failure after a newer attempt succeeds', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ status: 'failed' }).where(eq(paymentAttempts.id, f.attempt.id)));
    const next = await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, paymentIntentId: 'pi_new', attemptNumber: 2, currency: 'USD' });
    f.transport.objects.set('pi_new', { ...f.transport.objects.get('pi_1')!, id: 'pi_new', latest_charge: 'ch_new',
      metadata: { gym_id: f.gymId, invoice_id: f.invoice.id, attempt_id: next.id } });
    f.transport.objects.set('ch_new', { id: 'ch_new', object: 'charge', payment_intent: 'pi_new', created: f.transport.now });
    await f.run('payment_intent.succeeded', { kind: 'charge', id: 'pi_new' });
    Object.assign(f.transport.objects.get('pi_1')!, { status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } });
    await f.run('payment_intent.payment_failed'); expect((await f.read()).invoice.status).toBe('paid');
  });
  it('completes a payment Checkout without an attempt, then ignores its intent replay', async () => {
    const f = await fixture('one_off');
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: 'pi_runner' }).where(eq(paymentAttempts.id, f.attempt.id)));
    const session = await f.provider.createCheckout({ mode: 'payment', amount: 10000, currency: 'usd', invoiceId: f.invoice.id,
      customerId: 'cus_fixture', successUrl: 'https://gym.example.invalid/ok', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: 'checkout' });
    const intent = f.transport.completeCheckout(session.id);
    Object.assign(intent, { amount: 10000, latest_charge: 'ch_checkout' });
    f.transport.objects.set('ch_checkout', { id: 'ch_checkout', object: 'charge', payment_intent: intent.id, created: f.transport.now });
    const success = vi.spyOn(f.composed.transitions, 'cardSucceeded');
    await f.run('checkout.session.completed', { kind: 'checkout', id: session.id });
    expect((await f.read()).methods[0]!.brand).toBe('visa');
    await f.run('checkout.session.completed', { kind: 'checkout', id: session.id });
    await f.run('payment_intent.succeeded', { kind: 'charge', id: String(intent.id) });
    expect(success.mock.calls[0]![1]).not.toHaveProperty('attemptId');
    const rows = await f.read(); expect(rows.payments).toHaveLength(1); expect(rows.invoice.status).toBe('paid');
    expect(rows.methods).toHaveLength(1); expect(rows.methods[0]).toMatchObject({ processorId: 'pm_3155', isDefault: true });
  });
  it('completes setup Checkout and its setup event once, and updates expiry from the current method', async () => {
    const f = await fixture();
    const session = await f.provider.createCheckout({ mode: 'setup', customerId: 'cus_fixture', successUrl: 'https://gym.example.invalid/ok',
      cancelUrl: 'https://gym.example.invalid/cancel', saveForOffSession: true, idempotencyKey: 'setup' });
    f.transport.completeCheckout(session.id);
    await f.run('checkout.session.completed', { kind: 'checkout', id: session.id });
    await f.run('setup_intent.succeeded', { kind: 'setup', id: session.setupId! });
    const method = f.transport.objects.get('pm_3155')!; (method.card as ObjectData).exp_year = 2035;
    await f.run('payment_method.updated', { kind: 'payment_method', id: 'pm_3155' });
    await f.run('payment_method.updated', { kind: 'payment_method', id: 'pm_3155' });
    const rows = await f.read(); expect(rows.methods).toHaveLength(1); expect(rows.methods[0]!.expiryYear).toBe(2035);
    expect(rows.audits.filter(a => a.action === 'billing.payment_method.updated')).toHaveLength(2);
    expect(rows.payments).toHaveLength(0);
  });
  it('keeps existing null card brands when a later webhook refreshes expiry', async () => {
    const f = await fixture(); setup(f);
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ brand: null }));
    const method = f.transport.objects.get('pm_3155')!; (method.card as ObjectData).exp_year = 2035;
    await f.run('payment_method.updated', { kind: 'payment_method', id: 'pm_3155' });
    expect((await f.read()).methods[0]).toMatchObject({ brand: null, expiryYear: 2035 });
  });
  it('keeps the newer collected card on reverse delivery, replay, and concurrent collection', async () => {
    const f = await fixture(); setup(f, 'seti_old', 'pm_4242'); setup(f);
    f.transport.objects.get('pm_4242')!.created = f.transport.now - 86400;
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
    await Promise.all([f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_old' }), f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' })]);
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_old' });
    expect((await f.read()).methods.filter(m => m.isDefault).map(m => m.processorId)).toEqual(['pm_3155']);
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_old' });
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
    expect((await f.read()).methods.filter(m => m.isDefault).map(m => m.processorId)).toEqual(['pm_3155']);
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false }).where(eq(paymentMethods.processorId, 'pm_3155')));
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
    await f.run('payment_method.updated', { kind: 'payment_method', id: 'pm_3155' });
    expect((await f.read()).methods.filter(m => m.isDefault)).toHaveLength(0);
  });
  it('collects cards without provider change history or an audit watermark', async () => {
    const f = await fixture(); setup(f);
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
    expect((await f.read()).methods[0]).toMatchObject({ isDefault: true, processorCreatedAt: f.clock.now() });
    expect((await f.read()).audits.every(row => row.action === 'billing.payment_method.updated')).toBe(true);
  });
  it.each(['null', 'older', 'newer', 'tie_lower', 'tie_higher'])(
    'compares the collected card to the current default with %s processor time/ID', async order => {
      const f = await fixture(); setup(f);
      const processorCreatedAt = order === 'null' ? null : new Date(f.clock.now().getTime() + (order === 'older' ? -1000 : order === 'newer' ? 1000 : 0));
      const processorId = order === 'tie_lower' ? 'pm_0000' : 'pm_9999';
      await factory('paymentMethods', f.gymId, { householdId: f.household.id, processorId, isDefault: true, processorCreatedAt });
      await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
      await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
      const expected = ['null', 'older', 'tie_lower'].includes(order) ? 'pm_3155' : processorId;
      expect((await f.read()).methods.filter(m => m.isDefault).map(m => m.processorId)).toEqual([expected]);
    });
  it('serializes first collection of different cards arriving concurrently by processor time', async () => {
    const f = await fixture(); setup(f, 'seti_old', 'pm_4242'); setup(f);
    f.transport.objects.get('pm_4242')!.created = f.transport.now - 86400;
    await Promise.all([f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_old' }),
      f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' })]);
    expect((await f.read()).methods.filter(m => m.isDefault).map(m => m.processorId)).toEqual(['pm_3155']);
  });
  it.each([true, false])('pays payment Checkout with saveForOffSession=%s and preserves the provider success time', async savesCard => {
    const f = await fixture('one_off');
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: 'pi_runner' }).where(eq(paymentAttempts.id, f.attempt.id)));
    const session = await f.provider.createCheckout({ mode: 'payment', amount: 10000, currency: 'usd', invoiceId: f.invoice.id,
      customerId: 'cus_fixture', successUrl: 'https://gym.example.invalid/ok', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: savesCard, idempotencyKey: 'checkout' });
    f.transport.completeCheckout(session.id).amount = 10000;
    const succeededAt = f.clock.now(); f.clock.advance(3 * 86400000);
    const methodReads = vi.spyOn(f.provider, 'readPaymentObject');
    await f.run('checkout.session.completed', { kind: 'checkout', id: session.id });
    f.clock.advance(5 * 86400000);
    await f.run('checkout.session.completed', { kind: 'checkout', id: session.id });
    const rows = await f.read(); expect(rows.invoice).toMatchObject({ status: 'paid', paidAt: succeededAt });
    expect(rows.payments).toHaveLength(1); expect(rows.payments[0]!.paidAt).toEqual(succeededAt);
    expect(rows.methods).toHaveLength(savesCard ? 1 : 0);
    expect(methodReads.mock.calls.some(([ref]) => ref.kind === 'payment_method')).toBe(savesCard);
  });
  it('retries a card-saving Checkout whose method has not attached, without paying twice', async () => {
    const f = await fixture('one_off');
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: 'pi_runner' }).where(eq(paymentAttempts.id, f.attempt.id)));
    const session = await f.provider.createCheckout({ mode: 'payment', amount: 10000, currency: 'usd', invoiceId: f.invoice.id,
      customerId: 'cus_fixture', successUrl: 'https://gym.example.invalid/ok', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: 'checkout' });
    f.transport.completeCheckout(session.id).amount = 10000;
    f.transport.objects.get('pm_3155')!.customer = null;
    await expect(f.run('checkout.session.completed', { kind: 'checkout', id: session.id })).rejects.toThrow('unresolved');
    expect((await f.read()).invoice.status).toBe('paid'); expect((await f.read()).methods).toHaveLength(0);
    f.transport.objects.get('pm_3155')!.customer = 'cus_fixture';
    await f.run('checkout.session.completed', { kind: 'checkout', id: session.id });
    expect((await f.read()).payments).toHaveLength(1); expect((await f.read()).methods).toHaveLength(1);
  });
  it.each(['stripe', 'fake'])('records provider success time for delayed intent delivery and replay through %s', async kind => {
    const f = await fixture(), succeededAt = f.clock.now();
    let provider: Payments = f.provider;
    if (kind === 'fake') {
      const fake = new FakePayments(f.gymId, f.clock); provider = fake;
      const intent = await fake.createCharge({ amount: 10000, currency: 'usd', customerId: 'cus_fixture', paymentMethodId: 'pm_4242',
        invoiceId: f.invoice.id, attemptId: f.attempt.id, idempotencyKey: 'create' });
      await fake.confirmCharge(intent.id, { idempotencyKey: 'confirm' });
    }
    f.clock.advance(3 * 86400000); await f.run('payment_intent.succeeded', undefined, provider);
    f.clock.advance(5 * 86400000); await f.run('payment_intent.payment_failed', undefined, provider);
    expect((await f.read()).invoice.paidAt).toEqual(succeededAt);
    expect((await f.read()).payments[0]!.paidAt).toEqual(succeededAt);
  });
  it('refreshes known cards on automatic updates, without collecting unknown or re-enabling revoked cards', async () => {
    const f = await fixture(); setup(f);
    await f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
    (f.transport.objects.get('pm_3155')!.card as ObjectData).exp_year = 2036;
    await f.run('payment_method.automatically_updated', { kind: 'payment_method', id: 'pm_3155' });
    await f.run('payment_method.automatically_updated', { kind: 'payment_method', id: 'pm_3155' });
    await f.run('payment_method.automatically_updated', { kind: 'payment_method', id: 'pm_4242' });
    expect((await f.read()).methods).toHaveLength(1); expect((await f.read()).methods[0]!.expiryYear).toBe(2036);
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false }).where(eq(paymentMethods.processorId, 'pm_3155')));
    await f.run('payment_method.automatically_updated', { kind: 'payment_method', id: 'pm_3155' });
    expect((await f.read()).methods[0]).toMatchObject({ revokedAt: f.clock.now(), isDefault: false });
  });
  it.each(['warning_closed', 'charge_refunded', 'prevented'])('records %s as terminal closed and never reopens it', async status => {
    const f = await fixture(); await f.run('payment_intent.succeeded');
    f.transport.objects.set('dp_closed', { id: 'dp_closed', object: 'dispute', charge: 'ch_2', amount: 10000, status, metadata: {} });
    await f.run('charge.dispute.closed', { kind: 'dispute', id: 'dp_closed' });
    await f.run('charge.dispute.closed', { kind: 'dispute', id: 'dp_closed' });
    f.transport.objects.get('dp_closed')!.status = 'needs_response';
    await f.run('charge.dispute.updated', { kind: 'dispute', id: 'dp_closed' });
    expect((await f.read()).invoice).toMatchObject({ status: 'paid', disputeStatus: 'closed' });
    expect((await f.read()).audits.filter(row => row.action === 'billing.invoice.disputed')).toHaveLength(1);
    expect([...f.handlers.keys()]).not.toContain('charge.dispute.funds_reinstated');
    expect([...f.handlers.keys()]).not.toContain('charge.dispute.funds_withdrawn');
  });
  it('finds untagged dashboard refunds through the PaymentIntent before its success delivery', async () => {
    const f = await fixture(); refund(f);
    await f.run('charge.refunded'); await f.run('charge.refunded');
    await f.run('payment_intent.succeeded');
    const rows = await f.read(); expect(rows.payments).toHaveLength(1); expect(rows.refunds).toHaveLength(1);
    expect(rows.invoice.status).toBe('partially_refunded'); expect(rows.refunds[0]!.processorId).toBe('re_dashboard');
    refund(f, 're_final', 7500); await f.run('charge.refunded');
    expect((await f.read()).invoice.status).toBe('refunded');
  });
  it('reads every refund page and refreshes discovered refunds instead of applying change snapshots', async () => {
    const f = await fixture(); refund(f); refund(f, 're_final', 7500);
    const request = f.transport.request.bind(f.transport);
    const pages = vi.spyOn(f.transport, 'request').mockImplementation(async input => {
      if (input.path === '/v1/refunds') return input.params?.starting_after
        ? { data: [{ ...f.transport.objects.get('re_final')!, status: 'pending' }], has_more: false }
        : { data: [{ ...f.transport.objects.get('re_dashboard')!, status: 'pending' }], has_more: true };
      return request(input);
    });
    await f.run('charge.refunded');
    expect(pages.mock.calls.filter(([input]) => input.path === '/v1/refunds').map(([input]) => input)).toEqual([
      { method: 'GET', path: '/v1/refunds', params: { payment_intent: 'pi_1', limit: 100 } },
      { method: 'GET', path: '/v1/refunds', params: { payment_intent: 'pi_1', limit: 100, starting_after: 're_dashboard' } },
    ]);
    expect((await f.read()).refunds).toHaveLength(2); expect((await f.read()).invoice.status).toBe('refunded');
  });
  it('matches restored payments and disputes by stored intent ID when invoice metadata is absent', async () => {
    const f = await fixture(); f.transport.objects.get('pi_1')!.metadata = { gym_id: f.gymId };
    f.transport.objects.set('dp_restored', { id: 'dp_restored', object: 'dispute', charge: 'ch_2', amount: 10000, status: 'needs_response', metadata: {} });
    await f.run('charge.dispute.created', { kind: 'dispute', id: 'dp_restored' });
    await f.run('payment_intent.succeeded'); refund(f); await f.run('charge.refunded');
    expect((await f.read()).invoice).toMatchObject({ status: 'partially_refunded', disputeId: 'dp_restored', disputeStatus: 'open' });
  });
  it('does not invent a Charge ID or accept an unresolved refunded charge', async () => {
    const f = await fixture(); delete f.transport.objects.get('pi_1')!.latest_charge;
    await expect(f.run('payment_intent.succeeded')).rejects.toThrow('Charge ID');
    f.transport.objects.get('pi_1')!.latest_charge = 'ch_2';
    await expect(f.run('charge.refunded')).rejects.toThrow('no resolved refunds');
    expect((await f.read()).payments).toHaveLength(0);
  });
  it.each(['refund.created', 'refund.updated', 'refund.failed'])('re-reads and deduplicates %s, including concurrent refund delivery', async type => {
    const f = await fixture(); await f.run('payment_intent.succeeded'); refund(f);
    await Promise.all([f.run(type, { kind: 'refund', id: 're_dashboard' }), f.run(type, { kind: 'refund', id: 're_dashboard' })]);
    await f.run(type, { kind: 'refund', id: 're_dashboard' });
    expect((await f.read()).refunds).toHaveLength(1); expect((await f.read()).invoice.status).toBe('partially_refunded');
  });
  it('advances a pending refund and never regresses a successful refund on a stale concurrent read', async () => {
    const f = await fixture(); refund(f, 're_dashboard', 2500, 'pending');
    await f.run('refund.created', { kind: 'refund', id: 're_dashboard' });
    expect((await f.read()).invoice.status).toBe('paid');
    refund(f); await f.run('refund.updated', { kind: 'refund', id: 're_dashboard' });
    refund(f, 're_dashboard', 2500, 'pending'); await f.run('refund.updated', { kind: 'refund', id: 're_dashboard' });
    expect((await f.read()).refunds[0]!.status).toBe('succeeded');
  });
  it('adopts a duplicate-payment refund reservation without reducing the accepted payment', async () => {
    const f = await fixture(); await f.composed.transitions.manualPayment({ gymId: f.gymId, actor: { kind: 'system' } },
      { invoiceId: f.invoice.id, paymentId: uuidv7(), method: 'cash', amountCents: 10000, currency: 'USD', paidAt: f.clock.now().toISOString() });
    await f.run('payment_intent.succeeded'); refund(f, 're_dashboard', 10000);
    await f.run('charge.refunded');
    expect((await f.read()).refunds).toHaveLength(1); expect((await f.read()).invoice.status).toBe('paid');
  });
  it.each(billingWebhookTypes.filter(t => t.startsWith('charge.dispute.')))('records current dispute state for %s without reopening paid invoices', async type => {
    const f = await fixture(); await f.run('payment_intent.succeeded');
    f.transport.objects.set('dp_dashboard', { id: 'dp_dashboard', object: 'dispute', charge: 'ch_2', amount: 10000, status: 'needs_response', metadata: {} });
    await f.run(type, { kind: 'dispute', id: 'dp_dashboard' }); await f.run(type, { kind: 'dispute', id: 'dp_dashboard' });
    f.transport.objects.get('dp_dashboard')!.status = 'won';
    await f.run('charge.dispute.created', { kind: 'dispute', id: 'dp_dashboard' });
    f.transport.objects.get('dp_dashboard')!.status = 'needs_response';
    await f.run('charge.dispute.updated', { kind: 'dispute', id: 'dp_dashboard' });
    const rows = await f.read(); expect(rows.invoice).toMatchObject({ status: 'paid', disputeId: 'dp_dashboard', disputeStatus: 'won' });
    expect(rows.audits.filter(a => a.action === 'billing.invoice.disputed')).toHaveLength(2);
  });
  it('rejects cross-gym metadata, cross-household customer identities, and missing objects', async () => {
    const f = await fixture(), other = await fixture();
    f.transport.objects.get('pi_1')!.metadata = { gym_id: other.gymId, invoice_id: other.invoice.id };
    await expect(f.run('payment_intent.succeeded')).rejects.toThrow('unresolved');
    f.transport.objects.get('pi_1')!.metadata = { gym_id: f.gymId, invoice_id: other.invoice.id };
    await expect(f.run('payment_intent.succeeded')).rejects.toThrow('ambiguous');
    f.transport.objects.get('pi_1')!.metadata = { gym_id: f.gymId, invoice_id: f.invoice.id };
    f.transport.objects.get('pi_1')!.customer = 'cus_other';
    await expect(f.run('payment_intent.succeeded')).rejects.toThrow('customer');
    await expect(f.run('payment_intent.succeeded', { kind: 'charge', id: 'pi_missing' })).rejects.toThrow('unresolved');
    expect((await f.read()).payments).toHaveLength(0); expect((await other.read()).payments).toHaveLength(0);
  });
  it('production createApp composition accepts signed delivery, pays once and sends one receipt', async () => {
    const f = await fixture();
    const app = createApp({ clock: f.clock, contributions: { routes: createWebhookInboxRoutes(f.inbox) },
      async resolveGym(c, next) { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      async session(_c, next) { await next(); }, authorize: permission => async (_c, next) => {
        expect(permission).toEqual({ kind: 'public' }); await next();
      } });
    const event = { id: 'evt_signed_' + f.gymId, object: 'event', type: 'payment_intent.payment_failed', livemode: false,
      data: { object: { id: 'pi_1', object: 'payment_intent', status: 'requires_payment_method', metadata: { gym_id: f.gymId } } } };
    const body = JSON.stringify(event), timestamp = Math.floor(f.clock.now().getTime() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')}`;
    const deliver = () => app.request('https://gym.example.invalid/webhooks/stripe', { method: 'POST', body,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' } });
    expect((await deliver()).status).toBe(200); expect((await deliver()).status).toBe(200);
    await f.drain(); await f.inbox.replay(f.gymId, event.id); await f.drain();
    expect((await f.read()).invoice.status).toBe('paid'); expect((await f.read()).payments).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
    expect(await createWebhookHealthQuery(db.forGym).get(f.gymId)).toMatchObject({ lastProcessedAt: f.clock.now().toISOString(), pendingCount: 0, failedCount: 0 });
    expect(f.jobs.jobs.every(job => job.status === 'completed')).toBe(true);
  });
  it('keeps an unavailable object unprocessed and exposes an unconfigured retry runner', async () => {
    const f = await fixture();
    const event = { id: 'evt_unavailable', object: 'event', type: 'payment_intent.succeeded', livemode: false,
      data: { object: { id: 'pi_missing', object: 'payment_intent', metadata: { gym_id: f.gymId } } } };
    const body = new TextEncoder().encode(JSON.stringify(event)), timestamp = Math.floor(f.clock.now().getTime() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex')}`;
    await f.inbox.receive(f.gymId, body, signature);
    await expect(f.inbox.dispatch({ eventId: event.id }, f.context)).rejects.toThrow('unresolved');
    expect(await createWebhookHealthQuery(db.forGym).get(f.gymId)).toMatchObject({ lastProcessedAt: null, failedCount: 1 });
    Object.assign(f.transport.objects.get('pi_1')!, { status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } });
    await f.run('payment_intent.payment_failed'); await f.drain();
    const retryJob = f.jobs.jobs.find(job => job.name === 'billing.transitions.effect' && job.runAt > f.clock.now())!;
    await expect(f.composed.effects.run((retryJob.payload as { effectId: string }).effectId, f.context)).rejects.toThrow('retry runner');
    // The composition is available before the runner is constructed; attach its callback afterwards.
    const runner = { transitions: f.composed.transitions, retry: vi.fn(async () => {}) };
    f.composed.attachRetry(runner.retry);
    await f.composed.effects.run((retryJob.payload as { effectId: string }).effectId, f.context);
    await f.composed.effects.run((retryJob.payload as { effectId: string }).effectId, f.context);
    expect(runner.retry).toHaveBeenCalledExactlyOnceWith(f.invoice.id, f.context);
  });
  it('replays recorded adapter exchanges for Checkout, setup, method updates, dashboard refunds and every dispute event', async () => {
    const f = await fixture('one_off');
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: 'pi_runner' }).where(eq(paymentAttempts.id, f.attempt.id)));
    const location = new URL('./stripe.handlers.synthetic.json', import.meta.url);
    const recording = process.env.RECORD_HANDLER_FIXTURES === '1', recorder = new FixtureRecorder(f.gymId);
    const bind = (value: string) => value.replaceAll('00000000-0000-7000-8000-000000000001', f.gymId)
      .replaceAll('00000000-0000-7000-8000-000000000002', f.invoice.id).replaceAll('00000000-0000-7000-8000-000000000003', f.attempt.id);
    const replay = recording ? undefined : replayTransport(JSON.parse(bind(await readFile(location, 'utf8'))) as Tape, f.gymId);
    const provider = new StripePayments(f.gymId, { clock: f.clock, webhookSecret: secret,
      transport: replay ?? recordingTransport(f.transport, recorder) });
    const session = await provider.createCheckout({ mode: 'payment', amount: 10000, currency: 'usd', invoiceId: f.invoice.id,
      customerId: 'cus_fixture', successUrl: 'https://gym.example.invalid/ok', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: 'checkout' });
    if (recording) {
      const intent = f.transport.completeCheckout(session.id);
      Object.assign(intent, { amount: 10000, latest_charge: 'ch_checkout' });
      f.transport.objects.set('ch_checkout', { id: 'ch_checkout', object: 'charge', payment_intent: intent.id, created: f.transport.now });
    }
    const twice = async (type: string, reference: PaymentObjectReference) => { await f.run(type, reference, provider); await f.run(type, reference, provider); };
    await twice('checkout.session.completed', { kind: 'checkout', id: session.id });
    const setupSession = await provider.createCheckout({ mode: 'setup', customerId: 'cus_fixture', successUrl: 'https://gym.example.invalid/ok',
      cancelUrl: 'https://gym.example.invalid/cancel', saveForOffSession: true, idempotencyKey: 'setup' });
    if (recording) f.transport.completeCheckout(setupSession.id);
    await twice('checkout.session.completed', { kind: 'checkout', id: setupSession.id });
    await twice('setup_intent.succeeded', { kind: 'setup', id: setupSession.setupId! });
    if (recording) (f.transport.objects.get('pm_3155')!.card as ObjectData).exp_year = 2035;
    await twice('payment_method.updated', { kind: 'payment_method', id: 'pm_3155' });
    await twice('payment_method.automatically_updated', { kind: 'payment_method', id: 'pm_3155' });
    // A dashboard refund of the Checkout's own charge.
    if (recording) { refund(f); f.transport.objects.get('re_dashboard')!.charge = 'ch_checkout'; }
    // The session's PaymentIntent exists only once it is paid; read it back as the handlers do.
    const paid = await provider.readPaymentObject({ kind: 'checkout', id: session.id });
    if (paid.status !== 'found' || paid.value.kind !== 'checkout' || !paid.value.object.chargeId) throw new Error('Checkout intent missing');
    await twice('charge.refunded', { kind: 'charge', id: paid.value.object.chargeId });
    for (const type of ['refund.created', 'refund.updated', 'refund.failed']) await twice(type, { kind: 'refund', id: 're_dashboard' });
    if (recording) f.transport.objects.set('dp_recorded', { id: 'dp_recorded', object: 'dispute', charge: 'ch_checkout', amount: 10000, status: 'lost', metadata: {} });
    for (const type of billingWebhookTypes.filter(t => t.startsWith('charge.dispute.'))) await twice(type, { kind: 'dispute', id: 'dp_recorded' });
    const rows = await f.read(); expect(rows.payments).toHaveLength(1); expect(rows.refunds).toHaveLength(1); expect(rows.methods).toHaveLength(1);
    expect(rows.invoice).toMatchObject({ status: 'partially_refunded', disputeId: 'dp_recorded', disputeStatus: 'lost' });
    expect(rows.methods[0]).toMatchObject({ isDefault: true, expiryYear: 2035 });
    if (recording) await writeFile(location, JSON.stringify({ $comment: 'SPDX-License-Identifier: AGPL-3.0-only; recorded synthetic StripeFixtures API exchanges, no live account', ...recorder.tape }, null, 2)
      .replaceAll(f.gymId, '00000000-0000-7000-8000-000000000001').replaceAll(f.invoice.id, '00000000-0000-7000-8000-000000000002')
      .replaceAll(f.attempt.id, '00000000-0000-7000-8000-000000000003') + '\n');
    else replay!.assertConsumed();
  });
});
