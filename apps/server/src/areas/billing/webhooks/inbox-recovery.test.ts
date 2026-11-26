// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- EXPLAIN inspects the production query on the disposable database.
import { sql } from 'drizzle-orm';
import { auditEvents, stripeEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Each test owns this isolated database's queue rows.
import { jobs } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- ANALYZE needs the table owner on the disposable database.
import { openConnection } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../../core/clock.js';
import { setLogSink } from '../../../core/log.js';
import { FakeJobs, PostgresJobs } from '../../../infra/jobs/index.js';
import { FakePayments, type PaymentEvent } from '../../../infra/payments/index.js';
import { jobs as billingJobs } from '../jobs.js';
import { configureWebhookInboxJobs, createWebhookInboxJobs } from './inbox.jobs.js';
import { createWebhookHealthQuery, createWebhookInbox, webhookDispatchJob } from './inbox.js';
import { webhookDispatchRecoveryExhausted, webhookDispatchRetried, webhookRecoveryDelayMs, webhookRecoveryLimit,
  webhookRecoveryPage } from './inbox-recovery.js';
import { webhookRecoveryJob } from './inbox-recovery.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
beforeEach(async () => { await db.forSystem(tx => tx.delete(jobs)); });
async function fixture(scope: typeof db.forGym = db.forGym) {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const clock = new TestClock('2028-03-01T09:00:00Z'), queue = new PostgresJobs({ database: db, clock });
  const provider = new FakePayments(gymId, clock);
  const options = { scope, system: db.forSystem, clock, jobs: queue, recovery: queue,
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
  const audits = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, webhookDispatchRetried))
    .orderBy(asc(auditEvents.occurredAt)));
  const exhaust = async (beforeAttempt?: () => void) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      beforeAttempt?.();
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

it('audits the five-reset limit once across concurrent sweeps and stops paging the failed event', async () => {
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
  const outcomes = await Promise.all([f.build().recoverFailed(f.gymId), f.build().recoverFailed(f.gymId)]);
  expect(outcomes.map(outcome => outcome.exhausted).sort()).toEqual([0, 1]);
  const exhausted = await db.forGym(f.gymId, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, webhookDispatchRecoveryExhausted)));
  expect(exhausted).toMatchObject([{ targetId: saved.id, after: { jobId: failed!.jobId, resets: webhookRecoveryLimit } }]);
  const lookup = vi.spyOn(f.queue, 'failedJobs');
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(lookup).not.toHaveBeenCalled();
  expect(await f.audits()).toHaveLength(webhookRecoveryLimit);
  expect(await createWebhookHealthQuery(db.forGym, f.clock).get(f.gymId)).toMatchObject({
    pendingCount: 0, failedCount: 1, recentFailedCount: 0,
  });
  expect(await f.queue.runNext()).toBe(false);
});

