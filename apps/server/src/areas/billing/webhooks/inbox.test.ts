// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { stripeEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../../core/context.js';
import { errorHandler } from '../../../core/errors.js';
import { createServerRegistry } from '../../../core/registry.js';
import { FakeJobs, PostgresJobs } from '../../../infra/jobs/index.js';
import { FakePayments, type PaymentEvent, type Payments } from '../../../infra/payments/index.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import type { ObjectData } from '../../../infra/payments/transport.js';
import { PaymentWebhookError } from '../../../infra/payments/webhook-error.js';
import { createWebhookHealthQuery, createWebhookInbox, type WebhookInbox } from './inbox.js';
import { createWebhookInboxJobs } from './inbox.jobs.js';
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
function build(paymentsFor: (gymId: string) => Promise<Payments | null>, queue = jobs) {
  return createWebhookInbox({ paymentsFor, jobs: queue, gymSettings, clock, scope: database.forGym, system: database.forSystem });
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
it('never dispatches, replays, or exposes health for another gym, even with forged job payloads', async () => {
  const handler = vi.fn(); inbox.register('payment_intent.succeeded', handler); await deliver();
  await inbox.dispatch({ eventId: 'evt_test', replay: true }, context(gymB)); expect(handler).not.toHaveBeenCalled();
  await expect(inbox.replay(gymB, 'evt_test')).rejects.toMatchObject({ code: 'not_found' });
  expect(await database.forGym(gymB, (tx) => tx.select().from(stripeEvents))).toEqual([]);
  expect(await createWebhookHealthQuery(database.forGym).get(gymB)).toEqual({
    lastReceivedAt: null, lastProcessedAt: null, pendingCount: 0, failedCount: 0,
  });
  expect(await createWebhookHealthQuery(database.forGym).get(gymA)).toMatchObject({ pendingCount: 1, failedCount: 0 });
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
  expect(handler).not.toHaveBeenCalled(); expect((await rows())[0]!.payload).toEqual(event('evt_stripe'));
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
it('keeps untagged-object lookup failures retryable before insertion (T35)', async () => {
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
  const health = createWebhookHealthQuery(database.forGym);
  await deliver(); expect(await health.get(gymA)).toEqual({ lastReceivedAt: clock.now().toISOString(), lastProcessedAt: null, pendingCount: 1, failedCount: 0 });
  let fail = true;
  inbox.register('payment_intent.succeeded', async () => { if (fail) throw new Error('failure'); }); await jobs.runNext();
  expect(await health.get(gymA)).toMatchObject({ pendingCount: 0, failedCount: 1 });
  fail = false; clock.advance(1000); await jobs.runNext();
  expect(await health.get(gymA)).toEqual({ lastReceivedAt: '2026-10-24T12:00:00.000Z', lastProcessedAt: clock.now().toISOString(), pendingCount: 0, failedCount: 0 });
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
