// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { readFile, writeFile } from 'node:fs/promises';
import { and, asc, eq } from 'drizzle-orm';
import { allocateInvoiceNumber, auditEvents, households, invoiceLineItems, invoices, memberships, paymentAttempts, paymentMethods, payments, refunds, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { FakeGymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { replayTransport, recordingTransport } from '../../../infra/payments/transport.js';
import { FixtureRecorder, type Tape } from '../../../infra/payments/recording.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import { FakeJobs, PostgresJobs } from '../../../infra/jobs/index.js';
import { FakeEmail } from '../../../infra/email/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createMembershipService } from '../memberships.js';
import { createPaymentService } from '../payments.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { createTransitionEffects } from '../transitions/effects.js';
import { createTransitionJobs } from '../transitions/transitions.jobs.js';
import { createChargeRunner } from './index.js';
import { assignmentInvoiceCondition, isAssignmentInvoice } from './eligibility.js';
import { createRunnerJobs } from './runner.jobs.js';
import { createWebhookInbox } from '../webhooks/inbox.js';
import { composeBillingWebhooks } from '../webhooks/handlers/composition.js';
import { setLogSink } from '../../../core/log.js';
import { createMembersService } from '../../members/members.js';
import { createMembershipRoutes } from '../memberships.routes.js';
import { createApp } from '../../../app.js';
import { authorize } from '../../staff/auth.permissions.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(options: { now?: string; dueOn?: string; interval?: string; anniversaryOn?: string | null;
  startsOn?: string; status?: string; enabled?: boolean; amount?: number; timezone?: string } = {}) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'CAD', timezone: options.timezone ?? 'America/Vancouver', billingEnabled: options.enabled ?? true });
  const clock = new TestClock(options.now ?? '2028-03-01T17:00:00Z');
  const home = await factory('households', gymId, { billingDay: 1, stripeCustomerId: 'cus_test' });
  const member = await factory('members', gymId, { householdId: home.id });
  const plan = await factory('plans', gymId, { interval: options.interval ?? 'monthly', amountCents: options.amount ?? 10000 });
  const membership = await factory('memberships', gymId, { householdId: home.id, memberId: member.id, planId: plan.id,
    status: options.status ?? 'active', interval: options.interval ?? 'monthly', amountCents: options.amount ?? 10000,
    startsOn: options.startsOn ?? '2028-01-01', nextDueOn: options.dueOn ?? '2028-03-01', anniversaryOn: options.anniversaryOn ?? null });
  await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_test', isDefault: true });
  const settings = new FakeGymSettingsAccessor([await createGymSettingsAccessor({ scope: db.forGym }).get(gymId)]);
  const provider = new FakePayments(gymId, clock);
  provider.seedCustomer({ id: 'cus_test', email: 'payer@example.invalid' });
  const serviceOptions = { scope: db.forGym, clock, settings, jobs: new FakeJobs(clock) };
  const transitions = createInvoiceTransitions(serviceOptions);
  const runner = createChargeRunner({ ...serviceOptions, transitions, async payments() { return provider; } });
  const context = { jobId: uuidv7(), gymId, timezone: options.timezone ?? 'America/Vancouver', attempt: 1, clock };
  const read = () => db.forGym(gymId, async tx => ({
    invoices: await tx.select().from(invoices).orderBy(asc(invoices.dueOn)),
    attempts: await tx.select().from(paymentAttempts).orderBy(asc(paymentAttempts.attemptNumber)),
    payments: await tx.select().from(payments), refunds: await tx.select().from(refunds),
    memberships: await tx.select().from(memberships), lines: await tx.select().from(invoiceLineItems), audits: await tx.select().from(auditEvents),
  }));
  const enable = async (billingEnabled: boolean) => settings.set({ ...await settings.get(gymId), billingEnabled });
  return { gymId, clock, home, member, plan, membership, settings, provider, serviceOptions, transitions, runner, context, read, enable };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function invoice(f: Fixture) {
  const number = await db.forGym(f.gymId, tx => allocateInvoiceNumber(tx, f.gymId));
  return factory('invoices', f.gymId, { householdId: f.home.id, kind: 'cycle', status: 'open', number,
    dueOn: '2028-03-01', periodStartsOn: '2028-03-01', periodEndsOn: '2028-04-01' });
}
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
async function checkout(f: Fixture, invoiceId: string) {
  const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', amount: 10000, currency: 'cad',
    invoiceId, successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel',
    saveForOffSession: true, idempotencyKey: invoiceId + ':checkout' });
  await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: session.id }).where(eq(invoices.id, invoiceId)));
  return session;
}

