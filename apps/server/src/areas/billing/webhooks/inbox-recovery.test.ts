// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, stripeEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Each test owns this isolated database's queue rows.
import { jobs } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs, PostgresJobs } from '../../../infra/jobs/index.js';
import { FakePayments, type PaymentEvent } from '../../../infra/payments/index.js';
import { jobs as billingJobs } from '../jobs.js';
import { configureWebhookInboxJobs, createWebhookInboxJobs } from './inbox.jobs.js';
import { createWebhookHealthQuery, createWebhookInbox, webhookDispatchJob } from './inbox.js';
import { webhookDispatchRetried, webhookRecoveryDelayMs, webhookRecoveryLimit } from './inbox-recovery.js';
import { webhookRecoveryJob } from './inbox-recovery.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
beforeEach(async () => { await db.forSystem(tx => tx.delete(jobs)); });
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const clock = new TestClock('2028-03-01T09:00:00Z'), queue = new PostgresJobs({ database: db, clock });
  const provider = new FakePayments(gymId, clock);
  const options = { scope: db.forGym, system: db.forSystem, clock, jobs: queue, recovery: queue,
    paymentsFor: async () => provider, gymSettings: { get: async () => ({ timezone: 'UTC' }) } };
  const build = () => createWebhookInbox(options), inbox = build(), handler = vi.fn(async () => {});
  inbox.register('payment_intent.succeeded', handler);
  for (const job of createWebhookInboxJobs(inbox)) queue.handle(job.id, job.handler);
  const event: PaymentEvent = { id: 'evt_' + gymId, gymId, type: 'payment_intent.succeeded', objectId: 'pi_fixture', objectKind: 'charge' };
  const deliver = async () => {
    const body = new TextEncoder().encode(JSON.stringify(event));
    await inbox.receive(gymId, body, provider.signWebhook(body));
  };
  const stored = async () => (await db.forGym(gymId, tx => tx.select().from(stripeEvents)))[0]!;
  const audits = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, webhookDispatchRetried)));
  const exhaust = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await queue.runNext()).toBe(true);
      if (attempt < 9) clock.advance(1000 * 2 ** attempt);
    }
  };
  return { gymId, clock, queue, options, build, inbox, handler, deliver, stored, audits, exhaust };
}

it('the registered hourly sweep recovers ten failed dispatches without a redelivery and dispatches once', async () => {
  const f = await fixture();
  f.handler.mockRejectedValue(new Error('Unavailable'));
  await f.deliver(); await f.exhaust();
  const saved = await f.stored(), [failed] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  expect(failed).toBeDefined(); expect(f.handler).toHaveBeenCalledTimes(10);
  f.clock.advance(webhookRecoveryDelayMs - 1);
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  f.clock.advance(1); f.handler.mockResolvedValue();
  configureWebhookInboxJobs(f.inbox);
  const sweep = billingJobs.find(job => job.id === webhookRecoveryJob)!;
  expect(sweep.cron).toBe('17 * * * *');
  const context = { gymId: f.gymId, timezone: 'UTC', clock: f.clock, jobId: uuidv7(), attempt: 1 };
  await Promise.all([sweep.handler({}, context), sweep.handler({}, context)]);
  expect(await f.audits()).toMatchObject([{ targetId: saved.id, after: { jobId: failed!.jobId, delayMs: webhookRecoveryDelayMs } }]);
  expect(await f.queue.runNext()).toBe(true); expect(await f.queue.runNext()).toBe(false);
  expect(f.handler).toHaveBeenCalledTimes(11);
  expect(await f.stored()).toMatchObject({ id: saved.id, payload: saved.payload, receivedAt: saved.receivedAt,
    processedAt: f.clock.now(), error: null });
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
});

