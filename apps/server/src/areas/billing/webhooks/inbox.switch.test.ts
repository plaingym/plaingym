// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- Observe the blocking backend in the real Postgres lock-order regression.
import { eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Simulate the settings save's exclusive gym lock in this isolated database.
import { auditEvents, gyms, households, invoices, paymentAttempts, paymentMethods, payments, refunds, stripeEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import type { PaymentObjectReference } from '../../../infra/payments/index.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { stripeTestClearedAction } from '../stripe-writes.js';
import { createWebhookInbox, testEventSkippedAction } from './inbox.js';
import { billingWebhookTypes, registerBillingWebhookHandlers } from './handlers/index.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(type: string, checkoutMode: 'payment' | 'setup' = 'payment') {
  const gymId = uuidv7(), clock = new TestClock('2026-11-02T12:00:00Z');
  await factory('gyms', gymId);
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, status: 'open', number: 1 });
  const attempt = await factory('paymentAttempts', gymId, { invoiceId: invoice.id, paymentIntentId: 'pi_test',
    stripeCustomerId: 'cus_fixture', savedPaymentMethod: 'pm_4242', status: 'requires_action' });
  const transport = new StripeFixtures(gymId, Math.floor(clock.now().getTime() / 1000));
  const provider = new StripePayments(gymId, { clock, transport, mode: 'test', webhookSecret: 'whsec_fixture' });
  const metadata = { gym_id: gymId, invoice_id: invoice.id, attempt_id: attempt.id };
  transport.objects.set('pi_test', { id: 'pi_test', object: 'payment_intent', amount: 10000, currency: 'usd',
    customer: 'cus_fixture', payment_method: 'pm_4242', status: 'succeeded', latest_charge: 'ch_test', metadata });
  transport.objects.set('ch_test', { id: 'ch_test', object: 'charge', payment_intent: 'pi_test', created: transport.now });
  let reference: PaymentObjectReference = { kind: 'charge', id: 'pi_test' };
  if (type.startsWith('refund.') || type === 'charge.refunded' || type.startsWith('charge.dispute.')) {
    await factory('payments', gymId, { invoiceId: invoice.id, method: 'card', paymentIntentId: 'pi_test', chargeId: 'ch_test' });
    await db.forGym(gymId, tx => tx.update(invoices).set({ status: 'paid', paidAt: clock.now() }).where(eq(invoices.id, invoice.id)));
    transport.objects.set('re_test', { id: 're_test', object: 'refund', charge: 'ch_test', amount: 2500, currency: 'usd',
      status: 'succeeded', metadata: {}, created: transport.now });
    transport.objects.set('dp_test', { id: 'dp_test', object: 'dispute', charge: 'ch_test', payment_intent: 'pi_test',
      amount: 10000, currency: 'usd', status: 'needs_response', metadata: {}, created: transport.now });
    if (type.startsWith('refund.')) reference = { kind: 'refund', id: 're_test' };
    if (type.startsWith('charge.dispute.')) reference = { kind: 'dispute', id: 'dp_test' };
  } else if (type.startsWith('checkout.session.')) {
    const asyncDebit = type.startsWith('checkout.session.async_payment_');
    const session = await provider.createCheckout({ mode: checkoutMode, amount: 10000, currency: 'usd', invoiceId: invoice.id,
      ...(asyncDebit ? { bankDebit: { type: 'us_bank_account' as const } } : {}),
      customerId: 'cus_fixture', successUrl: 'https://gym.invalid/ok', cancelUrl: 'https://gym.invalid/cancel',
      saveForOffSession: true, idempotencyKey: 'checkout' });
    const intent = transport.completeCheckout(session.id, { method: asyncDebit ? 'us_bank_account' : 'card' });
    if (asyncDebit) {
      if (type === 'checkout.session.async_payment_failed') intent.payment_method = 'pm_usbank_2227';
      transport.settle(String(intent.id));
    }
    reference = { kind: 'checkout', id: session.id };
  } else if (type === 'setup_intent.succeeded') {
    transport.objects.set('seti_test', { id: 'seti_test', object: 'setup_intent', customer: 'cus_fixture', status: 'succeeded',
      payment_method: 'pm_3155', metadata: { gym_id: gymId } });
    reference = { kind: 'setup', id: 'seti_test' };
  } else if (type.startsWith('payment_method.')) {
    await factory('paymentMethods', gymId, { householdId: household.id, processorId: 'pm_4242', expiryYear: 2029 });
    reference = { kind: 'payment_method', id: 'pm_4242' };
  }
  const read = () => db.forGym(gymId, async tx => ({ payments: await tx.select().from(payments), refunds: await tx.select().from(refunds),
    methods: await tx.select().from(paymentMethods), invoices: await tx.select().from(invoices), attempts: await tx.select().from(paymentAttempts) }));
  const switchMode = async () => {
    // Commit the same gym lock and boundary as a settings save; no provider call runs in this transaction.
    await db.forGym(gymId, async tx => {
      await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, gymId)).for('update');
      await tx.update(households).set({ stripeCustomerId: null }).where(eq(households.id, household.id));
      await tx.update(payments).set({ reference: stripeTestPaymentReference });
      await tx.update(paymentMethods).set({ revokedAt: clock.now(), isDefault: false });
      await tx.update(paymentAttempts).set({ status: 'failed', declineCode: 'test_cleared', resolvedAt: clock.now() });
      await tx.insert(auditEvents).values({ gymId, actorKind: 'system', action: stripeTestClearedAction,
        targetType: 'gym', targetId: gymId, after: {}, occurredAt: clock.now() });
    });
  };
  const jobs = new FakeJobs(clock), eventId = 'evt_' + uuidv7();
  await factory('stripeEvents', gymId, { eventId, type, payload: { id: eventId, gymId, type, objectKind: reference.kind,
    objectId: reference.id, livemode: false } });
  const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock, jobs,
    paymentsFor: async () => provider, gymSettings: { get: async () => ({ timezone: 'UTC' }) } });
  const context = { gymId, clock, timezone: 'UTC', attempt: 1, jobId: uuidv7() };
  const processed = () => db.forGym(gymId, async tx => ({ events: await tx.select().from(stripeEvents),
    audits: await tx.select().from(auditEvents).where(eq(auditEvents.action, testEventSkippedAction)) }));
  return { gymId, clock, provider, transport, inbox, context, eventId, switchMode, read, processed };
}