describe('charge runner with PostgreSQL', () => {
  it('holds erased household invoices through collection and dunning, and permits staff review without a saved card', async () => {
    const f = await fixture(), other = await fixture();
    const bill = await invoice(f);
    const number = await db.forGym(f.gymId, tx => allocateInvoiceNumber(tx, f.gymId));
    const pastDue = await factory('invoices', f.gymId, { householdId: f.home.id, number, kind: 'cycle', status: 'past_due',
      dueOn: '2028-02-01', periodStartsOn: '2028-02-01', periodEndsOn: '2028-03-01' });
    await factory('auditEvents', f.gymId, { action: 'billing.invoice.dunning_started', targetType: 'invoice', targetId: pastDue.id,
      occurredAt: new Date(f.clock.now().getTime() - 3 * 86400000), after: { retryDays: [3, 7] } });
    const create = vi.spyOn(f.provider, 'createCharge');
    const members = createMembersService({ scope: db.forGym, clock: f.clock });
    await members.eraseMember({ gymId: f.gymId, actor: { kind: 'system' } }, f.member.id, { revision: 1 });
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
    for (const invoiceId of [bill.id, pastDue.id]) expect(await f.runner.charge(f.gymId, invoiceId, { mode: 'retry' }))
      .toEqual({ status: 'skipped', reason: 'needs_review' });
    await f.runner.retry(pastDue.id, f.context);
    expect(create).not.toHaveBeenCalled();
    const owner = await factory('authUser', f.gymId);
    const context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: owner.id } };
    const service = createPaymentService({ ...f.serviceOptions, transitions: f.transitions, runner: f.runner });
    expect(await service.getInvoice(f.gymId, bill.id)).toMatchObject({ invoice: { id: bill.id, needsReview: true } });
    await expect(service.releaseHold({ ...context, gymId: other.gymId }, bill.id)).rejects.toMatchObject({ code: 'not_found' });
    for (const invoiceId of [bill.id, pastDue.id]) await service.releaseHold(context, invoiceId);
    expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'no_saved_card' });
    expect(await f.runner.charge(f.gymId, pastDue.id, { mode: 'retry' })).toEqual({ status: 'skipped', reason: 'no_saved_card' });
    expect((await f.read()).attempts).toEqual([]);
    expect((await other.read()).invoices).toEqual([]);
  });
  it.each([
    ['4242', 'direct'], ['0341', 'direct'], ['3184', 'direct'], ['4242', 'pending'], ['4242', 'restore'],
  ])('replays recorded Stripe card %s through %s collection and reconciliation', async (card, mode) => {
    const f = await fixture(), location = new URL(`./stripe.${card}.${mode}.synthetic.json`, import.meta.url);
    const recording = process.env.RECORD_RUNNER_FIXTURES === '1', recorder = new FixtureRecorder(f.gymId);
    const transport = new StripeFixtures(f.gymId, Math.floor(f.clock.now().getTime() / 1000));
    transport.objects.set('cus_test', { ...transport.objects.get('cus_fixture')!, id: 'cus_test' });
    // Keep the fixture card ID so its synthetic processor selects the expected outcome.
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ processorId: `pm_${card}` }).where(eq(paymentMethods.householdId, f.home.id)));
    transport.objects.set(`pm_${card}`, { ...transport.objects.get(`pm_${card}`)!, customer: 'cus_test' });
    let replay: ReturnType<typeof replayTransport> | undefined;
    const recorded = recordingTransport(transport, recorder);
    const provider = new StripePayments(f.gymId, { clock: f.clock, webhookSecret: 'fixture-secret', transport: {
      async request(input) {
        if (recording) return recorded.request(input);
        if (!replay) {
          const attempt = (await f.read()).attempts[0]!;
          const tape = (await readFile(location, 'utf8')).replaceAll('00000000-0000-7000-8000-000000000001', f.gymId)
            .replaceAll('00000000-0000-7000-8000-000000000002', attempt.invoiceId)
            .replaceAll('00000000-0000-7000-8000-000000000003', attempt.id);
          replay = replayTransport(JSON.parse(tape) as Tape, f.gymId);
        }
        return replay.request(input);
      },
    } });
    if (mode !== 'direct') {
      const confirm = provider.confirmCharge.bind(provider);
      vi.spyOn(provider, 'confirmCharge').mockImplementationOnce(async (id, options) => {
        await confirm(id, options); throw new Error('Confirmation response lost');
      });
    }
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: async () => provider });
    expect((await runner.daily(f.gymId)).errors).toHaveLength(mode === 'direct' ? 0 : 1);
    const succeededAt = f.clock.now();
    if (mode !== 'direct') {
      f.clock.advance(3 * 86400000); await f.enable(false);
      if (mode === 'pending') expect((await runner.reconcile(f.gymId)).issues).toEqual([]);
      else expect(await runner.postRestore(f.gymId, succeededAt)).toMatchObject({ readyForOwnerReview: true, issues: [] });
    }
    const rows = await f.read(), attempt = rows.attempts[0]!;
    expect(rows.invoices[0]!.status).toBe(card === '4242' ? 'paid' : 'past_due');
    expect(attempt.status).toBe(card === '4242' ? 'succeeded' : card === '3184' ? 'requires_action' : 'failed');
    if (card === '4242') {
      expect(rows.payments).toHaveLength(1);
      expect(rows.payments[0]).toMatchObject({ chargeId: 'ch_2', paidAt: succeededAt });
      expect(rows.invoices[0]!.paidAt).toEqual(succeededAt);
    }
    if (recording) await writeFile(location, JSON.stringify({
      $comment: 'SPDX-License-Identifier: AGPL-3.0-only; recorded synthetic StripeFixtures API exchanges, no live account', ...recorder.tape,
    }, null, 2).replaceAll(f.gymId, '00000000-0000-7000-8000-000000000001')
      .replaceAll(attempt.invoiceId, '00000000-0000-7000-8000-000000000002')
      .replaceAll(attempt.id, '00000000-0000-7000-8000-000000000003') + '\n');
    else replay!.assertConsumed();
  });
  it('does nothing with billing disabled, including direct charges and retry callbacks', async () => {
    const f = await fixture({ enabled: false }), bill = await invoice(f);
    const create = vi.spyOn(f.provider, 'createCharge'), adopt = vi.spyOn(f.provider, 'adoptCustomer');
    expect(await f.runner.daily(f.gymId)).toMatchObject({ generatedPeriods: 0, attempted: 0 });
    await f.runner.charge(f.gymId, bill.id); await f.runner.retry(bill.id, f.context);
    expect(create).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect((await f.read()).attempts).toHaveLength(0);
  });
  it('commits the immutable reservation before adoption/create and the ID before confirmation, outside transactions', async () => {
    const f = await fixture();
    const originalCreate = f.provider.createCharge.bind(f.provider), originalConfirm = f.provider.confirmCharge.bind(f.provider);
    const adopt = vi.spyOn(f.provider, 'adoptCustomer');
    vi.spyOn(f.provider, 'createCharge').mockImplementation(async request => {
      const rows = await f.read();
      expect(rows.attempts).toHaveLength(1);
      expect(rows.attempts[0]).toMatchObject({ status: 'pending', paymentIntentId: null, stripeCustomerId: request.customerId,
        amountCents: request.amount, savedPaymentMethod: request.paymentMethodId });
      expect(adopt).toHaveBeenCalledWith('cus_test');
      expect(request.idempotencyKey).toBe(`${request.invoiceId}:1:create`);
      return originalCreate(request);
    });
    vi.spyOn(f.provider, 'confirmCharge').mockImplementation(async (id, options) => {
      expect((await f.read()).attempts[0]).toMatchObject({ paymentIntentId: id, status: 'pending' });
      expect(options.idempotencyKey).toBe(`${(await f.read()).invoices[0]!.id}:1:confirm`);
      return originalConfirm(id, options);
    });
    expect((await f.runner.daily(f.gymId)).errors).toEqual([]);
    const rows = await f.read();
    expect(rows.invoices[0]!.status).toBe('paid'); expect(rows.payments).toHaveLength(1);
    const outcome = await f.provider.findCharge({ kind: 'charge', id: rows.attempts[0]!.paymentIntentId! });
    expect(rows.payments[0]!.chargeId).toBe('latestChargeId' in outcome ? outcome.latestChargeId : undefined);
    expect(rows.memberships[0]!.nextDueOn).toBe('2028-04-01');
  });
  it('refuses a customer that cannot be adopted without creating an intent', async () => {
    const f = await fixture();
    vi.spyOn(f.provider, 'adoptCustomer').mockRejectedValue(new Error('Customer belongs to another gym'));
    const create = vi.spyOn(f.provider, 'createCharge');
    expect((await f.runner.daily(f.gymId)).errors).toHaveLength(1);
    expect(create).not.toHaveBeenCalled(); expect((await f.read()).attempts[0]).toMatchObject({ status: 'failed', declineCode: 'create_abandoned', resolvedAt: f.clock.now() });
  });
  it.each(['disabled', 'settings_failure'] as const)('abandons the unstarted reservation after %s and permits an immediate retry', async failure => {
    const f = await fixture(), bill = await invoice(f);
    const adopt = f.provider.adoptCustomer.bind(f.provider);
    const settings = vi.spyOn(f.settings, 'get');
    vi.spyOn(f.provider, 'adoptCustomer').mockImplementationOnce(async id => {
      const result = await adopt(id);
      if (failure === 'disabled') await f.enable(false);
      else settings.mockRejectedValueOnce(new Error('Settings unavailable'));
      return result;
    });
    const create = vi.spyOn(f.provider, 'createCharge');
    if (failure === 'disabled') expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'billing_disabled' });
    else await expect(f.runner.charge(f.gymId, bill.id)).rejects.toThrow('Settings unavailable');
    expect(create).not.toHaveBeenCalled();
    expect((await f.read()).attempts[0]).toMatchObject({ status: 'failed', declineCode: 'create_abandoned', paymentIntentId: null, resolvedAt: f.clock.now() });
    await f.enable(true);
    expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'succeeded' });
    expect((await f.read()).attempts.map(row => row.status)).toEqual(['failed', 'succeeded']);
  });
  it('serializes concurrent daily runs, consolidates same-date memberships and keeps independent dates separate', async () => {
    const f = await fixture();
    const sibling = await factory('members', f.gymId, { householdId: f.home.id });
    await factory('memberships', f.gymId, { householdId: f.home.id, memberId: sibling.id, planId: f.plan.id,
      status: 'active', startsOn: '2028-01-01', nextDueOn: '2028-03-01' });
    await Promise.all([f.runner.daily(f.gymId), f.runner.daily(f.gymId), f.runner.daily(f.gymId)]);
    await f.runner.daily(f.gymId);
    const rows = await f.read();
    expect(rows.invoices).toHaveLength(1); expect(rows.invoices[0]!.amountCents).toBe(20000);
    expect(rows.payments).toHaveLength(1); expect(rows.attempts).toHaveLength(1); expect(rows.lines).toHaveLength(2);
  });
  it('uses the gym date, catches up a missed day and holds periods over seven days old', async () => {
    const f = await fixture({ now: '2028-03-02T07:59:00Z', dueOn: '2028-02-01' });
    await f.runner.daily(f.gymId);
    let rows = await f.read();
    expect(rows.invoices.map(row => [row.dueOn, row.needsReview, row.status])).toEqual([
      ['2028-02-01', true, 'open'], ['2028-03-01', false, 'paid'],
    ]);
    expect(rows.payments).toHaveLength(1);
    const next = await fixture({ now: '2028-03-02T17:00:00Z' });
    await next.runner.daily(next.gymId); rows = await next.read();
    expect(rows.invoices[0]).toMatchObject({ dueOn: '2028-03-01', status: 'paid' });
  });
  it('does not bill a future local date, or frozen/cancelled memberships', async () => {
    for (const status of ['active', 'frozen', 'cancelled']) {
      const f = await fixture({ status, now: '2028-03-01T06:59:00Z' });
      await f.runner.daily(f.gymId); expect((await f.read()).payments).toHaveLength(0);
      if (status !== 'active') {
        f.clock.set('2028-03-01T17:00:00Z'); await f.runner.daily(f.gymId);
        expect((await f.read()).invoices).toHaveLength(0);
      }
    }
  });
  it('holds an already-issued unpaid period after a long outage', async () => {
    const f = await fixture(); const bill = await invoice(f);
    f.clock.set('2028-03-09T17:00:00Z'); await f.runner.daily(f.gymId);
    expect((await f.read()).invoices.find(row => row.id === bill.id)).toMatchObject({ status: 'open', needsReview: true });
    expect((await f.read()).payments).toHaveLength(0);
  });
  it('retains annual February 29 anniversaries through 2029–2032, including imported starts and legacy nulls', async () => {
    for (const imported of [false, true]) {
      const f = await fixture({ interval: 'annual', dueOn: '2029-02-28', startsOn: imported ? '2028-01-10' : '2028-02-29',
        anniversaryOn: imported ? '2028-02-29' : null, now: '2029-02-28T17:00:00Z' });
      for (const day of ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']) {
        f.clock.set(`${day}T17:00:00Z`); await f.runner.daily(f.gymId);
      }
      const rows = await f.read();
      expect(rows.invoices.map(row => row.dueOn)).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
      expect(rows.payments).toHaveLength(4); expect(rows.memberships[0]!.nextDueOn).toBe('2033-02-28');
      expect(rows.memberships[0]!.anniversaryOn).toBe(imported ? '2028-02-29' : null);
    }
  });
  it.each(['zero plan', 'full discount'])('settles a zero cycle without a card, attempt or provider call: %s', async kind => {
    const f = await fixture({ amount: kind === 'zero plan' ? 0 : 10000 });
    await db.forGym(f.gymId, async tx => {
      await tx.update(households).set({ stripeCustomerId: null, familyDiscountBasisPoints: kind === 'full discount' ? 10000 : 0 })
        .where(eq(households.id, f.home.id));
      await tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.householdId, f.home.id));
    });
    const resolveProvider = vi.fn(async () => { throw new Error('No provider should be resolved'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: resolveProvider });
    await runner.daily(f.gymId); await runner.daily(f.gymId);
    expect((await f.read()).invoices[0]).toMatchObject({ amountCents: 0, needsReview: false, status: 'paid' });
    expect((await f.read()).attempts).toHaveLength(0); expect((await f.read()).payments).toHaveLength(0);
    expect(resolveProvider).not.toHaveBeenCalled();
  });
  it('issues assignment proration and sign-up fees atomically through the injectable hook', async () => {
    const f = await fixture();
    const lifecycle = createMembershipService({ ...f.serviceOptions, onAssigned: f.runner.onAssigned });
    const member = await factory('members', f.gymId, { householdId: f.home.id });
    const plan = await factory('plans', f.gymId, { signupFeeCents: 2500 });
    const request = { id: uuidv7(), householdId: f.home.id, memberId: member.id, planId: plan.id,
      startsOn: '2028-03-10', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' as const };
    await lifecycle.assign({ gymId: f.gymId, actor: { kind: 'system' } }, request);
    await lifecycle.assign({ gymId: f.gymId, actor: { kind: 'system' } }, request);
    const rows = await f.read();
    expect(rows.invoices).toHaveLength(2); expect(rows.invoices.map(row => row.amountCents).sort()).toEqual([2500, 7097]);
    expect(rows.attempts).toHaveLength(0);
  });
  it('cannot charge or reconcile another gym invoice', async () => {
    const a = await fixture(), b = await fixture(), bill = await invoice(b);
    expect(await a.runner.charge(a.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'not_payable' });
    expect((await b.read()).attempts).toHaveLength(0);
    await a.runner.reconcile(a.gymId); expect((await b.read()).invoices[0]!.status).toBe('open');
  });
});

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
    expect(rows.attempts[0]).toMatchObject({ status: 'failed', declineCode: 'intent_canceled' });
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
  async function oneOff(f: Fixture, kind: 'charge' | 'membership' = 'charge') {
    const bill = await invoice(f);
    await db.forGym(f.gymId, async tx => {
      await tx.update(invoices).set({ kind: 'one_off', periodStartsOn: null, periodEndsOn: null }).where(eq(invoices.id, bill.id));
      await tx.update(memberships).set({ status: 'cancelled' }).where(eq(memberships.id, f.membership.id));
    });
    await factory('invoiceLineItems', f.gymId, { householdId: f.home.id, invoiceId: bill.id, kind,
      ...(kind === 'membership' ? { membershipId: f.membership.id } : {}) });
    return bill;
  }
  async function assign(f: Fixture, amount = 10000, fee = 2500) {
    const plan = await factory('plans', f.gymId, { amountCents: amount, signupFeeCents: fee });
    const member = await factory('members', f.gymId, { householdId: f.home.id });
    const lifecycle = createMembershipService({ ...f.serviceOptions, onAssigned: f.runner.onAssigned });
    const membership = await lifecycle.assign({ gymId: f.gymId, actor: { kind: 'system' } }, { id: uuidv7(),
      householdId: f.home.id, memberId: member.id, planId: plan.id, startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' });
    return { membership, lifecycle };
  }
  it.each([
    ['cycle', 'cycle', ['membership'], true],
    ['assignment', 'one_off', ['membership', 'signup_fee'], true],
    ['discounted and taxed assignment', 'one_off', ['membership', 'signup_fee', 'discount', 'tax'], true],
    ['staff charge', 'one_off', ['charge'], false],
    ['mixed staff charge', 'one_off', ['membership', 'charge'], false],
    ['empty invoice', 'one_off', [], false],
  ] as const)('SQL and application assignment predicates agree for %s', async (_name, kind, kinds, expected) => {
    const f = await fixture(), bill = await invoice(f);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ kind }).where(eq(invoices.id, bill.id)));
    for (const lineKind of kinds) await factory('invoiceLineItems', f.gymId, {
      householdId: f.home.id, invoiceId: bill.id, kind: lineKind,
      ...(lineKind === 'membership' ? { membershipId: f.membership.id } : {}),
      ...(lineKind === 'tax' ? { taxRateMillionths: 50000, taxInclusive: false } : {}),
    });
    await db.forGym(f.gymId, async tx => {
      const matching = await tx.select({ id: invoices.id }).from(invoices)
        .where(and(eq(invoices.id, bill.id), assignmentInvoiceCondition(tx)));
      expect(matching.length > 0).toBe(expected);
      expect(await isAssignmentInvoice(tx, bill.id)).toBe(expected);
    });
  });
  it.each([
    ['cycle', false], ['assignment', false], ['cycle', true], ['assignment', true],
  ] as const)('keeps a released %s invoice released through daily collection (declined: %s)', async (kind, declined) => {
    const f = await fixture({ status: 'cancelled' });
    const bill = kind === 'cycle' ? await invoice(f) : await oneOff(f, 'membership');
    f.clock.set('2028-03-11T17:00:00Z');
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
    expect((await f.read()).invoices[0]).toMatchObject({ id: bill.id, needsReview: true });
    const owner = await factory('authUser', f.gymId);
    await factory('staffRoles', f.gymId, { userId: owner.id, role: 'owner' });
    const service = createPaymentService({ ...f.serviceOptions, transitions: f.transitions, runner: f.runner,
      paymentsFor: async () => f.provider });
    const create = vi.spyOn(f.provider, 'createCharge');
    await service.releaseHold({ gymId: f.gymId, actor: { kind: 'user', userId: owner.id } }, bill.id);
    expect(create).not.toHaveBeenCalled();
    if (declined) f.provider.respondNextConfirmation('declined');
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 1, errors: [] });
    f.clock.advance(86400000);
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
    const rows = await f.read();
    expect(rows.invoices[0]).toMatchObject({ id: bill.id, needsReview: false,
      status: declined ? kind === 'cycle' ? 'past_due' : 'open' : 'paid' });
    expect(rows.attempts).toHaveLength(1);
    expect(rows.attempts[0]!.status).toBe(declined ? 'failed' : 'succeeded');
    expect(rows.payments).toHaveLength(declined ? 0 : 1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(rows.audits.filter(row => row.action === 'billing.runner.overdue_held' && row.targetId === bill.id)).toHaveLength(1);
    expect(rows.audits.filter(row => row.action === 'billing.invoice.review_released' && row.targetId === bill.id)).toHaveLength(1);
    expect(rows.audits.filter(row => row.action === 'billing.invoice.dunning_started')).toHaveLength(declined && kind === 'cycle' ? 1 : 0);
  });
  it.each(['cycle', 'assignment'] as const)('keeps an unreleased %s invoice held on every daily run', async kind => {
    const f = await fixture({ status: 'cancelled' });
    const bill = kind === 'cycle' ? await invoice(f) : await oneOff(f, 'membership');
    const create = vi.spyOn(f.provider, 'createCharge');
    f.clock.set('2028-03-11T17:00:00Z');
    for (let day = 0; day < 3; day++) {
      expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
      expect((await f.read()).invoices[0]).toMatchObject({ id: bill.id, status: 'open', needsReview: true });
      f.clock.advance(86400000);
    }
    const rows = await f.read();
    expect(rows.audits.filter(row => row.action === 'billing.runner.overdue_held')).toHaveLength(1);
    expect(rows.attempts).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
  it('collects assignment proration and sign-up fees after commit, without collecting another household', async () => {
    const f = await fixture();
    const create = vi.spyOn(f.provider, 'createCharge');
    await assign(f); expect(create).not.toHaveBeenCalled();
    const other = await fixture(); await assign(other);
    expect(await f.runner.collectAssigned(f.gymId, other.home.id)).toEqual({ attempted: 0, errors: [] });
    expect(await f.runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 2, errors: [] });
    expect((await f.read()).payments.map(row => row.amountCents).sort()).toEqual([10000, 2500]);
    expect(await f.runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 0, errors: [] });
    expect((await other.read()).payments).toHaveLength(0);
  });
  it('holds old assignment charges when a card arrives late, and lets staff collect after releasing the hold', async () => {
    const f = await fixture({ dueOn: '2028-04-01' });
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.householdId, f.home.id)));
    await assign(f);
    expect(await f.runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 0, errors: [] });
    const staffInvoice = await oneOff(f);
    f.clock.set('2028-03-11T17:00:00Z');
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.householdId, f.home.id)));
    const create = vi.spyOn(f.provider, 'createCharge');
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
    expect(create).not.toHaveBeenCalled();
    let rows = await f.read();
    const held = rows.invoices.filter(row => row.id !== staffInvoice.id);
    expect(held).toHaveLength(2);
    expect(held.every(row => row.status === 'open' && row.needsReview)).toBe(true);
    expect(rows.invoices.find(row => row.id === staffInvoice.id)!.needsReview).toBe(false);
    await f.runner.daily(f.gymId);
    expect((await f.read()).audits.filter(row => row.action === 'billing.runner.overdue_held')).toHaveLength(2);
    const owner = await factory('authUser', f.gymId);
    await factory('staffRoles', f.gymId, { userId: owner.id, role: 'owner' });
    const context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: owner.id } };
    const service = createPaymentService({ ...f.serviceOptions, transitions: f.transitions, runner: f.runner, paymentsFor: async () => f.provider });
    for (const bill of held) {
      await service.releaseHold(context, bill.id);
      await service.charge(context, bill.id);
    }
    rows = await f.read();
    expect(rows.payments).toHaveLength(2);
    expect(rows.invoices.filter(row => row.id !== staffInvoice.id).every(row => row.status === 'paid' && !row.needsReview)).toBe(true);
  });
  it.each([6, 7])('automatically collects assignment invoices %i days overdue', async days => {
    const f = await fixture({ dueOn: '2028-04-01' });
    await assign(f);
    f.clock.advance(days * 86400000);
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 2, errors: [] });
    const rows = await f.read();
    expect(rows.payments).toHaveLength(2);
    expect(rows.invoices.every(row => row.status === 'paid' && !row.needsReview)).toBe(true);
  });
  it('activates a zero-value assigned membership through the normal effect job without a receipt', async () => {
    const f = await fixture(); const { membership, lifecycle } = await assign(f, 0, 0);
    const resolveProvider = vi.fn(async () => { throw new Error('No Stripe configuration'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: resolveProvider });
    expect(await runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 1, errors: [] });
    const jobs = new FakeJobs(f.clock), notifications = { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}), staffNotice: vi.fn(async () => {}) };
    const effects = createTransitionEffects({ ...f.serviceOptions, jobs, transitions: f.transitions, memberships: lifecycle,
      payments: resolveProvider, notifications, retry: runner.retry });
    for (const job of createTransitionJobs(() => effects)) jobs.handle(job.id, job.handler);
    await effects.publish(f.gymId); while (await jobs.runNext()) { /* activate membership */ }
    expect((await lifecycle.get(f.gymId, membership.id)).status).toBe('active');
    expect((await f.read()).payments).toHaveLength(0); expect((await f.read()).attempts).toHaveLength(0);
    expect(notifications.receipt).not.toHaveBeenCalled(); expect(resolveProvider).not.toHaveBeenCalled();
  });
  it('daily collects assignment invoices but leaves staff charge and mixed invoices open', async () => {
    const f = await fixture(); const staff = await oneOff(f);
    await assign(f);
    const mixedNumber = await db.forGym(f.gymId, tx => allocateInvoiceNumber(tx, f.gymId));
    const mixed = await factory('invoices', f.gymId, { householdId: f.home.id, status: 'open', number: mixedNumber, dueOn: '2028-03-01' });
    for (const kind of ['membership', 'charge']) await factory('invoiceLineItems', f.gymId,
      { householdId: f.home.id, invoiceId: mixed.id, kind, amountCents: 5000 });
    await f.runner.daily(f.gymId);
    const rows = await f.read();
    expect(rows.invoices.find(row => row.id === staff.id)!.status).toBe('open');
    expect(rows.invoices.find(row => row.id === mixed.id)!.status).toBe('open');
    expect(rows.payments).toHaveLength(2);
    expect(await f.runner.charge(f.gymId, staff.id)).toEqual({ status: 'skipped', reason: 'not_auto_collectable' });
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
  it('keeps identifiers and safe error details while continuing other invoices', async () => {
    const f = await fixture(); await assign(f);
    vi.spyOn(f.provider, 'adoptCustomer').mockRejectedValueOnce(Object.assign(new Error('private payer@example.test params: secret'), { code: 'ECONNRESET' }));
    const logs: string[] = [], prior = setLogSink(line => logs.push(line));
    try {
      const result = await f.runner.collectAssigned(f.gymId, f.home.id);
      expect(result.errors).toEqual([{ invoiceId: expect.any(String) }]);
      expect(logs.map(line => JSON.parse(line) as object)).toContainEqual(expect.objectContaining({
        invoiceId: result.errors[0]!.invoiceId, error: expect.objectContaining({ name: 'Error', code: 'ECONNRESET' }),
      }));
      expect(JSON.stringify({ logs, result })).not.toMatch(/payer@example|params: secret|private/);
      expect(JSON.parse(logs[0]!)).not.toHaveProperty('message');
      expect((await f.read()).payments).toHaveLength(1);
    } finally { setLogSink(prior); }
  });
  it('logs the invoice ID when assigned collection fails after the assignment route commits', async () => {
    const f = await fixture({ dueOn: '2028-04-01' }), user = await factory('authUser', f.gymId);
    const member = await factory('members', f.gymId, { householdId: f.home.id });
    const lifecycle = createMembershipService({ ...f.serviceOptions, onAssigned: f.runner.onAssigned });
    vi.spyOn(f.provider, 'adoptCustomer').mockRejectedValueOnce(new Error('Private payer failure'));
    const app = createApp({ clock: f.clock, skipSetup: true, authorize,
      contributions: { routes: createMembershipRoutes(lifecycle, { assigned: f.runner.collectAssigned }) },
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: user.id, roles: ['owner'] } }); await next(); },
    });
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    try {
      const response = await app.request('https://gym.invalid/api/billing/memberships', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ householdId: f.home.id, memberId: member.id, planId: f.plan.id, startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }) });
      expect(response.status).toBe(201);
      const [invoice] = (await f.read()).invoices;
      expect(invoice).toBeDefined();
      expect(logs.map(line => JSON.parse(line) as object)).toContainEqual(expect.objectContaining({
        event: 'billing.collect_assigned', gymId: f.gymId, invoiceId: invoice!.id,
      }));
      expect(logs.join('\n')).not.toContain('Private payer failure');
    } finally { setLogSink(previous); }
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
      expect.objectContaining({ before: { disputeId: null, disputeStatus: null }, after: { disputeId: 'dp_original', disputeStatus: 'open' } }),
      expect.objectContaining({ before: { disputeId: 'dp_original', disputeStatus: 'open' }, after: { disputeId: 'dp_original', disputeStatus: terminal } }),
    ]));
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
    expect(rows.invoices[0]!.status).toBe(winner === 'confirm wins' ? 'paid' : 'past_due');
    expect(rows.attempts[0]!.status).toBe(winner === 'confirm wins' ? 'succeeded' : 'failed');
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

