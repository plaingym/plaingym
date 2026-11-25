// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, stripeEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Each test owns this isolated database's queue rows.
import { jobs } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { webhookDispatchJob } from './inbox.js';
import { createWebhookInboxRecovery, webhookDispatchRecoveryExhausted, webhookDispatchRetried, webhookRecoveryDelayMs,
  webhookRecoveryLimit } from './inbox-recovery.js';

const db = useTestDatabase(), factory = createFactories(db);
beforeEach(async () => { await db.forSystem(tx => tx.delete(jobs)); });

/** `count` unprocessed events, each with `resets` earlier dispatch resets and an original dispatch that fails at the clock's start. */
async function fixture(count: number, options: { error?: 'handler_failed' | null; resets?: number } = {}) {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const clock = new TestClock('2028-03-01T09:00:00Z'), queue = new PostgresJobs({ database: db, clock });
  const ids = Array.from({ length: count }, () => uuidv7()), earlier = new Date(clock.now().getTime() - 86_400_000);
  const error = options.error === undefined ? 'handler_failed' : options.error;
  await db.forGym(gymId, async tx => {
    await tx.insert(stripeEvents).values(ids.map(id => ({ id, gymId, eventId: 'evt_' + id, type: 'payment_intent.succeeded',
      payload: {}, receivedAt: earlier, error, failedAt: error ? clock.now() : null })));
    const resets = ids.flatMap(id => Array.from({ length: options.resets ?? 1 }, () => ({ gymId, actorKind: 'system',
      action: webhookDispatchRetried, targetType: 'stripe_event', targetId: id, after: {}, occurredAt: earlier })));
    if (resets.length) await tx.insert(auditEvents).values(resets);
  });
  queue.handle(webhookDispatchJob, async () => { throw new Error('Unavailable'); });
  for (const id of ids)
    await queue.enqueue(webhookDispatchJob, { eventId: 'evt_' + id }, { gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
  while (await queue.runNext());
  let scopes = 0;
  const scope: typeof db.forGym = (gym, fn) => { scopes++; return db.forGym(gym, fn); };
  const recover = createWebhookInboxRecovery({ job: webhookDispatchJob, scope, clock, recovery: queue });
  const audits = (action: string) => db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, action)).orderBy(asc(auditEvents.occurredAt)));
  return {
    gymId, clock, queue, ids, audits,
    sweep: () => recover(gymId),
    scopes: () => scopes,
    failed: () => queue.failedJobs(webhookDispatchJob, ids, { gymId }),
    stored: (id: string) => db.forGym(gymId, tx => tx.select().from(stripeEvents).where(eq(stripeEvents.id, id))),
  };
}

it('skips failed events still in their cooldown without a transaction per event', async () => {
  const f = await fixture(50);
  expect(await f.failed()).toHaveLength(50);
  f.clock.advance(60_000);
  const lookup = vi.spyOn(f.queue, 'failedJobs'), reset = vi.spyOn(f.queue, 'retryFailed');
  expect(await f.sweep()).toEqual({ recovered: 0, exhausted: 0 });
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(reset).not.toHaveBeenCalled();
  // The page, the unlocked pre-check and the empty next page.
  expect(f.scopes()).toBe(3);
  expect(await f.audits(webhookDispatchRetried)).toHaveLength(50);
});

it('locks and resets each due event once', async () => {
  const f = await fixture(50);
  f.clock.advance(2 * 3_600_000);
  const reset = vi.spyOn(f.queue, 'retryFailed');
  expect(await f.sweep()).toEqual({ recovered: 50, exhausted: 0 });
  expect(reset).toHaveBeenCalledTimes(50);
  // The page, the pre-check, one locked transaction per event and the empty next page.
  expect(f.scopes()).toBe(3 + 50);
  const latest = (await f.audits(webhookDispatchRetried)).filter(audit => audit.occurredAt.getTime() === f.clock.now().getTime());
  expect(latest).toHaveLength(50);
  expect(new Set(latest.map(audit => audit.targetId))).toEqual(new Set(f.ids));
  for (const audit of latest) expect(audit.after).toMatchObject({ delayMs: webhookRecoveryDelayMs * 2 });
  expect(await f.failed()).toEqual([]);
});

it('marks a failed dispatch with no error marker during its cooldown without resetting it', async () => {
  const f = await fixture(1, { error: null });
  const [failed] = await f.failed();
  f.clock.advance(60_000);
  const reset = vi.spyOn(f.queue, 'retryFailed');
  expect(await f.sweep()).toEqual({ recovered: 0, exhausted: 0 });
  expect(reset).not.toHaveBeenCalled();
  expect(await f.stored(f.ids[0]!)).toMatchObject([{ error: 'dispatch_failed', failedAt: failed!.failedAt, processedAt: null }]);
  expect(await f.audits(webhookDispatchRetried)).toHaveLength(1);
  expect(await f.failed()).toMatchObject([{ jobId: failed!.jobId }]);
  // A second sweep in the same cooldown has nothing left to write and takes no lock.
  expect(await f.sweep()).toEqual({ recovered: 0, exhausted: 0 });
  expect(f.scopes()).toBe(4 + 3);
});

it('resets a due event once across concurrent sweeps', async () => {
  const f = await fixture(1);
  f.clock.advance(2 * 3_600_000);
  const outcomes = await Promise.all([f.sweep(), f.sweep()]);
  expect(outcomes.map(outcome => outcome.recovered).sort()).toEqual([0, 1]);
  expect(await f.audits(webhookDispatchRetried)).toHaveLength(2);
});

it('audits an event at the reset limit once across concurrent sweeps, even inside the last cooldown', async () => {
  const f = await fixture(1, { resets: webhookRecoveryLimit });
  const [failed] = await f.failed();
  f.clock.advance(60_000);
  const outcomes = await Promise.all([f.sweep(), f.sweep()]);
  expect(outcomes.map(outcome => outcome.exhausted).sort()).toEqual([0, 1]);
  expect(await f.audits(webhookDispatchRecoveryExhausted)).toMatchObject([
    { targetId: f.ids[0], after: { jobId: failed!.jobId, resets: webhookRecoveryLimit } }]);
  const lookup = vi.spyOn(f.queue, 'failedJobs');
  f.clock.advance(86_400_000);
  expect(await f.sweep()).toEqual({ recovered: 0, exhausted: 0 });
  expect(lookup).not.toHaveBeenCalled();
});
