// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { allocateInvoiceNumber, households, paymentMethods, uuidv7 } from '@plaingym/db';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { replayTransport, recordingTransport } from '../../../infra/payments/transport.js';
import { FixtureRecorder, type Tape } from '../../../infra/payments/recording.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import { createMembershipService } from '../memberships.js';
import { createPaymentService } from '../payments.js';
import { createChargeRunner } from './index.js';
import { createMembersService } from '../../members/members.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { useRunnerFixture } from './runner.fixture.test-helper.js';

const { db, factory, fixture, invoice } = useRunnerFixture();

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
    await members.eraseMember({ gymId: f.gymId, actor: { kind: 'system' } }, f.member.id, { revision: 1 }, { jobs: new FakeJobs(f.clock), timezone: 'UTC' });
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
