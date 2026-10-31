// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { zonedInstant } from '@plaingym/shared/time';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { clearJobs, workflowFixture, type Workflow } from '../scenarios/workflow-fixture.js';
import { effectCreated, type TransitionEffect } from '../transitions/store.js';
import { createTransitionJobs } from '../transitions/transitions.jobs.js';
import { createWebhookInboxJobs } from '../webhooks/inbox.jobs.js';
import { dailyRunJob, retryJob } from './index.js';
import { createRunnerJobs, runnerBatchJobs } from './runner.jobs.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

/**
 * The runtime's worker: the daily run holds only the batch lane, so the gym's other billing jobs run beside it. Its lease
 * outlasts the clock jumps below (reconcile's fifteen-minute stale threshold), so the run is never reclaimed.
 */
function worker(f: Workflow) {
  const queue = new PostgresJobs({ database: db, clock: f.clock, batch: { jobs: runnerBatchJobs }, leaseMs: 4 * 3_600_000 });
  for (const job of [...createWebhookInboxJobs(f.inbox), ...createTransitionJobs(() => f.billing.effects),
    ...createRunnerJobs(() => f.runner, f.settings)]) queue.handle(job.id, job.handler);
  return queue;
}
const gymJob = (f: Workflow) => ({ gymId: f.gymId, timezone: f.timezone });
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
/** Runs every due job the daily run leaves claimable; bounded so a requeue loop fails the test. */
async function drain(queue: PostgresJobs) {
  for (let n = 0; n < 20; n++) if (!await queue.runNext()) return n;
  throw new Error('Queue did not drain');
}
/**
 * Starts the daily run through the worker and holds it inside its first confirm. With `charged`, Stripe has already
 * charged the card and only the answer is late; otherwise the confirm hasn't reached Stripe yet.
 */
async function holdDaily(f: Workflow, queue: PostgresJobs, charged: boolean) {
  const entered = gate(), held = gate(), confirm = f.provider.confirmCharge.bind(f.provider);
  vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, request) => {
    const outcome = charged ? await confirm(id, request) : undefined;
    entered.release(); await held.wait;
    return outcome ?? confirm(id, request);
  });
  const { jobId } = await queue.enqueue(dailyRunJob, {}, gymJob(f));
  let settled = false;
  const done = queue.runNext().finally(() => { settled = true; });
  await Promise.race([entered.wait, done.then(() => { throw new Error('The daily run never reached its confirm'); })]);
  return { done, release: held.release,
    /** Whatever ran since the hold ran beside the daily run: it is still mid-charge and its lease is live. */
    async expectLive() {
      expect(settled).toBe(false);
      const row = (await f.read()).jobs.find(job => job.id === jobId)!;
      expect(row.status).toBe('running');
      expect(row.lockedUntil!.getTime()).toBeGreaterThan(f.clock.now().getTime());
    } };
}
const effects = (state: Awaited<ReturnType<Workflow['read']>>, invoiceId: string) => state.audits
  .filter(row => row.action === effectCreated && (row.after as TransitionEffect).invoiceId === invoiceId)
  .map(row => (row.after as TransitionEffect).kind).sort();

