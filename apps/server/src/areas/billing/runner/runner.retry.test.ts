// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { FakeJobs, PostgresJobs } from '../../../infra/jobs/index.js';
import { FakeEmail } from '../../../infra/email/index.js';
import { createMembershipService } from '../memberships.js';
import { createTransitionEffects } from '../transitions/effects.js';
import { createTransitionJobs } from '../transitions/transitions.jobs.js';
import { createChargeRunner } from './index.js';
import { createRunnerJobs } from './runner.jobs.js';
import { createWebhookInbox } from '../webhooks/inbox.js';
import { composeBillingWebhooks } from '../webhooks/handlers/composition.js';
import { useRunnerFixture } from './runner.fixture.test-helper.js';

const { db, factory, fixture, checkout } = useRunnerFixture();

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
  it('retains the continuation when reconciliation abandons the reservation before its intent ID is saved', async () => {
    const f = await fixture(); f.provider.respondNextConfirmation('declined'); await f.runner.daily(f.gymId);
    const bill = (await f.read()).invoices[0]!;
    f.clock.set('2028-03-04T17:00:00Z');
    const create = f.provider.createCharge.bind(f.provider), confirm = vi.spyOn(f.provider, 'confirmCharge');
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId);
      return create(request);
    });
    await f.runner.retry(bill.id, f.context);
    expect((await f.read()).attempts[1]!.declineCode).toBe('create_abandoned');
    expect(confirm).not.toHaveBeenCalled(); // The lost reservation is never confirmed.
    const queue = f.serviceOptions.jobs;
    expect(queue.jobs).toMatchObject([{ name: 'billing.runner.retry', payload: { invoiceId: bill.id } }]);
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