it('reopens automatic recovery after a redelivery resets an exhausted dispatch', async () => {
  const f = await fixture(); f.handler.mockRejectedValue(new Error('Unavailable'));
  await f.deliver(); await f.exhaust();
  const saved = await f.stored(), [failed] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  const sweep = () => f.build().recoverFailed(f.gymId);
  const paged = async () => (await db.forGym(f.gymId, tx => webhookRecoveryPage(tx, f.gymId))).map(row => row.id);
  const closings = () => db.forGym(f.gymId, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, webhookDispatchRecoveryExhausted)).orderBy(asc(auditEvents.occurredAt)));
  const resetAfter = async (resets: number) => {
    const delay = webhookRecoveryDelayMs * 2 ** resets;
    f.clock.advance(delay - 1);
    expect(await sweep()).toEqual({ recovered: 0, exhausted: 0 });
    f.clock.advance(1);
    expect(await sweep()).toEqual({ recovered: 1, exhausted: 0 });
    expect((await f.audits()).at(-1)).toMatchObject({ targetId: saved.id, after: { jobId: failed!.jobId, delayMs: delay } });
    await f.exhaust();
  };
  for (let reset = 0; reset < webhookRecoveryLimit; reset++) await resetAfter(reset);
  expect(await sweep()).toEqual({ recovered: 0, exhausted: 1 });
  expect(await closings()).toMatchObject([{ targetId: saved.id, after: { resets: webhookRecoveryLimit } }]);
  // Closed: a job failed past every delay gets no reset, and the page leaves the event out.
  f.clock.advance(100 * 86_400_000);
  expect(await sweep()).toEqual({ recovered: 0, exhausted: 0 });
  expect(await paged()).not.toContain(saved.id);
  // The redelivery's reset comes after the exhaustion audit, so it reopens recovery as the first reset since then.
  await f.deliver();
  expect(await f.audits()).toHaveLength(webhookRecoveryLimit + 1);
  expect(await paged()).toContain(saved.id);
  await f.exhaust();
  await resetAfter(1);
  expect((await f.audits()).at(-1)).toMatchObject({ after: { delayMs: 1_800_000 } });
  for (let reset = 2; reset < webhookRecoveryLimit; reset++) await resetAfter(reset);
  const outcomes = await Promise.all([sweep(), sweep()]);
  expect(outcomes.map(outcome => outcome.exhausted).sort()).toEqual([0, 1]);
  const [first, second] = await closings();
  expect(await closings()).toHaveLength(2);
  expect(second).toMatchObject({ targetId: saved.id, after: { jobId: failed!.jobId, resets: webhookRecoveryLimit } });
  expect(second!.occurredAt.getTime()).toBeGreaterThan(first!.occurredAt.getTime());
  f.clock.advance(100 * 86_400_000);
  const lookup = vi.spyOn(f.queue, 'failedJobs');
  expect(await sweep()).toEqual({ recovered: 0, exhausted: 0 });
  expect(lookup).not.toHaveBeenCalled();
  expect(await paged()).not.toContain(saved.id);
  expect(await f.audits()).toHaveLength(2 * webhookRecoveryLimit);
});

it('marks and recovers a terminal dispatch whose stored-event reads failed before the marker path', async () => {
  let failRead = false;
  const f = await fixture(async (gymId, fn) => {
    if (failRead) {
      failRead = false;
      throw new Error('Inbox read interrupted');
    }
    return db.forGym(gymId, fn);
  });
  await f.deliver();
  await f.exhaust(() => { failRead = true; });
  const saved = await f.stored();
  const health = createWebhookHealthQuery(db.forGym, f.clock);
  expect(saved).toMatchObject({ error: null, processedAt: null });
  expect(f.handler).not.toHaveBeenCalled();
  expect(await health.get(f.gymId)).toMatchObject({ pendingCount: 1, failedCount: 0 });
  const [failed] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  expect(failed).toBeDefined();
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(await f.stored()).toMatchObject({ error: 'dispatch_failed', failedAt: failed!.failedAt, processedAt: null });
  expect(await health.get(f.gymId)).toMatchObject({ pendingCount: 0, failedCount: 1, recentFailedCount: 1 });
  f.clock.advance(webhookRecoveryDelayMs);
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
  expect(await f.audits()).toMatchObject([{ targetId: saved.id, after: { jobId: failed!.jobId } }]);
  expect(await f.queue.runNext()).toBe(true);
  expect(f.handler).toHaveBeenCalledTimes(1);
  expect(await f.stored()).toMatchObject({ id: saved.id, error: null, processedAt: f.clock.now() });
  expect(await health.get(f.gymId)).toMatchObject({ pendingCount: 0, failedCount: 0, recentFailedCount: 0 });
});

it('moves the sweep marker’s failure time to the dispatch’s latest failure after a reset', async () => {
  let failRead = false;
  const f = await fixture(async (gymId, fn) => {
    if (failRead) {
      failRead = false;
      throw new Error('Inbox read interrupted');
    }
    return db.forGym(gymId, fn);
  });
  await f.deliver();
  await f.exhaust(() => { failRead = true; });
  const saved = await f.stored(), health = createWebhookHealthQuery(db.forGym, f.clock);
  const [first] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(await f.stored()).toMatchObject({ error: 'dispatch_failed', failedAt: first!.failedAt });
  f.clock.advance(8 * 86_400_000);
  expect(await health.get(f.gymId)).toMatchObject({ failedCount: 1, recentFailedCount: 0 });
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
  await f.exhaust(() => { failRead = true; });
  const [second] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  expect(second!.failedAt.getTime()).toBeGreaterThan(first!.failedAt.getTime());
  // Still inside the next cooldown: the sweep records the new failure time without another reset.
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(await f.stored()).toMatchObject({ error: 'dispatch_failed', failedAt: second!.failedAt, processedAt: null });
  expect(await health.get(f.gymId)).toMatchObject({ failedCount: 1, recentFailedCount: 1 });
});