describe('webhook writes across a committed Stripe test-to-live switch', () => {
  it.each(billingWebhookTypes)('finishes %s as a skipped test event with no handler write', async type => {
    const f = await fixture(type);
    const transitions = createInvoiceTransitions({ scope: db.forGym, clock: f.clock });
    registerBillingWebhookHandlers(f.inbox, { scope: db.forGym, clock: f.clock, transitions });
    let switched = false, saved: Awaited<ReturnType<typeof f.read>>;
    const switchOnce = async () => { if (!switched) { switched = true; await f.switchMode(); saved = await f.read(); } };
    const find = f.provider.findCharge.bind(f.provider), read = f.provider.readPaymentObject.bind(f.provider);
    vi.spyOn(f.provider, 'findCharge').mockImplementation(async (...args) => { const value = await find(...args); await switchOnce(); return value; });
    vi.spyOn(f.provider, 'readPaymentObject').mockImplementation(async (...args) => { const value = await read(...args); await switchOnce(); return value; });
    await f.inbox.dispatch({ eventId: f.eventId }, f.context);
    expect(switched).toBe(true);
    expect(await f.read()).toEqual(saved!);
    const processed = await f.processed();
    expect(processed.events[0]).toMatchObject({ processedAt: f.clock.now(), error: null });
    expect(processed.audits).toHaveLength(1);
  });
  it('guards a setup Checkout card write too', async () => {
    const f = await fixture('checkout.session.completed', 'setup');
    const read = f.provider.readPaymentObject.bind(f.provider);
    vi.spyOn(f.provider, 'readPaymentObject').mockImplementationOnce(async (...args) => {
      const value = await read(...args); await f.switchMode(); return value;
    });
    registerBillingWebhookHandlers(f.inbox, { scope: db.forGym, clock: f.clock,
      transitions: createInvoiceTransitions({ scope: db.forGym, clock: f.clock }) });
    await f.inbox.dispatch({ eventId: f.eventId }, f.context);
    expect((await f.read()).methods).toEqual([]);
    expect((await f.processed()).audits).toHaveLength(1);
  });
  it('rechecks in the transition when the switch commits after handler matching', async () => {
    const f = await fixture('payment_intent.succeeded');
    const transitions = createInvoiceTransitions({ clock: f.clock, scope: async (gymId, work) => {
      await f.switchMode();
      return db.forGym(gymId, work);
    } });
    registerBillingWebhookHandlers(f.inbox, { scope: db.forGym, clock: f.clock, transitions });
    await f.inbox.dispatch({ eventId: f.eventId }, f.context);
    expect((await f.read()).payments).toEqual([]);
    expect((await f.processed()).audits).toHaveLength(1);
  });
  it('waits for a switch holding the gym row, then skips the stale write', async () => {
    const f = await fixture('payment_intent.succeeded');
    registerBillingWebhookHandlers(f.inbox, { scope: db.forGym, clock: f.clock,
      transitions: createInvoiceTransitions({ scope: db.forGym, clock: f.clock }) });
    const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    let saving: Promise<void> | undefined;
    const find = f.provider.findCharge.bind(f.provider);
    vi.spyOn(f.provider, 'findCharge').mockImplementationOnce(async (...args) => {
      const outcome = await find(...args);
      saving = db.forGym(f.gymId, async tx => {
        // eslint-disable-next-line database/system-tables -- Read this test transaction's backend PID for the wait probe.
        const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
        await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)).for('update');
        await tx.insert(auditEvents).values({ gymId: f.gymId, actorKind: 'system', action: stripeTestClearedAction,
          targetType: 'gym', targetId: f.gymId, after: {}, occurredAt: f.clock.now() });
        locked.resolve(pid); await release.promise;
      });
      await locked.promise; return outcome;
    });
    const dispatching = f.inbox.dispatch({ eventId: f.eventId }, f.context);
    try {
      const pid = await locked.promise, until = performance.now() + 5000;
      let waiting = false;
      while (!waiting && performance.now() < until)
        // eslint-disable-next-line database/system-tables -- System connection observes the two occupied gym connections.
        waiting = (await db.system.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
      expect(waiting).toBe(true);
    } finally { release.resolve(); await saving; await dispatching; }
    expect((await f.read()).payments).toEqual([]);
    expect((await f.processed()).audits).toHaveLength(1);
  });
  it('keeps a live event when a switch commits while its live provider is resolved', async () => {
    const f = await fixture('payment_intent.succeeded');
    await db.forGym(f.gymId, tx => tx.update(stripeEvents).set({ payload: { id: f.eventId, gymId: f.gymId,
      type: 'payment_intent.succeeded', objectKind: 'charge', objectId: 'pi_test', livemode: true } }));
    const live = new StripePayments(f.gymId, { transport: f.transport, clock: f.clock, mode: 'live', webhookSecret: 'whsec_fixture' });
    const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock: f.clock, jobs: new FakeJobs(f.clock),
      gymSettings: { get: async () => ({ timezone: 'UTC' }) }, paymentsFor: async () => {
        await factory('auditEvents', f.gymId, { action: stripeTestClearedAction, targetType: 'gym', targetId: f.gymId });
        return live;
      } });
    registerBillingWebhookHandlers(inbox, { scope: db.forGym, clock: f.clock,
      transitions: createInvoiceTransitions({ scope: db.forGym, clock: f.clock }) });
    await inbox.dispatch({ eventId: f.eventId }, f.context);
    expect((await f.read()).payments).toMatchObject([{ method: 'card', reference: null }]);
    expect((await f.processed()).audits).toEqual([]);
  });
});
