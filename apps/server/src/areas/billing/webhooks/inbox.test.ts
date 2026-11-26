// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, stripeEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Test inspects the reset job's scheduled time on the disposable database.
import { jobs as jobsTable } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../../core/clock.js';
import { describeError, setLogSink } from '../../../core/log.js';
import type { Principal, RequestEnvironment } from '../../../core/context.js';
import { errorHandler } from '../../../core/errors.js';
import { createServerRegistry } from '../../../core/registry.js';
import { FakeJobs, PostgresJobs, type Jobs, type JobRecovery } from '../../../infra/jobs/index.js';
import { FakePayments, type PaymentEvent, type Payments } from '../../../infra/payments/index.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import type { ObjectData } from '../../../infra/payments/transport.js';
import { PaymentWebhookError } from '../../../infra/payments/webhook-error.js';
import { createWebhookHealthQuery, createWebhookInbox, handlerFailureFields, testEventSkippedAction, webhookDispatchJob, type WebhookInbox } from './inbox.js';
import { stripeTestClearedAction } from '../stripe-writes.js';
import { createWebhookInboxJobs } from './inbox.jobs.js';
import { resetRedeliveredDispatch } from './inbox-recovery.js';
import { createWebhookInboxRoutes } from './inbox.routes.js';
import { createReplayCommand } from '../../../cli/replay.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7(), emptyGym = uuidv7();
let clock: TestClock, jobs: FakeJobs, fake: FakePayments, inbox: WebhookInbox;
const gymSettings = { async get(gymId: string) { return { timezone: gymId === gymA ? 'America/Vancouver' : 'Asia/Tokyo' }; } };
beforeAll(async () => { for (const id of [gymA, gymB, emptyGym]) await factory('gyms', id); });
beforeEach(async () => {
  await database.forSystem((tx) => tx.delete(stripeEvents));
  clock = new TestClock('2026-10-24T12:00:00Z'); jobs = new FakeJobs(clock); fake = new FakePayments(gymA, clock);
  inbox = build(async () => fake);
  createServerRegistry({ jobs: createWebhookInboxJobs(inbox) }).registerJobs(jobs, new Set());
});
function build(paymentsFor: (gymId: string) => Promise<Payments | null>, queue: Jobs & JobRecovery = jobs) {
  return createWebhookInbox({ paymentsFor, jobs: queue, recovery: queue, gymSettings, clock, scope: database.forGym, system: database.forSystem });
}
function event(id = 'evt_test', gymId = gymA): PaymentEvent {
  return { id, gymId, type: 'payment_intent.succeeded', objectId: 'pi_fixture', objectKind: 'charge' };
}
function fakeDelivery(value = event()) {
  const body = new TextEncoder().encode(JSON.stringify(value)); return { body, signature: fake.signWebhook(body) };
}
async function deliver(value = event()) { const { body, signature } = fakeDelivery(value); await inbox.receive(value.gymId, body, signature); }
const rows = () => database.forSystem((tx) => tx.select().from(stripeEvents));
const context = (gymId = gymA) => ({ gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
function server(service = inbox, demo = false, principal: Principal = { kind: 'anonymous' }) {
  const app = new OpenAPIHono<RequestEnvironment>(); app.onError(errorHandler);
  app.use('*', async (c, next) => {
    // Demo's install host deliberately has no tenant or session.
    c.set('context', { requestId: 'test', principal, clock,
      ...(!demo ? { gym: { gymId: gymA, timezone: 'UTC', enabledModules: new Set<string>() } } : {}) } as RequestEnvironment['Variables']['context']);
    await next();
  });
  for (const entry of createWebhookInboxRoutes(service, demo ? { demoGyms: async () => [{ gymId: gymA }, { gymId: gymB }] } : {})) {
    expect(entry.definition.permission).toEqual({ kind: 'public' });
    entry.mount(app, (permission) => async (_c, next) => { expect(permission).toEqual({ kind: 'public' }); await next(); });
  }
  return app;
}
function request(app: ReturnType<typeof server>, body: Uint8Array, signature: string) {
  return app.request('https://demo.example.invalid/webhooks/stripe', {
    method: 'POST', body: Buffer.from(body), headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
  });
}
const secret = 'whsec_SYNTHETIC';
function stripeDelivery(gymId = gymA, id = 'evt_stripe', object?: ObjectData) {
  const body = new TextEncoder().encode(JSON.stringify({ id, object: 'event', type: 'payment_intent.succeeded', livemode: false,
    data: { object: object ?? { id: 'pi_fixture', object: 'payment_intent', metadata: { gym_id: gymId }, customer_email: 'private@example.invalid' } } }));
  const timestamp = Math.floor(clock.now().getTime() / 1000);
  const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex')}`;
  return { body, signature };
}
function stripe(transport = new StripeFixtures(gymA)) {
  return build(async (gymId) => new StripePayments(gymId, { transport, webhookSecret: secret, clock, mode: 'test' }));
}

it('deduplicates concurrent deliveries and dispatches once, after insertion and outside transactions', async () => {
  let calls = 0;
  inbox.register('payment_intent.succeeded', async (received, ctx) => {
    assertNoTransaction('webhook.handler'); expect(received).toEqual(event()); expect(ctx.gymId).toBe(gymA);
    expect(ctx.payments).toBe(fake); expect((await rows())[0]!.processedAt).toBeNull(); calls++;
  });
  await Promise.all([deliver(), deliver(), deliver()]);
  expect(await rows()).toHaveLength(1); expect(jobs.jobs).toHaveLength(1); expect(calls).toBe(0);
  expect(jobs.jobs[0]!.options).toMatchObject({ gymId: gymA, timezone: 'America/Vancouver' });
  await jobs.runNext(); await deliver(); await inbox.dispatch({ eventId: 'evt_test' }, context());
  expect(calls).toBe(1); expect(jobs.jobs).toHaveLength(1);
  expect((await rows())[0]).toMatchObject({ processedAt: clock.now(), error: null });
});
it('repairs an insert/enqueue crash on redelivery without replacing the original event', async () => {
  const enqueue = vi.spyOn(jobs, 'enqueue').mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(deliver()).rejects.toThrow('queue unavailable'); expect(await rows()).toHaveLength(1);
  const saved = (await rows())[0]!;
  clock.advance(1000); await deliver();
  expect((await rows())[0]).toEqual(saved); expect(jobs.jobs).toHaveLength(1); expect(enqueue).toHaveBeenCalledTimes(2);
});
it('dispatches a stored event written by a newer release and strips its unknown fields', async () => {
  const handler = vi.fn();
  inbox.register('payment_intent.succeeded', handler);
  await deliver();
  await database.forGym(gymA, (tx) => tx.update(stripeEvents).set({ payload: { ...event(), futureField: { version: 2 } } })
    .where(eq(stripeEvents.eventId, 'evt_test')));
  await inbox.dispatch({ eventId: 'evt_test', futureField: true }, context());
  expect(handler).toHaveBeenCalledExactlyOnceWith(event(), expect.objectContaining({ gymId: gymA }));
  expect((await rows())[0]).toMatchObject({ processedAt: clock.now(), error: null });
});
it('retries failed handlers with safe diagnostics, and replays completed events through the CLI', async () => {
  let calls = 0;
  inbox.register('payment_intent.succeeded', async () => { if (++calls === 1) throw new Error('secret and payer details'); });
  await deliver(); await jobs.runNext();
  expect(jobs.jobs[0]).toMatchObject({ status: 'queued', attempt: 1 });
  expect((await rows())[0]).toMatchObject({ processedAt: null, error: 'handler_failed' });
  clock.advance(1000); await jobs.runNext(); expect(calls).toBe(2);
  expect((await rows())[0]).toMatchObject({ processedAt: clock.now(), error: null });
  const stdout = vi.fn(), stderr = vi.fn(), command = createReplayCommand(inbox.replay);
  expect(await command.run(['--gym', gymA, 'evt_test'], { stdout, stderr })).toBe(0);
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('queued')); expect(stderr).not.toHaveBeenCalled();
  await jobs.runNext(); expect(calls).toBe(3);
});
/** Delivers one event per failure, runs each dispatch once, and returns the whole log output and its failure lines. */
async function failAndLog(failures: Record<string, Error>) {
  inbox.register('payment_intent.succeeded', async (value) => { throw failures[value.id]!; });
  for (const id of Object.keys(failures)) await deliver(event(id));
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  try { for (let n = 0; n < Object.keys(failures).length; n++) await jobs.runNext(); } finally { setLogSink(previous); }
  const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === 'billing.webhooks.handler_failed');
  expect(logged).toHaveLength(Object.keys(failures).length);
  // Each failure keeps only the safe marker and goes back to the queue for a retry.
  expect((await rows()).map((row) => row.error)).toEqual(Object.keys(failures).map(() => 'handler_failed'));
  expect(jobs.jobs.map((job) => [job.status, job.attempt])).toEqual(Object.keys(failures).map(() => ['queued', 1]));
  for (const line of logged) expect(line).not.toHaveProperty('error');
  return { output: lines.join('\n'), byEvent: new Map(logged.map((line) => [line.eventId, line])) };
}
it('logs a failed handler with its event and only a fixed reason', async () => {
  class ProviderError extends Error {}
  const failures: Record<string, Error> = {
    evt_fixed: new Error('Saved card household is unresolved'),
    evt_provider_text: new Error('No such customer: cus_123'),
    evt_provider_error: new ProviderError('Card declined'),
    // Letters and spaces only, but not a handler's own text: it could be a person's name.
    evt_plain_text: new Error('secret and payer details'),
    evt_fixed_subclass: new ProviderError('Webhook gym mismatch'),
  };
  const { output, byEvent } = await failAndLog(failures);
  expect(byEvent.get('evt_fixed')).toMatchObject({ level: 'error', gymId: gymA, type: 'payment_intent.succeeded',
    reason: 'Saved card household is unresolved', errorName: 'Error' });
  for (const id of ['evt_provider_text', 'evt_provider_error', 'evt_plain_text', 'evt_fixed_subclass']) {
    expect(byEvent.get(id)).toMatchObject({ level: 'error', gymId: gymA, eventId: id, type: 'payment_intent.succeeded' });
    expect(byEvent.get(id)).not.toHaveProperty('reason');
  }
  expect(byEvent.get('evt_provider_text')).toMatchObject({ errorName: 'Error' });
  expect(byEvent.get('evt_plain_text')).toMatchObject({ errorName: 'Error' });
  expect(output).not.toMatch(/cus_123|Card declined|secret and payer details|Webhook gym mismatch/);
});
it('builds failure diagnostics without reading message text, top level or nested', async () => {
  const failures: Record<string, Error> = {
    evt_fixed: new Error('Saved card household is unresolved'),
    evt_multiline: new Error('line one\n    at fake (cus_123:1:1)'),
    evt_query: new Error('Failed query: select * from payer where email = alice@example.com'),
    evt_cause: new Error('Webhook gym mismatch', { cause: new Error('secret and payer details\n    at x (pm_999:1:1)') }),
    // A handler's own fixed text, but not letters and spaces only.
    evt_punctuated: new Error('Invoice has another dispute; staff resolution required'),
  };
  const { output, byEvent } = await failAndLog(failures);
  const fixed = byEvent.get('evt_fixed')!;
  expect(fixed).toMatchObject({ reason: 'Saved card household is unresolved', errorName: 'Error' });
  expect(String(fixed.errorFrames).split('\n').filter((line) => line.startsWith('at ')).length).toBeGreaterThan(0);
  expect(byEvent.get('evt_multiline')).not.toHaveProperty('reason');
  expect(byEvent.get('evt_multiline')).toMatchObject({ errorName: 'Error' });
  expect(output).not.toContain('cus_123');
  for (const line of byEvent.values()) expect(line).not.toHaveProperty('query');
  expect(output).not.toContain('alice@example.com');
  expect(byEvent.get('evt_cause')).toMatchObject({ errorName: 'Error', causeName: 'Error' });
  expect(output).not.toMatch(/secret and payer details|pm_999/);
  expect(byEvent.get('evt_punctuated')).not.toHaveProperty('reason');
  expect(output).not.toMatch(/another dispute|staff resolution/);
});
it('takes the same stack frames as the shared logger', () => {
  // Literal Node-style stacks, so the test runner's stack formatter cannot change the fixtures.
  const withStack = (error: Error, stack: string) => Object.assign(error, { stack });
  const bothPaths = (error: Error) => {
    const core = describeError(error).frames as string[];
    const webhook = handlerFailureFields(error);
    return { core, webhook: webhook.errorFrames === undefined ? undefined : String(webhook.errorFrames).split('\n'), fields: webhook };
  };
  // A multiline message with a frame-shaped line: only the real frame after the full header is kept.
  const multiline = bothPaths(withStack(new Error('lookup failed\n    at privateFrame (cus_123:9:9)'),
    'Error: lookup failed\n    at privateFrame (cus_123:9:9)\n    at run (/app/server.js:1:1)'));
  expect(multiline.core).toEqual(['at run (/app/server.js:1:1)']);
  expect(multiline.webhook).toEqual(['at run (/app/server.js:1:1)']);
  // A header that is not the error's own name and message gives no frames on either path.
  for (const error of [withStack(new Error('boom'), 'Error: cus_123\n    at run (/app/server.js:1:1)'),
    withStack(new Error('boom'), 'TypeError: boom\n    at run (/app/server.js:1:1)'),
    withStack(new TypeError('boom'), 'Error: boom\n    at run (/app/server.js:1:1)')]) {
    const result = bothPaths(error);
    expect(result.core).toEqual([]);
    expect(result.fields).not.toHaveProperty('errorFrames');
  }
  // An empty message's stack is headed by the name alone; both paths keep the first 15 frames, trimmed.
  const lines = Array.from({ length: 16 }, (_, index) => `    at step${index} (/app/server.js:${index + 1}:1) `);
  const empty = bothPaths(withStack(new Error(''), `Error\n${lines.join('\n')}`));
  const expected = lines.slice(0, 15).map((line) => line.trim());
  expect(empty.core).toEqual(expected);
  expect(empty.webhook).toEqual(expected);
});
it('rethrows and logs the original handler failure even when the inbox cannot save its marker', async () => {
  await deliver();
  const handlerError = new Error('Saved card household is unresolved');
  const writeError = new Error('marker write unavailable');
  let rejectWrites = false, markerAttempts = 0;
  const service = createWebhookInbox({ paymentsFor: async () => fake, jobs, gymSettings, clock,
    scope: (gymId, run) => {
      if (rejectWrites) { markerAttempts++; throw writeError; }
      return database.forGym(gymId, run);
    } });
  service.register('payment_intent.succeeded', async () => {
    rejectWrites = true;
    throw handlerError;
  });
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try { await expect(service.dispatch({ eventId: 'evt_test' }, context())).rejects.toBe(handlerError); }
  finally { setLogSink(previous); }
  expect(markerAttempts).toBe(1);
  expect(lines).toHaveLength(2);
  expect(lines.map(line => JSON.parse(line))).toMatchObject([
    { level: 'error', event: 'billing.webhooks.marker_write_failed', gymId: gymA, eventId: 'evt_test',
      error: expect.objectContaining({ name: 'Error' }) },
    { event: 'billing.webhooks.handler_failed',
      gymId: gymA, eventId: 'evt_test', type: 'payment_intent.succeeded', reason: 'Saved card household is unresolved' },
  ]);
});
it('records a replay failure marker when reading the stored event throws, and rethrows and logs the original error if the marker write also throws', async () => {
  await deliver();
  clock.advance(60_000);
  const readError = Object.assign(new Error('Stored read interrupted'), { code: '57P01' });
  const writeError = Object.assign(new Error('Marker write unavailable'), { code: '08006' });
  // An original dispatch leaves marking to the recovery sweep, while still logging and rethrowing.
  let originalCalls = 0;
  const originalService = createWebhookInbox({ paymentsFor: async () => fake, jobs, gymSettings, clock,
    scope: (gymId, run) => {
      if (++originalCalls === 1) throw readError;
      return database.forGym(gymId, run);
    } });
  const originalLogs: string[] = [], prevOriginal = setLogSink(line => originalLogs.push(line));
  try { await expect(originalService.dispatch({ eventId: 'evt_test' }, context())).rejects.toBe(readError); }
  finally { setLogSink(prevOriginal); }
  expect((await rows())[0]).toMatchObject({ error: null, failedAt: null, processedAt: null });
  const [originalLogged] = originalLogs.map(line => JSON.parse(line) as Record<string, unknown>);
  expect(originalLogged).toMatchObject({ event: 'billing.webhooks.handler_failed', gymId: gymA, eventId: 'evt_test',
    errorName: 'Error', errorCode: '57P01' });
  expect(originalLogged).not.toHaveProperty('type');
  // A replay dispatch records handler_failed and failed_at as best effort when the stored read throws.
  let replayCalls = 0;
  const replayService = createWebhookInbox({ paymentsFor: async () => fake, jobs, gymSettings, clock,
    scope: (gymId, run) => {
      if (++replayCalls === 1) throw readError;
      return database.forGym(gymId, run);
    } });
  const replayLogs: string[] = [], prevReplay = setLogSink(line => replayLogs.push(line));
  try { await expect(replayService.dispatch({ eventId: 'evt_test', replay: true }, context())).rejects.toBe(readError); }
  finally { setLogSink(prevReplay); }
  expect((await rows())[0]).toMatchObject({ error: 'handler_failed', failedAt: clock.now(), processedAt: null });
  expect(replayLogs.map(line => JSON.parse(line))).toMatchObject([{ event: 'billing.webhooks.handler_failed',
    gymId: gymA, eventId: 'evt_test', errorName: 'Error', errorCode: '57P01' }]);
  // When the best-effort marker write also throws, the original read error is still logged and rethrown.
  let bothCalls = 0;
  const bothFailService = createWebhookInbox({ paymentsFor: async () => fake, jobs, gymSettings, clock,
    scope: () => { throw ++bothCalls === 1 ? readError : writeError; } });
  const bothLogs: string[] = [], prevBoth = setLogSink(line => bothLogs.push(line));
  try { await expect(bothFailService.dispatch({ eventId: 'evt_test', replay: true }, context())).rejects.toBe(readError); }
  finally { setLogSink(prevBoth); }
  expect(bothCalls).toBe(2);
  expect(bothLogs.map(line => JSON.parse(line))).toMatchObject([
    { level: 'error', event: 'billing.webhooks.marker_write_failed', gymId: gymA, eventId: 'evt_test',
      error: expect.objectContaining({ name: 'Error', code: '08006' }) },
    { event: 'billing.webhooks.handler_failed',
      gymId: gymA, eventId: 'evt_test', errorName: 'Error', errorCode: '57P01' },
  ]);
});
it('can replay an exhausted handler and retries a failed replay too', async () => {
  let fail = true;
  inbox.register('payment_intent.succeeded', async () => { if (fail) throw new Error('failure'); });
  await deliver();
  for (let attempt = 0; attempt < 10; attempt++) { await jobs.runNext(); clock.advance(600_000); }
  expect(jobs.jobs[0]!.status).toBe('failed');
  await inbox.replay(gymA, 'evt_test'); await jobs.runNext();
  expect(jobs.jobs[1]).toMatchObject({ status: 'queued', attempt: 1 });
  fail = false; clock.advance(1000); await jobs.runNext();
  expect(jobs.jobs[1]!.status).toBe('completed'); expect((await rows())[0]!.error).toBeNull();
});
it('redelivery resets an exhausted PostgreSQL dispatch once, preserving its job and stored event', async () => {
  const queue = new PostgresJobs({ database, clock }), service = build(async () => fake, queue);
  let fail = true;
  const handler = vi.fn(async () => { if (fail) throw new Error('Unavailable'); });
  service.register('payment_intent.succeeded', handler);
  createServerRegistry({ jobs: createWebhookInboxJobs(service) }).registerJobs(queue, new Set());
  const value = event('evt_redelivered'), delivery = fakeDelivery(value);
  await service.receive(gymA, delivery.body, delivery.signature);
  const saved = (await rows())[0]!;
  for (let attempt = 0; attempt < 10; attempt++) { await queue.runNext(); clock.advance(600_000); }
  const [failed] = await queue.failedJobs('billing.webhooks.dispatch', [saved.id], { gymId: gymA });
  expect(failed).toBeDefined(); expect(handler).toHaveBeenCalledTimes(10);
  expect(await queue.failedJobs('billing.webhooks.dispatch', [saved.id], { gymId: gymB })).toEqual([]);
  fail = false;
  await Promise.all(Array.from({ length: 3 }, () => service.receive(gymA, delivery.body, delivery.signature)));
  const audits = await database.forGym(gymA, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, 'billing.webhook.dispatch_retried')));
  expect(audits.filter(row => row.targetId === saved.id)).toMatchObject([{ after: { jobId: failed!.jobId } }]);
  expect((await rows())[0]).toMatchObject({ id: saved.id, receivedAt: saved.receivedAt, payload: saved.payload });
  expect(await queue.runNext()).toBe(true); expect(handler).toHaveBeenCalledTimes(11);
  expect((await rows())[0]).toMatchObject({ processedAt: clock.now(), error: null });
  await service.receive(gymA, delivery.body, delivery.signature);
  expect(await queue.runNext()).toBe(false);
});
it('redelivery stamps its reset audit and job runAt from one clock read and resets once under concurrency', async () => {
  let nowMs = new Date('2026-10-24T12:00:00Z').getTime();
  const tickingClock: Clock & { advance(ms: number): void } = { now: () => new Date(nowMs++), advance(ms) { nowMs += ms; } };
  const queue = new PostgresJobs({ database, clock: tickingClock });
  const provider = new FakePayments(gymA, tickingClock);
  const service = createWebhookInbox({
    paymentsFor: async () => provider, jobs: queue, recovery: queue, gymSettings, clock: tickingClock,
    scope: database.forGym, system: database.forSystem,
  });
  let fail = true;
  const handler = vi.fn(async () => { if (fail) throw new Error('Unavailable'); });
  service.register('payment_intent.succeeded', handler);
  createServerRegistry({ jobs: createWebhookInboxJobs(service) }).registerJobs(queue, new Set());
  const delivery = fakeDelivery(event('evt_redelivered_ticking'));
  await service.receive(gymA, delivery.body, delivery.signature);
  const saved = (await rows())[0]!;
  for (let attempt = 0; attempt < 10; attempt++) { expect(await queue.runNext()).toBe(true); tickingClock.advance(600_000); }
  const [failed] = await queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: gymA });
  expect(failed).toBeDefined();
  fail = false;
  await Promise.all([
    service.receive(gymA, delivery.body, delivery.signature),
    service.receive(gymA, delivery.body, delivery.signature),
  ]);
  const audits = (await database.forGym(gymA, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, 'billing.webhook.dispatch_retried')))).filter(row => row.targetId === saved.id);
  expect(audits).toMatchObject([{ after: { jobId: failed!.jobId } }]);
  const [resetJob] = await database.forGym(gymA, tx => tx.select({ status: jobsTable.status, runAt: jobsTable.runAt })
    .from(jobsTable).where(eq(jobsTable.id, failed!.jobId)));
  expect(resetJob).toMatchObject({ status: 'pending', runAt: audits[0]!.occurredAt });
  expect(await queue.runNext()).toBe(true);
  expect(await queue.runNext()).toBe(false);
  expect(handler).toHaveBeenCalledTimes(11);
});
it('leaves a post-redelivery handler failure unchanged without a locked transaction on the next sweep', async () => {
  let nowMs = new Date('2026-10-24T12:00:00Z').getTime();
  const tickingClock: Clock & { advance(ms: number): void } = { now: () => new Date(nowMs++), advance(ms) { nowMs += ms; } };
  const queue = new PostgresJobs({ database, clock: tickingClock });
  const provider = new FakePayments(gymA, tickingClock);
  const service = createWebhookInbox({
    paymentsFor: async () => provider, jobs: queue, recovery: queue, gymSettings, clock: tickingClock,
    scope: database.forGym, system: database.forSystem,
  });
  service.register('payment_intent.succeeded', async () => { throw new Error('Unavailable'); });
  createServerRegistry({ jobs: createWebhookInboxJobs(service) }).registerJobs(queue, new Set());
  const delivery = fakeDelivery(event('evt_redelivered_sweep'));
  await service.receive(gymA, delivery.body, delivery.signature);
  const saved = (await rows())[0]!;
  for (let attempt = 0; attempt < 10; attempt++) { expect(await queue.runNext()).toBe(true); tickingClock.advance(600_000); }
  await service.receive(gymA, delivery.body, delivery.signature);
  for (let attempt = 0; attempt < 10; attempt++) { expect(await queue.runNext()).toBe(true); tickingClock.advance(600_000); }
  const failedAt = (await rows())[0]!.failedAt!;
  const [failed] = await queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: gymA });
  expect(failed).toBeDefined();
  expect(failed!.failedAt.getTime()).toBeGreaterThan(failedAt.getTime());
  let scopes = 0;
  const countedScope: typeof database.forGym = (gymId, fn) => { scopes++; return database.forGym(gymId, fn); };
  const sweeper = createWebhookInbox({
    paymentsFor: async () => provider, jobs: queue, recovery: queue, gymSettings, clock: tickingClock,
    scope: countedScope, system: database.forSystem,
  });
  expect(await sweeper.recoverFailed(gymA)).toEqual({ recovered: 0, exhausted: 0 });
  expect(scopes).toBe(3);
  expect((await rows())[0]).toMatchObject({ error: 'handler_failed', failedAt, processedAt: null });
});
it('rolls back a redelivery job reset when the recovery transaction fails', async () => {
  const queue = new PostgresJobs({ database, clock }), service = build(async () => fake, queue);
  service.register('payment_intent.succeeded', async () => { throw new Error('Unavailable'); });
  createServerRegistry({ jobs: createWebhookInboxJobs(service) }).registerJobs(queue, new Set());
  const delivery = fakeDelivery(event('evt_redelivered_rollback'));
  await service.receive(gymA, delivery.body, delivery.signature);
  const saved = (await rows())[0]!;
  for (let attempt = 0; attempt < 10; attempt++) { expect(await queue.runNext()).toBe(true); clock.advance(600_000); }
  const [failed] = await queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: gymA });
  expect(failed).toBeDefined();
  const failingRecovery: JobRecovery = {
    failedJobs: (...args) => queue.failedJobs(...args),
    async retryFailed(jobId, opts, transaction) {
      expect(await queue.retryFailed(jobId, opts, transaction)).toBe(true);
      throw new Error('recovery commit failed');
    },
  };
  const failingService = createWebhookInbox({
    paymentsFor: async () => fake, jobs: queue, recovery: failingRecovery, gymSettings, clock,
    scope: database.forGym, system: database.forSystem,
  });
  await expect(failingService.receive(gymA, delivery.body, delivery.signature)).rejects.toThrow('recovery commit failed');
  expect(await queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: gymA })).toMatchObject([{ jobId: failed!.jobId }]);
  const audits = (await database.forGym(gymA, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, 'billing.webhook.dispatch_retried')))).filter(row => row.targetId === saved.id);
  expect(audits).toEqual([]);
  expect(await queue.runNext()).toBe(false);
});
it('leaves the failed original dispatch alone when a replay processed the event before the redelivery lock', async () => {
  let fail = true;
  const queue = new PostgresJobs({ database, clock }), service = build(async () => fake, queue);
  service.register('payment_intent.succeeded', async () => { if (fail) throw new Error('Unavailable'); });
  createServerRegistry({ jobs: createWebhookInboxJobs(service) }).registerJobs(queue, new Set());
  const delivery = fakeDelivery(event('evt_redelivered_processed'));
  await service.receive(gymA, delivery.body, delivery.signature);
  const saved = (await rows())[0]!;
  for (let attempt = 0; attempt < 10; attempt++) { expect(await queue.runNext()).toBe(true); clock.advance(600_000); }
  const [failed] = await queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: gymA });
  expect(failed).toBeDefined();
  fail = false;
  await service.replay(gymA, 'evt_redelivered_processed'); expect(await queue.runNext()).toBe(true);
  expect((await rows())[0]!.processedAt).not.toBeNull();
  expect(await resetRedeliveredDispatch({ job: webhookDispatchJob, scope: database.forGym, clock, recovery: queue },
    gymA, saved.id)).toBe(0);
  expect(await queue.failedJobs(webhookDispatchJob, [saved.id], { gymId: gymA })).toMatchObject([{ jobId: failed!.jobId }]);
  const audits = (await database.forGym(gymA, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, 'billing.webhook.dispatch_retried')))).filter(row => row.targetId === saved.id);
  expect(audits).toEqual([]);
  expect(await queue.runNext()).toBe(false);
});
it('a failed replay preserves the successful processing timestamp, including a concurrent replay failure', async () => {
  const handler = vi.fn(async () => {}); inbox.register('payment_intent.succeeded', handler);
  await deliver(); await jobs.runNext();
  const processedAt = (await rows())[0]!.processedAt;
  handler.mockRejectedValue(new Error('Private provider details'));
  clock.advance(60_000); await inbox.replay(gymA, 'evt_test'); await jobs.runNext();
  expect((await rows())[0]).toMatchObject({ processedAt, error: 'handler_failed' });
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  handler.mockResolvedValue().mockImplementationOnce(async () => {
    started(); await held; throw new Error('Delayed failure');
  });
  const delayedFailure = inbox.dispatch({ eventId: 'evt_test', replay: true }, context()).catch(error => error as Error);
  await entered;
  clock.advance(60_000); await inbox.dispatch({ eventId: 'evt_test', replay: true }, context());
  const latestProcessedAt = clock.now(); release();
  expect(await delayedFailure).toMatchObject({ message: 'Delayed failure' });
  expect((await rows())[0]).toMatchObject({ processedAt: latestProcessedAt, error: 'handler_failed' });
  await deliver(); // A successful event remains processed despite its replay diagnostics.
  expect(jobs.jobs).toHaveLength(2);
});
it('never dispatches, replays, or exposes health for another gym, even with forged job payloads', async () => {
  const handler = vi.fn(); inbox.register('payment_intent.succeeded', handler); await deliver();
  await inbox.dispatch({ eventId: 'evt_test', replay: true }, context(gymB)); expect(handler).not.toHaveBeenCalled();
  await expect(inbox.replay(gymB, 'evt_test')).rejects.toMatchObject({ code: 'not_found' });
  expect(await database.forGym(gymB, (tx) => tx.select().from(stripeEvents))).toEqual([]);
  expect(await createWebhookHealthQuery(database.forGym, clock).get(gymB)).toEqual({
    lastReceivedAt: null, lastProcessedAt: null, pendingCount: 0, failedCount: 0, recentFailedCount: 0, firstChargeAttemptAt: null,
  });
  expect(await createWebhookHealthQuery(database.forGym, clock).get(gymA)).toMatchObject({ pendingCount: 1, failedCount: 0, recentFailedCount: 0 });
});
it('drops a provider result for the wrong gym and globally deduplicates event IDs without exposing the other row', async () => {
  const untrusted = vi.spyOn(fake, 'parseWebhook').mockResolvedValueOnce(event('evt_wrong', gymB));
  await expect(deliver()).rejects.toMatchObject({ code: 'webhook_not_for_gym' }); expect(await rows()).toEqual([]);
  untrusted.mockRestore(); await deliver();
  const other = new FakePayments(gymB, clock), service = build(async () => other);
  const body = new TextEncoder().encode(JSON.stringify(event('evt_test', gymB)));
  await service.receive(gymB, body, other.signWebhook(body));
  expect(await rows()).toHaveLength(1); expect(jobs.jobs).toHaveLength(1);
});
it('marks unsupported event types processed and rejects inconsistent saved identities', async () => {
  await deliver({ ...event(), type: 'payment_intent.created' }); await jobs.runNext();
  expect((await rows())[0]!.processedAt).toEqual(clock.now());
  await database.forGym(gymA, (tx) => tx.update(stripeEvents).set({ payload: event('evt_test', gymB), processedAt: null })
    .where(eq(stripeEvents.eventId, 'evt_test')));
  await expect(inbox.dispatch({ eventId: 'evt_test' }, context())).rejects.toThrow('Invalid stored webhook identity');
});
it('verifies the exact raw body via StripePayments, stores references only, and acknowledges without running handlers', async () => {
  const service = stripe(), handler = vi.fn(); service.register('payment_intent.succeeded', handler);
  const delivery = stripeDelivery();
  expect((await request(server(service), delivery.body, delivery.signature)).status).toBe(200);
  // The verifying key's mode is stored with the event.
  expect(handler).not.toHaveBeenCalled(); expect((await rows())[0]!.payload).toEqual({ ...event('evt_stripe'), livemode: false });
  expect(JSON.stringify(await rows())).not.toContain('private@example.invalid');
  const altered = new TextEncoder().encode(new TextDecoder().decode(delivery.body) + ' ');
  expect((await request(server(service), altered, delivery.signature)).status).toBe(400);
  expect((await request(server(service), delivery.body, '')).status).toBe(400);
});
it('maps only webhook_invalid to 400 and webhook_not_for_gym to 200; all other errors fail for retry', async () => {
  const app = server(stripe()), foreign = stripeDelivery(gymB), ours = stripeDelivery();
  expect((await request(app, foreign.body, foreign.signature)).status).toBe(200); expect(await rows()).toEqual([]);
  for (const failure of [new Error('provider outage'), new PaymentWebhookError('webhook_invalid'), new PaymentWebhookError('webhook_not_for_gym')]) {
    const parse = vi.spyOn(fake, 'parseWebhook').mockRejectedValueOnce(failure);
    const response = await request(server(), ours.body, ours.signature);
    expect(response.status).toBe(failure instanceof PaymentWebhookError ? failure.code === 'webhook_invalid' ? 400 : 200 : 500);
    parse.mockRestore();
  }
  expect(await rows()).toEqual([]);
});
it('returns a clear 503 when the payments resolver has no Stripe settings', async () => {
  const delivery = stripeDelivery(), response = await request(server(build(async () => null)), delivery.body, delivery.signature);
  expect(response.status).toBe(503); expect(await response.text()).toContain('Payments are not set up for this gym');
  expect(await rows()).toEqual([]);
});
it('keeps untagged-object lookup failures retryable before insertion', async () => {
  const transport = new StripeFixtures(gymA); vi.spyOn(transport, 'request').mockRejectedValue(new Error('Stripe outage'));
  const delivery = stripeDelivery(gymA, 'evt_lookup', { id: 'pi_fixture', object: 'payment_intent', metadata: {} });
  expect((await request(server(stripe(transport)), delivery.body, delivery.signature)).status).toBe(500);
  expect(await rows()).toEqual([]);
});
it('routes the shared demo endpoint by verified gym_id metadata without a tenant or session', async () => {
  jobs = new FakeJobs(clock);
  const service = stripe(), handled: string[] = [];
  service.register('payment_intent.succeeded', async (_event, ctx) => { handled.push(ctx.gymId); });
  createServerRegistry({ jobs: createWebhookInboxJobs(service) }).registerJobs(jobs, new Set());
  const app = server(service, true), a = stripeDelivery(gymA, 'evt_a'), b = stripeDelivery(gymB, 'evt_b');
  expect((await request(app, b.body, b.signature)).status).toBe(200);
  expect((await request(app, a.body, a.signature)).status).toBe(200);
  expect((await request(app, b.body, b.signature)).status).toBe(200);
  expect(jobs.jobs).toHaveLength(2);
  for (const gymId of [gymA, gymB]) {
    const own = await database.forGym(gymId, (tx) => tx.select().from(stripeEvents));
    expect(own).toHaveLength(1); expect(own[0]!.gymId).toBe(gymId);
  }
  await jobs.runNext(); await jobs.runNext();
  expect(handled).toEqual([gymB, gymA]);
  const foreign = stripeDelivery(emptyGym, 'evt_foreign');
  expect((await request(app, foreign.body, foreign.signature)).status).toBe(200);
  expect(await rows()).toHaveLength(2);
  const tampered = new TextEncoder().encode(new TextDecoder().decode(b.body).replace(gymB, gymA));
  expect((await request(app, tampered, b.signature)).status).toBe(400);
  expect(await rows()).toHaveLength(2);
});
it('routes untagged demo refunds through provider ownership lookups and rejects malformed signed bodies', async () => {
  const transport = new StripeFixtures(gymA);
  transport.objects.set('pi_refund', { id: 'pi_refund', object: 'payment_intent', metadata: { gym_id: gymB } });
  transport.objects.set('ch_refund', { id: 'ch_refund', object: 'charge', payment_intent: 'pi_refund' });
  const refund = { id: 're_refund', object: 'refund', charge: 'ch_refund', amount: 100, currency: 'cad', status: 'succeeded' };
  transport.objects.set('re_refund', refund);
  const delivery = stripeDelivery(gymB, 'evt_refund', refund), app = server(stripe(transport), true);
  expect((await request(app, delivery.body, delivery.signature)).status).toBe(200);
  expect((await rows())[0]).toMatchObject({ gymId: gymB, payload: { objectKind: 'refund', objectId: 're_refund' } });
  expect(jobs.jobs[0]!.options.gymId).toBe(gymB);
  const invalid = stripeDelivery(gymA, 'evt_invalid', { id: 42, object: 'payment_intent' });
  expect((await request(app, invalid.body, invalid.signature)).status).toBe(400);
  expect(await rows()).toHaveLength(1);
});
it('health counts only this gym and follows processing, failure, and recovery', async () => {
  const health = createWebhookHealthQuery(database.forGym, clock);
  await deliver(); expect(await health.get(gymA)).toEqual({ lastReceivedAt: clock.now().toISOString(), lastProcessedAt: null, pendingCount: 1, failedCount: 0, recentFailedCount: 0, firstChargeAttemptAt: null });
  let fail = true;
  inbox.register('payment_intent.succeeded', async () => { if (fail) throw new Error('failure'); }); await jobs.runNext();
  expect(await health.get(gymA)).toMatchObject({ pendingCount: 0, failedCount: 1, recentFailedCount: 1 });
  fail = false; clock.advance(1000); await jobs.runNext();
  expect(await health.get(gymA)).toEqual({ lastReceivedAt: '2026-10-24T12:00:00.000Z', lastProcessedAt: clock.now().toISOString(), pendingCount: 0, failedCount: 0, recentFailedCount: 0, firstChargeAttemptAt: null });
});
it('health counts a recent failure by when the event last failed, so an old event failing on replay is recent again', async () => {
  const day = 24 * 60 * 60_000, health = createWebhookHealthQuery(database.forGym, clock);
  let fail = true;
  inbox.register('payment_intent.succeeded', async () => { if (fail) throw new Error('failure'); });
  clock.set('2026-09-01T00:00:00Z'); await deliver(); clock.set('2026-10-24T12:00:00Z');
  await expect(inbox.dispatch({ eventId: 'evt_test' }, context())).rejects.toThrow('failure');
  expect((await rows())[0]).toMatchObject({ receivedAt: new Date('2026-09-01T00:00:00Z'), error: 'handler_failed', failedAt: clock.now() });
  expect(await health.get(gymA)).toMatchObject({ failedCount: 1, recentFailedCount: 1 });
  clock.advance(6 * day); expect(await health.get(gymA)).toMatchObject({ failedCount: 1, recentFailedCount: 1 });
  clock.advance(2 * day); expect(await health.get(gymA)).toMatchObject({ failedCount: 1, recentFailedCount: 0 });
  // A replay that fails again moves the failure time, so the event counts as recent once more.
  await expect(inbox.dispatch({ eventId: 'evt_test', replay: true }, context())).rejects.toThrow('failure');
  expect((await rows())[0]).toMatchObject({ error: 'handler_failed', failedAt: clock.now(), processedAt: null });
  expect(await health.get(gymA)).toMatchObject({ failedCount: 1, recentFailedCount: 1 });
  fail = false; clock.advance(1000); await inbox.dispatch({ eventId: 'evt_test', replay: true }, context());
  expect((await rows())[0]).toMatchObject({ processedAt: clock.now(), error: null, failedAt: null });
  expect(await health.get(gymA)).toMatchObject({ failedCount: 0, recentFailedCount: 0 });
});
it('health counts a failure recorded without a failure time by when its event was received', async () => {
  const day = 24 * 60 * 60_000, health = createWebhookHealthQuery(database.forGym, clock);
  const id = uuidv7(), match = eq(stripeEvents.id, id);
  await database.forSystem(tx => tx.insert(stripeEvents).values({ id, eventId: 'evt_old', gymId: gymA, type: 'payment_intent.succeeded',
    payload: event('evt_old'), receivedAt: new Date(clock.now().getTime() - day), error: 'handler_failed' }));
  expect((await rows())[0]).toMatchObject({ failedAt: null });
  expect(await health.get(gymA)).toMatchObject({ failedCount: 1, recentFailedCount: 1 });
  await database.forSystem(tx => tx.update(stripeEvents).set({ receivedAt: new Date(clock.now().getTime() - 8 * day) }).where(match));
  expect(await health.get(gymA)).toMatchObject({ failedCount: 1, recentFailedCount: 0 });
});
it('deduplicates and retries through the real persistent Postgres queue', async () => {
  const queue = new PostgresJobs({ database, clock }), service = createWebhookInbox({
    paymentsFor: async () => fake, jobs: queue, gymSettings, clock, scope: database.forGym, system: database.forSystem,
  });
  createServerRegistry({ jobs: createWebhookInboxJobs(service) }).registerJobs(queue, new Set());
  let calls = 0; service.register('payment_intent.succeeded', async () => { if (++calls === 1) throw new Error('retry'); });
  const delivery = fakeDelivery(event('evt_persistent'));
  await Promise.all([1, 2, 3].map(() => service.receive(gymA, delivery.body, delivery.signature)));
  await queue.runNext(); expect(calls).toBe(1); clock.advance(1000); await queue.runNext(); expect(calls).toBe(2);
  expect(await queue.runNext()).toBe(false);
  await service.replay(gymA, 'evt_persistent'); await queue.runNext(); expect(calls).toBe(3);
});
/** This test's skip audits: the events table is emptied before each test, the audit log isn't. */
async function skippedAudits() {
  const ids = new Set((await rows()).map((row) => row.id));
  return (await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, testEventSkippedAction))))
    .filter((row) => ids.has(row.targetId));
}
/** The gym's key after a switch from test to live; any call to Stripe through it fails the test. */
function liveKey() {
  const live = new FakePayments(gymA, clock); live.keyMode = 'live';
  const calls = [vi.spyOn(live, 'findCharge'), vi.spyOn(live, 'readPaymentObject'), vi.spyOn(live, 'listRefunds')];
  return { live, calls };
}
it('finishes a test-mode event stored before a switch to live with an audit, without its handler or a Stripe call', async () => {
  fake.keyMode = 'test';
  await deliver(event('evt_test_mode')); await deliver(event('evt_still_test'));
  expect((await rows()).map((row) => row.payload)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'evt_test_mode', livemode: false })]));
  // Before the switch the test key reads it as usual.
  const handled = vi.fn(); inbox.register('payment_intent.succeeded', handled);
  await inbox.dispatch({ eventId: 'evt_still_test' }, context()); expect(handled).toHaveBeenCalledTimes(1);
  const { live, calls } = liveKey(), service = build(async () => live), handler = vi.fn();
  service.register('payment_intent.succeeded', handler);
  clock.advance(60_000);
  await service.dispatch({ eventId: 'evt_test_mode' }, context());
  expect(handler).not.toHaveBeenCalled();
  for (const call of calls) expect(call).not.toHaveBeenCalled();
  const row = (await rows()).find((saved) => saved.eventId === 'evt_test_mode')!;
  expect(row).toMatchObject({ processedAt: clock.now(), error: null });
  expect(await skippedAudits()).toMatchObject([{ actorKind: 'system', targetType: 'stripe_event', targetId: row.id,
    after: { eventId: 'evt_test_mode', type: 'payment_intent.succeeded' } }]);
  // A live event for the live key goes to its handler, with no audit.
  live.keyMode = 'live';
  const liveEvent = fakeDelivery(event('evt_live'));
  await build(async () => live).receive(gymA, liveEvent.body, live.signWebhook(liveEvent.body));
  await service.dispatch({ eventId: 'evt_live' }, context());
  expect(handler).toHaveBeenCalledTimes(1); expect(await skippedAudits()).toHaveLength(1);
});
it('treats an event stored without its mode as test-mode only when it arrived before the gym’s latest switch to live', async () => {
  await deliver(event('evt_before'));
  clock.advance(1000);
  await database.forGym(gymA, (tx) => tx.insert(auditEvents).values({ gymId: gymA, actorKind: 'system', action: stripeTestClearedAction,
    targetType: 'gym', targetId: gymA, before: null, after: {}, occurredAt: clock.now() }));
  clock.advance(1000);
  await deliver(event('evt_after'));
  expect((await rows()).every((row) => !('livemode' in (row.payload as object)))).toBe(true);
  const { live } = liveKey(), service = build(async () => live), handler = vi.fn();
  service.register('payment_intent.succeeded', handler);
  await service.dispatch({ eventId: 'evt_before' }, context());
  await service.dispatch({ eventId: 'evt_after' }, context());
  expect(handler.mock.calls.map(([received]) => (received as PaymentEvent).id)).toEqual(['evt_after']);
  expect(await skippedAudits()).toHaveLength(1);
  expect((await rows()).every((row) => row.processedAt !== null && row.error === null)).toBe(true);
});
it('health counts only unprocessed failed events, excluding processed events whose replay failed', async () => {
  const health = createWebhookHealthQuery(database.forGym, clock);
  let fail = false;
  inbox.register('payment_intent.succeeded', async () => { if (fail) throw new Error('replay failure'); });
  await deliver(event('evt_replayed'));
  await inbox.dispatch({ eventId: 'evt_replayed' }, context());
  fail = true;
  clock.advance(1000);
  await expect(inbox.dispatch({ eventId: 'evt_replayed', replay: true }, context())).rejects.toThrow('replay failure');
  await deliver(event('evt_unprocessed_failed'));
  await expect(inbox.dispatch({ eventId: 'evt_unprocessed_failed' }, context())).rejects.toThrow('replay failure');
  await deliver(event('evt_pending'));
  expect(await health.get(gymA)).toMatchObject({ failedCount: 1, recentFailedCount: 1, pendingCount: 1 });
});
it('health reports the earliest Stripe payment attempt per gym, ignoring attempts without a PaymentIntent ID', async () => {
  const gym1 = uuidv7(), gym2 = uuidv7(), gymEmpty = uuidv7();
  for (const id of [gym1, gym2, gymEmpty]) await factory('gyms', id);
  const t = new Date('2026-10-20T12:00:00Z');
  const tMinus1h = new Date(t.getTime() - 3_600_000);
  const tPlus1h = new Date(t.getTime() + 3_600_000);
  const tMinus2h = new Date(t.getTime() - 7_200_000);
  await factory('paymentAttempts', gym1, { paymentIntentId: null, createdAt: tMinus1h });
  await factory('paymentAttempts', gym1, { paymentIntentId: 'pi_first', createdAt: t });
  await factory('paymentAttempts', gym1, { paymentIntentId: 'pi_second', createdAt: tPlus1h });
  await factory('paymentAttempts', gym2, { paymentIntentId: 'pi_other_gym', createdAt: tMinus2h });
  const health = createWebhookHealthQuery(database.forGym, clock);
  expect((await health.get(gym1)).firstChargeAttemptAt).toBe(t.toISOString());
  expect((await health.get(gymEmpty)).firstChargeAttemptAt).toBeNull();
});
const savedAt = new Date('2026-10-20T12:00:00Z'), threeDaysBefore = new Date('2026-10-17T12:00:00Z'),
  hourAfter = new Date('2026-10-20T13:00:00Z');