describe('retry schedule and Checkout exclusion', () => {
  it('shares webhook transitions for assignment collection and attaches the real retry to the effect worker', async () => {
    const f = await fixture(), jobs = new FakeJobs(f.clock), email = new FakeEmail();
    const paymentsFor = async () => f.provider;
    const inbox = createWebhookInbox({ ...f.serviceOptions, jobs, paymentsFor, gymSettings: f.settings });
    const billing = composeBillingWebhooks({ ...f.serviceOptions, inbox, jobs, paymentsFor,
      prepare: async () => ({ email, origin: 'https://gym.example.invalid' }), staffRecipients: async () => [] });
    const runner = createChargeRunner({ ...f.serviceOptions, jobs, transitions: billing.transitions, payments: paymentsFor });
    const retry = vi.spyOn(runner, 'retry');
    billing.attachRetry(runner.retry);
    const lifecycle = createMembershipService({ ...f.serviceOptions, onAssigned: runner.onAssigned });
    for (const job of [...createRunnerJobs(() => runner), ...createTransitionJobs(() => billing.effects)]) jobs.handle(job.id, job.handler);
    const member = await factory('members', f.gymId, { householdId: f.home.id });
    const plan = await factory('plans', f.gymId, { amountCents: 10000, signupFeeCents: 2500 });
    const assigned = await lifecycle.assign({ gymId: f.gymId, actor: { kind: 'system' } }, { id: uuidv7(),
      householdId: f.home.id, memberId: member.id, planId: plan.id, startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' });
    expect((await f.read()).attempts).toHaveLength(0);
    expect(await runner.collectAssigned(f.gymId, f.home.id)).toMatchObject({ attempted: 2, errors: [] });
    while (await jobs.runNext()) { /* effects activate the assigned membership */ }
    expect((await f.read()).memberships.find(row => row.id === assigned.id)!.status).toBe('active');
    expect((await f.read()).invoices.filter(row => row.kind === 'one_off').every(row => row.status === 'paid')).toBe(true);
    f.provider.respondNextConfirmation('declined');
    await jobs.enqueue('billing.runner.daily', {}, { gymId: f.gymId, timezone: f.context.timezone });
    while (await jobs.runNext()) { /* daily collection publishes dunning and retry effects after commit */ }
    const cycle = (await f.read()).invoices.find(row => row.kind === 'cycle')!;
    expect(cycle.status).toBe('past_due'); expect(retry).not.toHaveBeenCalled();
    expect(jobs.jobs.some(job => job.name === 'billing.transitions.effect' && job.runAt > f.clock.now())).toBe(true);
    f.clock.set('2028-03-04T17:00:00Z');
    while (await jobs.runNext()) { /* the day-three effect delegates to runner.retry */ }
    expect(retry).toHaveBeenCalledExactlyOnceWith(cycle.id, expect.objectContaining({ gymId: f.gymId }));
    const rows = await f.read();
    expect(rows.invoices.find(row => row.id === cycle.id)!.status).toBe('paid');
    expect(rows.attempts.filter(row => row.invoiceId === cycle.id)).toHaveLength(2);
  });
  it('runs days 3 and 7 at 09:00 local time across DST, with one attempt per window and no day 14', async () => {
    const f = await fixture({ now: '2028-03-08T14:00:00Z', dueOn: '2028-03-08', timezone: 'America/New_York' });
    f.provider.respondNextConfirmation('declined'); await f.runner.daily(f.gymId);
    const bill = (await f.read()).invoices[0]!;
    for (const [time, count] of [['2028-03-11T13:59:59Z', 1], ['2028-03-11T14:00:00Z', 2],
      ['2028-03-15T12:59:59Z', 2], ['2028-03-15T13:00:00Z', 3], ['2028-03-22T13:00:00Z', 3]] as const) {
      f.clock.set(time); f.provider.respondNextConfirmation('declined');
      await Promise.all([f.runner.retry(bill.id, f.context), f.runner.retry(bill.id, f.context)]);
      expect((await f.read()).attempts).toHaveLength(count);
    }
    expect((await f.read()).invoices[0]!.status).toBe('past_due');
  });
  it('expires an open pay link before reserving a retry', async () => {
    const f = await fixture(); f.provider.respondNextConfirmation('declined'); await f.runner.daily(f.gymId);
    const bill = (await f.read()).invoices[0]!, session = await checkout(f, bill.id);
    f.clock.set('2028-03-04T17:00:00Z');
    const expire = vi.spyOn(f.provider, 'expireCheckout');
    const create = f.provider.createCharge.bind(f.provider);
    vi.spyOn(f.provider, 'createCharge').mockImplementation(async request => {
      expect(expire).toHaveBeenCalledWith(session.id);
      expect(await f.provider.readPaymentObject({ kind: 'checkout', id: session.id })).toMatchObject({ value: { object: { status: 'expired' } } });
      return create(request);
    });
    await f.runner.retry(bill.id, f.context); expect((await f.read()).payments).toHaveLength(1);
  });
  it.each(['2028-03-08T17:00:00Z', '2028-03-11T17:00:00Z'])(
    'durably resumes an abandoned day-three create once, then retries day seven once at %s', async daySeven => {
      const f = await fixture(), queue = new PostgresJobs({ database: db, clock: f.clock });
      const continuations = new Map<string, Date | undefined>(), enqueue = queue.enqueue.bind(queue);
      vi.spyOn(queue, 'enqueue').mockImplementation(async (name, payload, options) => {
        const result = await enqueue(name, payload, options);
        if (name === 'billing.runner.retry' && !continuations.has(result.jobId)) continuations.set(result.jobId, options.runAt);
        return result;
      });
      const runner = createChargeRunner({ ...f.serviceOptions, jobs: queue, transitions: f.transitions, payments: async () => f.provider });
      const effects = createTransitionEffects({ ...f.serviceOptions, jobs: queue, transitions: f.transitions,
        memberships: createMembershipService(f.serviceOptions), payments: async () => f.provider, retry: runner.retry,
        notifications: { receipt: async () => {}, dunning: async () => {}, staffNotice: async () => {} } });
      const register = (worker: PostgresJobs) => {
        for (const job of [...createRunnerJobs(() => runner), ...createTransitionJobs(() => effects)]) worker.handle(job.id, job.handler);
      };
      register(queue);
      const drain = async (worker = queue) => {
        for (let count = 0; count < 50; count++) if (!await worker.runNext()) return;
        throw new Error('Job drain did not finish');
      };
      f.provider.respondNextConfirmation('declined'); await runner.daily(f.gymId);
      await effects.publish(f.gymId); await drain();
      const bill = (await f.read()).invoices[0]!;
      f.clock.set('2028-03-04T17:00:00Z');
      const create = vi.spyOn(f.provider, 'createCharge').mockRejectedValueOnce(new Error('Create unavailable'));
      await drain();
      expect((await f.read()).attempts[1]).toMatchObject({ status: 'pending', paymentIntentId: null });
      f.clock.advance(1000); await drain(); // The effect reruns, sees pending, and must retain its continuation.
      expect([...continuations.values()]).toEqual([new Date('2028-03-04T18:16:00Z')]);
      expect(create).toHaveBeenCalledTimes(1);
      f.clock.set('2028-03-04T17:17:00Z');
      await createRunnerJobs(() => runner).find(job => job.id === 'billing.runner.reconcile')!.handler({}, f.context);
      expect((await f.read()).attempts[1]).toMatchObject({ status: 'failed', declineCode: 'create_abandoned' });
      // A fresh worker reads the continuation from PostgreSQL after the original effect completed.
      const restarted = new PostgresJobs({ database: db, clock: f.clock }); register(restarted);
      f.clock.set('2028-03-04T18:16:00Z'); f.provider.respondNextConfirmation('declined');
      await drain(restarted); await effects.publish(f.gymId); await drain(restarted);
      await Promise.all([runner.retry(bill.id, f.context), runner.retry(bill.id, f.context)]);
      expect(create).toHaveBeenCalledTimes(2);
      expect((await f.read()).attempts.map(row => row.status)).toEqual(['failed', 'failed', 'failed']);
      expect(await restarted.runNext()).toBe(false);
      f.clock.set(daySeven); f.provider.respondNextConfirmation('declined');
      await drain(restarted); await effects.publish(f.gymId); await drain(restarted);
      await Promise.all([runner.retry(bill.id, f.context), runner.retry(bill.id, f.context)]);
      expect(create).toHaveBeenCalledTimes(3);
      expect((await f.read()).attempts).toHaveLength(4); // One initial charge, one abandoned create, two actual retries.
      f.clock.set('2028-03-15T17:00:00Z'); await drain(restarted); await runner.retry(bill.id, f.context);
      expect(create).toHaveBeenCalledTimes(3); expect((await f.read()).invoices[0]!.status).toBe('past_due');
    });
  it('defers again when reconciliation is delayed and never acknowledges a failed continuation enqueue', async () => {
    const f = await fixture(); f.provider.respondNextConfirmation('declined'); await f.runner.daily(f.gymId);
    const bill = (await f.read()).invoices[0]!;
    f.clock.set('2028-03-04T17:00:00Z'); f.provider.loseNextResponse('createCharge');
    await expect(f.runner.retry(bill.id, f.context)).rejects.toThrow();
    const queue = f.serviceOptions.jobs;
    for (const job of createRunnerJobs(() => f.runner)) queue.handle(job.id, job.handler);
    expect(queue.jobs).toHaveLength(1);
    f.clock.set('2028-03-04T18:16:00Z'); await queue.runNext();
    expect(queue.jobs).toHaveLength(2);
    expect(queue.jobs[1]).toMatchObject({ status: 'queued', runAt: new Date('2028-03-04T19:32:00Z') });
    const enqueue = vi.spyOn(queue, 'enqueue').mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(f.runner.retry(bill.id, { ...f.context, jobId: uuidv7() })).rejects.toThrow('Queue unavailable');
    enqueue.mockRestore();
    await f.runner.reconcile(f.gymId);
    f.clock.set('2028-03-04T19:32:00Z'); await queue.runNext();
    expect((await f.read()).payments).toHaveLength(1);
  });
  it('retains the continuation when reconciliation abandons the create before its error reaches retry', async () => {
    const f = await fixture(); f.provider.respondNextConfirmation('declined'); await f.runner.daily(f.gymId);
    const bill = (await f.read()).invoices[0]!;
    f.clock.set('2028-03-04T17:00:00Z');
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async () => {
      f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId);
      throw new Error('Delayed create failed');
    });
    await expect(f.runner.retry(bill.id, f.context)).rejects.toThrow('Delayed create failed');
    expect((await f.read()).attempts[1]!.declineCode).toBe('create_abandoned');
    const queue = f.serviceOptions.jobs;
    expect(queue.jobs).toHaveLength(1);
    for (const job of createRunnerJobs(() => f.runner)) queue.handle(job.id, job.handler);
    f.clock.set(queue.jobs[0]!.runAt); await queue.runNext();
    expect((await f.read()).payments).toHaveLength(1);
  });
  it('reconciles completed pay links before another attempt and refuses uncertain expiry', async () => {
    for (const completed of [true, false]) {
      const f = await fixture(); f.provider.respondNextConfirmation('declined'); await f.runner.daily(f.gymId);
      const bill = (await f.read()).invoices[0]!, session = await checkout(f, bill.id);
      const succeededAt = f.clock.now();
      if (completed) await f.provider.completeCheckout(session.id); else f.provider.setUncertain(session.id);
      f.clock.set('2028-03-04T17:00:00Z');
      if (completed) await expect(f.runner.charge(f.gymId, bill.id, { mode: 'retry' })).resolves.toEqual({ status: 'skipped', reason: 'not_payable' });
      else await expect(f.runner.retry(bill.id, f.context)).rejects.toThrow('Checkout');
      expect((await f.read()).attempts).toHaveLength(1);
      expect((await f.read()).invoices[0]!.status).toBe(completed ? 'paid' : 'past_due');
      if (completed) expect((await f.read()).payments[0]!.paidAt).toEqual(succeededAt);
    }
  });
  it('publishes and executes transition retry effects through the real job registrations', async () => {
    const f = await fixture();
    const jobs = new FakeJobs(f.clock), notices = { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}), staffNotice: vi.fn(async () => {}) };
    const effects = createTransitionEffects({ ...f.serviceOptions, jobs, transitions: f.transitions,
      memberships: createMembershipService(f.serviceOptions), payments: async () => f.provider, notifications: notices, retry: f.runner.retry });
    for (const job of [...createRunnerJobs(() => f.runner), ...createTransitionJobs(() => effects)]) jobs.handle(job.id, job.handler);
    f.provider.respondNextConfirmation('declined');
    await jobs.enqueue('billing.runner.daily', {}, { gymId: f.gymId, timezone: f.context.timezone }); await jobs.runNext();
    await effects.publish(f.gymId); while (await jobs.runNext()) { /* drain due jobs */ }
    expect(notices.dunning).toHaveBeenCalledTimes(1);
    f.clock.set('2028-03-04T17:00:00Z'); while (await jobs.runNext()) { /* day three */ }
    await effects.publish(f.gymId); while (await jobs.runNext()) { /* payment effects */ }
    expect((await f.read()).attempts).toHaveLength(2); expect((await f.read()).invoices[0]!.status).toBe('paid');
    expect(notices.receipt).toHaveBeenCalledTimes(1);
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