it('moves a handler_failed row’s failure time forward to its reset job’s latest failure without changing the marker', async () => {
  let failRead = false;
  const f = await fixture(async (gymId, fn) => {
    if (failRead) {
      failRead = false;
      throw new Error('Inbox read interrupted');
    }
    return db.forGym(gymId, fn);
  });
  f.handler.mockRejectedValue(new Error('Unavailable'));
  await f.deliver();
  await f.exhaust();
  const saved = await f.stored(), firstFailedAt = saved.failedAt!, health = createWebhookHealthQuery(db.forGym, f.clock);
  expect(saved).toMatchObject({ error: 'handler_failed', failedAt: firstFailedAt, processedAt: null });
  f.clock.advance(9 * 86_400_000);
  expect(await health.get(f.gymId)).toMatchObject({ failedCount: 1, recentFailedCount: 0 });
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
  await f.exhaust(() => { failRead = true; });
  expect(await f.stored()).toMatchObject({ error: 'handler_failed', failedAt: firstFailedAt, processedAt: null });
  const [second] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  expect(second!.failedAt.getTime()).toBeGreaterThan(firstFailedAt.getTime());
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(await f.stored()).toMatchObject({ error: 'handler_failed', failedAt: second!.failedAt, processedAt: null });
  expect(await health.get(f.gymId)).toMatchObject({ failedCount: 1, recentFailedCount: 1 });
});

it('leaves a handler_failed row unchanged when its failure time is later than its job’s failure', async () => {
  const f = await fixture();
  f.handler.mockRejectedValue(new Error('Unavailable'));
  await f.deliver();
  await f.exhaust();
  const saved = await f.stored();
  const [failed] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  f.clock.advance(60_000);
  await expect(f.inbox.dispatch({ eventId: saved.eventId, replay: true },
    { gymId: f.gymId, timezone: 'UTC', clock: f.clock, jobId: uuidv7(), attempt: 1 })).rejects.toThrow('Unavailable');
  const laterFailedAt = f.clock.now();
  expect(laterFailedAt.getTime()).toBeGreaterThan(failed!.failedAt.getTime());
  expect(await f.stored()).toMatchObject({ error: 'handler_failed', failedAt: laterFailedAt, processedAt: null });
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(await f.stored()).toMatchObject({ error: 'handler_failed', failedAt: laterFailedAt, processedAt: null });
});