async function chargeGym(...attemptTimes: Date[]) {
  const gymId = uuidv7(); await factory('gyms', gymId);
  for (const [index, createdAt] of attemptTimes.entries())
    await factory('paymentAttempts', gymId, { paymentIntentId: `pi_${gymId}_${index}`, createdAt });
  return gymId;
}
// Save paths date audits by the service clock (occurredAt); createdAt stays the database's now, after every attempt here.
const stripeAudit = (gymId: string, action: string, at = savedAt) =>
  factory('auditEvents', gymId, { action, targetType: 'gym', targetId: gymId, occurredAt: at });
const firstAttempt = async (gymId: string) =>
  (await createWebhookHealthQuery(database.forGym, clock).get(gymId)).firstChargeAttemptAt;
it.each(['integrations.stripe_saved', 'setup.stripe_configured', 'payments.webhook_endpoint_replaced',
  'payments.webhook_endpoint_recreated'])('health counts charge attempts from the %s audit', async (action) => {
  const gymId = await chargeGym(threeDaysBefore, hourAfter);
  await stripeAudit(gymId, action);
  expect(await firstAttempt(gymId)).toBe(hourAfter.toISOString());
});
it('health counts a charge attempt made at the moment of the Stripe save', async () => {
  const gymId = await chargeGym(threeDaysBefore, savedAt, hourAfter);
  await stripeAudit(gymId, 'integrations.stripe_saved');
  expect(await firstAttempt(gymId)).toBe(savedAt.toISOString());
});
it('health counts from the latest of several Stripe saves and ignores other audits', async () => {
  const gymId = await chargeGym(threeDaysBefore, hourAfter);
  await stripeAudit(gymId, 'setup.stripe_configured', new Date('2026-10-16T12:00:00Z'));
  await stripeAudit(gymId, 'payments.webhook_endpoint_replaced');
  await stripeAudit(gymId, 'integrations.email_tested', new Date('2026-10-21T12:00:00Z'));
  expect(await firstAttempt(gymId)).toBe(hourAfter.toISOString());
});
it('health reports no charge attempt when every one predates the latest Stripe save', async () => {
  const gymId = await chargeGym(threeDaysBefore);
  await stripeAudit(gymId, 'integrations.stripe_saved');
  expect(await firstAttempt(gymId)).toBeNull();
});
it('health ignores another gym\'s Stripe save', async () => {
  const gymId = await chargeGym(threeDaysBefore, hourAfter), other = await chargeGym();
  await stripeAudit(other, 'integrations.stripe_saved');
  expect(await firstAttempt(gymId)).toBe(threeDaysBefore.toISOString());
});