describe('billing jobs beside a daily run of the same gym', () => {
  it.each([{ charged: false, when: 'before Stripe confirms' }, { charged: true, when: 'after Stripe charged the card' }])(
    'reconciles a stale charge held $when, with one payment and no second charge', async ({ charged }) => {
      const f = await workflowFixture(db), queue = worker(f), create = vi.spyOn(f.provider, 'createCharge');
      const daily = await holdDaily(f, queue, charged);
      try {
        // The held charge is past reconcile's stale threshold, as a long run's earlier charges would be.
        f.clock.advance(16 * 60_000);
        await queue.enqueue('billing.runner.reconcile', {}, gymJob(f));
        // A success it records queues the activation and receipt effects, which run too.
        expect(await drain(queue)).toBe(charged ? 3 : 1);
        await daily.expectLive();
      } finally { daily.release(); }
      expect(await daily.done).toBe(true);
      let state = await f.read();
      expect(state.jobs.map(job => [job.name, job.status])).toEqual(expect.arrayContaining([
        ['billing.runner.reconcile', 'succeeded'], [dailyRunJob, 'succeeded']]));
      expect(create).toHaveBeenCalledTimes(1);
      if (charged) {
        // Reconcile recorded the success; the late confirmation is the same payment.
        expect(state.invoices).toMatchObject([{ status: 'paid' }]);
        expect(state.attempts).toMatchObject([{ status: 'succeeded' }]);
        expect(state.payments).toHaveLength(1);
      } else {
        // Reconcile cancelled the unconfirmed intent, so the late confirm can't charge it: no decline, no dunning.
        expect(state.invoices).toMatchObject([{ status: 'open' }]);
        expect(state.attempts).toMatchObject([{ status: 'failed', declineCode: 'confirm_abandoned' }]);
        expect(state.payments).toEqual([]);
        expect(effects(state, state.invoices[0]!.id)).toEqual([]);
        // The next daily run collects it.
        f.clock.set('2028-03-02T17:00:00Z');
        await queue.enqueue(dailyRunJob, {}, { ...gymJob(f), idempotencyKey: 'next day' }); await drain(queue);
        state = await f.read();
        expect(state.invoices).toMatchObject([{ status: 'paid' }]);
        expect(state.attempts.map(row => row.status)).toEqual(['failed', 'succeeded']);
        expect(state.payments).toHaveLength(1);
      }
    });

  it('runs retries of the invoice it is charging and of another invoice of the household, charging each once', async () => {
    // March's invoice is declined on February 26, so its day-3 retry falls due during the February 29 run.
    const f = await workflowFixture(db, { card: 'pm_0341', now: '2028-02-26T17:00:00Z', dueOn: '2028-02-26' });
    await f.runJob(dailyRunJob);
    const pastDue = (await f.read()).invoices[0]!;
    expect(pastDue.status).toBe('past_due');
    await f.setCard('pm_4242');
    const member = await f.factory('members', f.gymId, { householdId: f.home.id });
    await f.factory('memberships', f.gymId, { householdId: f.home.id, memberId: member.id, planId: f.plan.id, amountCents: 10000,
      currency: 'USD', status: 'active', startsOn: '2028-01-29', nextDueOn: '2028-02-29' });
    const queue = worker(f), create = vi.spyOn(f.provider, 'createCharge');
    const dayThree = zonedInstant('2028-02-29', '09:00', f.timezone, { gap: 'shift' })!;
    f.clock.set(new Date(dayThree.getTime() - 60_000));
    const daily = await holdDaily(f, queue, false);
    const charging = (await f.read()).invoices.find(row => row.dueOn === '2028-02-29')!;
    try {
      f.clock.set(dayThree);
      // A retry of the invoice the run is charging finds its pending attempt and defers.
      await queue.enqueue(retryJob, { invoiceId: charging.id }, gymJob(f));
      // The day-3 retry effect charges the past-due invoice, and its receipt and activation run too: four jobs in all.
      expect(await drain(queue)).toBe(4);
      await daily.expectLive();
      const state = await f.read();
      expect(state.invoices.find(row => row.id === pastDue.id)!.status).toBe('paid');
      expect(state.attempts.filter(row => row.invoiceId === charging.id)).toMatchObject([{ status: 'pending' }]);
    } finally { daily.release(); }
    expect(await daily.done).toBe(true);
    // The deferred retry finds the invoice paid.
    f.clock.set(new Date(dayThree.getTime() + 76 * 60_000)); await drain(queue);
    const state = await f.read();
    expect(state.invoices.map(row => [row.id, row.status])).toEqual(expect.arrayContaining([[pastDue.id, 'paid'], [charging.id, 'paid']]));
    expect(create).toHaveBeenCalledTimes(2);
    for (const invoice of [pastDue, charging]) expect(state.payments.filter(row => row.invoiceId === invoice.id)).toHaveLength(1);
    expect(state.attempts.filter(row => row.invoiceId === pastDue.id).map(row => row.status)).toEqual(['failed', 'succeeded']);
    expect(state.attempts.filter(row => row.invoiceId === charging.id).map(row => row.status)).toEqual(['succeeded']);
    expect(state.jobs.filter(job => job.status === 'failed')).toEqual([]);
    expect(state.jobs.filter(job => job.name === retryJob).map(job => job.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('applies a success webhook and its effects for the charge it holds, with one payment, receipt and activation', async () => {
    const f = await workflowFixture(db), queue = worker(f), create = vi.spyOn(f.provider, 'createCharge');
    const daily = await holdDaily(f, queue, true);
    const [invoice] = (await f.read()).invoices, intentId = (await f.read()).attempts[0]!.paymentIntentId!;
    try {
      await f.deliver('payment_intent.succeeded', intentId);
      // The dispatch, then the activation and receipt effects it queues.
      expect(await drain(queue)).toBe(3);
      await daily.expectLive();
      const state = await f.read();
      expect(state.invoices).toMatchObject([{ status: 'paid' }]);
      expect(state.attempts).toMatchObject([{ status: 'succeeded' }]);
      expect(state.jobs.filter(job => job.name !== dailyRunJob).map(job => job.status)).toEqual(Array(3).fill('succeeded'));
    } finally { daily.release(); }
    expect(await daily.done).toBe(true);
    expect(await drain(queue)).toBe(0);
    const state = await f.read();
    expect(create).toHaveBeenCalledTimes(1);
    expect(state.payments).toHaveLength(1);
    expect(state.attempts).toMatchObject([{ status: 'succeeded' }]);
    // The run's late confirmation is the same payment: it queues no second receipt or activation.
    expect(effects(state, invoice!.id)).toEqual(['activate_memberships', 'receipt']);
    expect(f.email.messages).toMatchObject([{ to: 'payer@example.invalid', subject: expect.stringContaining('Receipt') }]);
    expect(state.jobs.find(job => job.name === dailyRunJob)!.status).toBe('succeeded');
  });
});