it('moves a handler_failed row’s failure time only when it predates the latest reset audit', async () => {
  const f = await fixture();
  const queue = new PostgresJobs({ database: db, clock: f.clock });
  const id = uuidv7(), resetAt = new Date(f.clock.now().getTime() - 60_000);
  const afterReset = new Date(f.clock.now().getTime() - 3);
  await db.forGym(f.gymId, async tx => {
    await tx.insert(stripeEvents).values({
      id, gymId: f.gymId, eventId: 'evt_' + id, type: 'payment_intent.succeeded',
      payload: {}, receivedAt: resetAt, error: 'handler_failed', failedAt: afterReset,
    });
    await tx.insert(auditEvents).values({
      gymId: f.gymId, actorKind: 'system', action: webhookDispatchRetried,
      targetType: 'stripe_event', targetId: id, after: {}, occurredAt: resetAt,
    });
  });
  queue.handle(webhookDispatchJob, async () => { throw new Error('Unavailable'); });
  await queue.enqueue(webhookDispatchJob, { eventId: 'evt_' + id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
  expect(await queue.runNext()).toBe(true);
  const [failed] = await queue.failedJobs(webhookDispatchJob, [id], { gymId: f.gymId });
  expect(failed!.failedAt.getTime() - afterReset.getTime()).toBe(3);
  f.clock.advance(60_000);
  let scopes = 0;
  const scope: typeof db.forGym = (gymId, fn) => { scopes++; return db.forGym(gymId, fn); };
  const recover = () => createWebhookInbox({ ...f.options, scope, jobs: queue, recovery: queue }).recoverFailed(f.gymId);
  // Failure recorded 3 ms before the job failed and after the reset: no locked transaction, row unchanged.
  expect(await recover()).toEqual({ recovered: 0, exhausted: 0 });
  expect(scopes).toBe(3);
  expect(await f.stored()).toMatchObject({ error: 'handler_failed', failedAt: afterReset, processedAt: null });
  // Failure recorded 1 ms before the reset audit: sweep locks and advances failed_at to the job's failure.
  const beforeReset = new Date(resetAt.getTime() - 1);
  await db.forGym(f.gymId, tx => tx.update(stripeEvents).set({ failedAt: beforeReset }).where(eq(stripeEvents.id, id)));
  scopes = 0;
  expect(await recover()).toEqual({ recovered: 0, exhausted: 0 });
  expect(scopes).toBe(4);
  expect(await f.stored()).toMatchObject({ error: 'handler_failed', failedAt: failed!.failedAt, processedAt: null });
});

it('fills a missing failure time on a handler_failed row from its failed job without changing the marker', async () => {
  const f = await fixture();
  const queue = new PostgresJobs({ database: db, clock: f.clock });
  const id = uuidv7();
  await db.forGym(f.gymId, tx => tx.insert(stripeEvents).values({
    id, gymId: f.gymId, eventId: 'evt_' + id, type: 'payment_intent.succeeded',
    payload: {}, receivedAt: f.clock.now(), error: 'handler_failed', failedAt: null,
  }));
  queue.handle(webhookDispatchJob, async () => { throw new Error('Unavailable'); });
  await queue.enqueue(webhookDispatchJob, { eventId: 'evt_' + id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
  expect(await queue.runNext()).toBe(true);
  const [failed] = await queue.failedJobs(webhookDispatchJob, [id], { gymId: f.gymId });
  f.clock.advance(60_000);
  expect(await createWebhookInbox({ ...f.options, jobs: queue, recovery: queue }).recoverFailed(f.gymId))
    .toEqual({ recovered: 0, exhausted: 0 });
  expect(await f.stored()).toMatchObject({ error: 'handler_failed', failedAt: failed!.failedAt, processedAt: null });
});

it('reopens recovery when a redelivery reset ties the exhaustion time and keeps an earlier reset closed', async () => {
  const f = await fixture(), queue = new FakeJobs(f.clock);
  const id = uuidv7(), exhaustedAt = f.clock.now();
  await factory('stripeEvents', f.gymId, { id, eventId: 'evt_' + id, type: 'payment_intent.succeeded',
    payload: {}, receivedAt: exhaustedAt, error: 'handler_failed', failedAt: exhaustedAt });
  await db.forGym(f.gymId, tx => tx.insert(auditEvents).values([
    { gymId: f.gymId, actorKind: 'system', action: webhookDispatchRecoveryExhausted,
      targetType: 'stripe_event', targetId: id, after: { resets: webhookRecoveryLimit }, occurredAt: exhaustedAt },
    { gymId: f.gymId, actorKind: 'system', action: webhookDispatchRetried,
      targetType: 'stripe_event', targetId: id, after: {}, occurredAt: new Date(exhaustedAt.getTime() - 1) },
  ]));
  const paged = async () => (await db.forGym(f.gymId, tx => webhookRecoveryPage(tx, f.gymId))).map(row => row.id);
  expect(await paged()).not.toContain(id);
  await db.forGym(f.gymId, tx => tx.insert(auditEvents).values({
    gymId: f.gymId, actorKind: 'system', action: webhookDispatchRetried,
    targetType: 'stripe_event', targetId: id, after: {}, occurredAt: exhaustedAt,
  }));
  expect(await paged()).toContain(id);
  queue.handle(webhookDispatchJob, async () => { throw new Error('Unavailable'); });
  await queue.enqueue(webhookDispatchJob, { eventId: 'evt_' + id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
  expect(await queue.runNext()).toBe(true);
  const recover = () => createWebhookInbox({ ...f.options, jobs: queue, recovery: queue }).recoverFailed(f.gymId);
  f.clock.advance(webhookRecoveryDelayMs);
  expect(await recover()).toEqual({ recovered: 0, exhausted: 0 });
  f.clock.advance(webhookRecoveryDelayMs);
  expect(await recover()).toEqual({ recovered: 1, exhausted: 0 });
  expect((await f.audits()).at(-1)).toMatchObject({ targetId: id, after: { delayMs: 2 * webhookRecoveryDelayMs } });
});

it('reopens recovery when a redelivery arrives from a process whose clock is behind the exhaustion audit', async () => {
  const f = await fixture(); f.handler.mockRejectedValue(new Error('Unavailable'));
  await f.deliver(); await f.exhaust();
  const saved = await f.stored(), [failed] = await f.queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: f.gymId });
  expect(failed).toBeDefined();
  const exhaustedAt = f.clock.now();
  await db.forGym(f.gymId, tx => tx.insert(auditEvents).values({
    gymId: f.gymId, actorKind: 'system', action: webhookDispatchRecoveryExhausted,
    targetType: 'stripe_event', targetId: saved.id, after: { jobId: failed!.jobId, resets: webhookRecoveryLimit },
    occurredAt: exhaustedAt,
  }));
  const paged = async () => (await db.forGym(f.gymId, tx => webhookRecoveryPage(tx, f.gymId))).map(row => row.id);
  expect(await paged()).not.toContain(saved.id);
  const behind = new TestClock(new Date(exhaustedAt.getTime() - 10 * 60_000));
  const skewedProvider = new FakePayments(f.gymId, behind);
  const skewedInbox = createWebhookInbox({ ...f.options, clock: behind, paymentsFor: async () => skewedProvider });
  const body = new TextEncoder().encode(JSON.stringify({
    id: saved.eventId, gymId: f.gymId, type: 'payment_intent.succeeded', objectId: 'pi_fixture', objectKind: 'charge',
  }));
  await skewedInbox.receive(f.gymId, body, skewedProvider.signWebhook(body));
  expect(await f.audits()).toMatchObject([{ targetId: saved.id, after: { jobId: failed!.jobId }, occurredAt: exhaustedAt }]);
  expect(await paged()).toContain(saved.id);
  await f.exhaust();
  const sweep = () => f.build().recoverFailed(f.gymId);
  f.clock.advance(2 * webhookRecoveryDelayMs - 1);
  expect(await sweep()).toEqual({ recovered: 0, exhausted: 0 });
  f.clock.advance(1);
  expect(await sweep()).toEqual({ recovered: 1, exhausted: 0 });
  expect((await f.audits()).at(-1)).toMatchObject({ targetId: saved.id, after: { jobId: failed!.jobId, delayMs: 2 * webhookRecoveryDelayMs } });
});

it('stamps an exhaustion audit 1 ms after resets written by a clock ahead of the sweep', async () => {
  const f = await fixture(); f.handler.mockRejectedValue(new Error('Unavailable'));
  const now = f.clock.now(), ahead = new Date(now.getTime() + 10 * 60_000);
  const id = uuidv7(), eventId = 'evt_' + id;
  await db.forGym(f.gymId, async tx => {
    await tx.insert(stripeEvents).values({
      id, gymId: f.gymId, eventId, type: 'payment_intent.succeeded',
      payload: { id: eventId, gymId: f.gymId, type: 'payment_intent.succeeded', objectId: 'pi_fixture', objectKind: 'charge' },
      receivedAt: now, error: 'handler_failed', failedAt: now,
    });
    await tx.insert(auditEvents).values(Array.from({ length: webhookRecoveryLimit }, () => ({
      gymId: f.gymId, actorKind: 'system', action: webhookDispatchRetried,
      targetType: 'stripe_event', targetId: id, after: {}, occurredAt: ahead,
    })));
  });
  await f.queue.enqueue(webhookDispatchJob, { eventId }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
  expect(await f.queue.runNext()).toBe(true);
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 1 });
  const exhausted = await db.forGym(f.gymId, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, webhookDispatchRecoveryExhausted)));
  expect(exhausted).toMatchObject([{ targetId: id, after: { resets: webhookRecoveryLimit }, occurredAt: new Date(ahead.getTime() + 1) }]);
  const paged = (await db.forGym(f.gymId, tx => webhookRecoveryPage(tx, f.gymId))).map(row => row.id);
  expect(paged).not.toContain(id);
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
});

it('logs a failed pre-check read and continues to recover an eligible event on the next page', async () => {
  const f = await fixture(), queue = new FakeJobs(f.clock);
  const old = new Date(f.clock.now().getTime() - 86_400_000);
  const ids = Array.from({ length: 101 }, (_, n) => uuidv7(10 + n));
  await db.forGym(f.gymId, tx => tx.insert(stripeEvents).values(ids.map(id => ({
    id, gymId: f.gymId, eventId: 'evt_' + id, type: 'payment_intent.succeeded',
    payload: {}, receivedAt: old, error: 'handler_failed', failedAt: old,
  }))));
  queue.handle(webhookDispatchJob, async () => { throw new Error('Unavailable'); });
  for (const id of [ids[0]!, ids[100]!]) {
    await queue.enqueue(webhookDispatchJob, { eventId: 'evt_' + id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
    expect(await queue.runNext()).toBe(true);
  }
  f.clock.advance(webhookRecoveryDelayMs);
  let scopeCalls = 0;
  const scope: typeof db.forGym = (gymId, fn) => {
    if (++scopeCalls === 2) throw new Error('Pre-check read interrupted');
    return db.forGym(gymId, fn);
  };
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try {
    expect(await createWebhookInbox({ ...f.options, scope, jobs: queue, recovery: queue }).recoverFailed(f.gymId))
      .toEqual({ recovered: 1, exhausted: 0 });
  } finally {
    setLogSink(previous);
  }
  expect(lines.map(line => JSON.parse(line))).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: 'error', event: 'billing.webhook.recovery_failed', gymId: f.gymId,
      error: expect.objectContaining({ name: 'Error' }) }),
  ]));
  expect(queue.jobs.find(job => job.options.idempotencyKey === ids[0])?.status).toBe('failed');
  expect(queue.jobs.find(job => job.options.idempotencyKey === ids[100])?.status).toBe('queued');
  expect(await f.audits()).toMatchObject([{ targetId: ids[100] }]);
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