it('persists growing delays and a five-reset limit across restarts, leaving the failed webhook on Health', async () => {
  const f = await fixture(); f.handler.mockRejectedValue(new Error('Unavailable'));
  await f.deliver(); await f.exhaust();
  const saved = await f.stored(), [failed] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  for (let reset = 0; reset < webhookRecoveryLimit; reset++) {
    const delay = webhookRecoveryDelayMs * 2 ** reset;
    f.clock.advance(delay - 1);
    expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
    f.clock.advance(1);
    expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
    await f.exhaust();
    expect(await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId })).toMatchObject([{ jobId: failed!.jobId }]);
  }
  f.clock.advance(100 * 86_400_000);
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 1 });
  expect(await f.audits()).toHaveLength(webhookRecoveryLimit);
  expect(await createWebhookHealthQuery(db.forGym, f.clock).get(f.gymId)).toMatchObject({ failedCount: 1 });
  expect(await f.queue.runNext()).toBe(false);
});

it('does not reset an event processed while the original dispatch was down', async () => {
  const f = await fixture(); f.handler.mockRejectedValue(new Error('Unavailable'));
  await f.deliver(); await f.exhaust();
  const saved = await f.stored();
  f.handler.mockResolvedValue();
  await f.inbox.dispatch({ eventId: saved.eventId, replay: true },
    { gymId: f.gymId, timezone: 'UTC', clock: f.clock, jobId: uuidv7(), attempt: 1 });
  f.clock.advance(webhookRecoveryDelayMs);
  const lookup = vi.spyOn(f.queue, 'failedJobs');
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(lookup).not.toHaveBeenCalled(); expect(await f.audits()).toEqual([]);
});

it('pages old failed events in gym scope, skipping pending, missing, processed and clean events', async () => {
  const f = await fixture(), otherGym = uuidv7(), queue = new FakeJobs(f.clock), ids: string[] = [];
  await factory('gyms', otherGym);
  const old = new Date(f.clock.now().getTime() - 100 * 86_400_000);
  for (let n = 0; n < 105; n++) {
    const id = uuidv7(); ids.push(id);
    await factory('stripeEvents', f.gymId, { id, eventId: 'evt_' + id, type: 'payment_intent.succeeded', receivedAt: old,
      payload: {}, error: n === 0 ? null : 'handler_failed', processedAt: n === 1 ? old : null });
  }
  const foreignId = uuidv7();
  await factory('stripeEvents', otherGym, { id: foreignId, eventId: 'evt_' + foreignId, type: 'payment_intent.succeeded',
    payload: {}, receivedAt: old, error: 'handler_failed' });
  queue.handle(webhookDispatchJob, async () => { throw new Error('Unavailable'); });
  for (const id of [ids[0]!, ids[1]!, ids[104]!, foreignId]) {
    await queue.enqueue(webhookDispatchJob, { eventId: 'evt_' + id }, { gymId: id === foreignId ? otherGym : f.gymId,
      timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
    expect(await queue.runNext()).toBe(true);
  }
  await queue.enqueue(webhookDispatchJob, {}, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: ids[2]! });
  f.clock.advance(webhookRecoveryDelayMs);
  const failedJobs = queue.failedJobs.bind(queue), retryFailed = queue.retryFailed.bind(queue);
  const lookup = vi.spyOn(queue, 'failedJobs').mockImplementation(async (...args) => {
    assertNoTransaction('recovery lookup'); return failedJobs(...args);
  });
  vi.spyOn(queue, 'retryFailed').mockImplementation(async (...args) => {
    assertNoTransaction('recovery reset'); return retryFailed(...args);
  });
  expect(await createWebhookInbox({ ...f.options, jobs: queue, recovery: queue }).recoverFailed(f.gymId))
    .toEqual({ recovered: 1, exhausted: 0 });
  expect(lookup.mock.calls.map(call => call[1].length)).toEqual([100, 3]);
  expect(queue.jobs.filter(job => job.status === 'queued')).toHaveLength(2);
  expect(await db.forGym(otherGym, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, webhookDispatchRetried)))).toEqual([]);
});