it('pages old unprocessed events in gym scope and resets only failed original jobs', async () => {
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
    expect(isInTransaction()).toBe(args[3] !== undefined);
    return failedJobs(...args);
  });
  vi.spyOn(queue, 'retryFailed').mockImplementation(async (...args) => {
    expect(isInTransaction()).toBe(true);
    return retryFailed(...args);
  });
  expect(await createWebhookInbox({ ...f.options, jobs: queue, recovery: queue }).recoverFailed(f.gymId))
    .toEqual({ recovered: 2, exhausted: 0 });
  const pages = lookup.mock.calls.filter(call => call[3] === undefined).map(call => call[1]);
  expect(pages.map(page => page.length)).toEqual([100, 4]);
  expect(pages.flat()).not.toContain(ids[1]);
  expect(pages.flat()).not.toContain(foreignId);
  expect(queue.jobs.filter(job => job.status === 'queued').map(job => job.options.idempotencyKey).sort())
    .toEqual([ids[0], ids[2], ids[104]].sort());
  expect(await f.audits()).toHaveLength(2);
  expect(await db.forGym(otherGym, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, webhookDispatchRetried)))).toEqual([]);
});

it('uses both partial indexes when paging the inbox as the app role', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const processedAt = new Date('2027-03-01T09:00:00Z');
  for (let offset = 0; offset < 4000; offset += 500) {
    await db.forGym(gymId, tx => tx.insert(stripeEvents).values(Array.from({ length: 500 }, (_, i) => ({
      id: uuidv7(10 + offset + i), gymId, eventId: `evt_history_${offset + i}`, type: 'payment_intent.succeeded', payload: {}, processedAt,
    }))));
  }
  const cursor = uuidv7(5);
  for (const error of [null, 'handler_failed']) {
    await factory('stripeEvents', gymId, { error });
  }
  const maintenance = openConnection(db.maintenanceUrl, 1);
  try { await maintenance.sql`analyze stripe_events`; } finally { await maintenance.close(); }
  for (const after of [undefined, cursor]) {
    const plan = await db.forGym(gymId, tx =>
      // eslint-disable-next-line database/system-tables -- Explain the gym-scoped production query under forced RLS.
      tx.execute(sql`explain (analyze, buffers) ${webhookRecoveryPage(tx, gymId, after).getSQL()}`));
    const text = plan.map(row => row['QUERY PLAN']).join('\n');
    expect(text).toContain('stripe_events_recovery_error_idx');
    expect(text).toContain('stripe_events_recovery_no_error_idx');
    expect(text).not.toContain('Seq Scan on stripe_events');
  }
});
