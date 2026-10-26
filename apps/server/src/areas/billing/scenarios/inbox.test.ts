// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { asc } from 'drizzle-orm';
import { uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Inbox scenarios inspect event and queue rows through the test gym's RLS scope.
import { jobs, stripeEvents } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import type { RequestEnvironment } from '../../../core/context.js';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createWebhookInbox, webhookDispatchJob } from '../webhooks/inbox.js';
import { createWebhookInboxJobs } from '../webhooks/inbox.jobs.js';
import { createWebhookInboxRoutes } from '../webhooks/inbox.routes.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), timezone = 'America/Vancouver';
  await factory('gyms', gymId, { timezone });
  const clock = new TestClock('2028-03-01T20:00:00Z'), secret = 'whsec_SYNTHETIC_SCENARIO';
  const queue = new PostgresJobs({ database: db, clock });
  // Synthetic Stripe API fixtures with the real adapter's signature verification, not FakePayments.
  const provider = new StripePayments(gymId, { transport: new StripeFixtures(gymId), webhookSecret: secret, clock, mode: 'test' });
  const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock, jobs: queue,
    gymSettings: createGymSettingsAccessor({ scope: db.forGym }), async paymentsFor() { return provider; } });
  const handler = vi.fn(async () => {});
  inbox.register('payment_intent.succeeded', handler);
  for (const job of createWebhookInboxJobs(inbox)) queue.handle(job.id, job.handler);
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (context, next) => {
    context.set('context', { requestId: 'billing-scenario', principal: { kind: 'anonymous' }, clock,
      gym: { gymId, timezone, enabledModules: new Set<string>() } });
    await next();
  });
  for (const entry of createWebhookInboxRoutes(inbox)) entry.mount(app, () => async (_context, next) => next());
  function delivery(eventId = 'evt_' + uuidv7()) {
    const body = JSON.stringify({ id: eventId, object: 'event', type: 'payment_intent.succeeded', livemode: false,
      data: { object: { id: 'pi_scenario', object: 'payment_intent', metadata: { gym_id: gymId } } } });
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex')}`;
    return { body, signature, eventId };
  }
  const receive = ({ body, signature }: { body: string; signature: string }) => app.request('https://gym.example.invalid/webhooks/stripe', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': signature },
  });
  const read = () => db.forGym(gymId, async tx => ({
    events: await tx.select().from(stripeEvents).orderBy(asc(stripeEvents.id)),
    jobs: await tx.select().from(jobs).orderBy(asc(jobs.id)),
  }));
  return { gymId, clock, queue, handler, delivery, receive, read };
}

describe('billing scenarios: durable webhook inbox without payment handlers', () => {
  it.each(['invalid signature', 'tampered body'])('rejects %s before inserting an event or dispatch job', async invalid => {
    const f = await fixture(), delivery = f.delivery();
    const response = await f.receive(invalid === 'invalid signature'
      ? { ...delivery, signature: delivery.signature.replace(/v1=.*/, 'v1=' + '0'.repeat(64)) }
      : { ...delivery, body: delivery.body + ' ' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'webhook_invalid' });
    expect(await f.read()).toEqual({ events: [], jobs: [] });
    expect(f.handler).not.toHaveBeenCalled();
  });

  it('dispatches once per event ID across concurrent deliveries and redelivery after processing', async () => {
    const f = await fixture(), delivery = f.delivery();
    const responses = await Promise.all([f.receive(delivery), f.receive(delivery), f.receive(delivery)]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    let state = await f.read();
    expect(state.events).toMatchObject([{ eventId: delivery.eventId, processedAt: null, error: null }]);
    expect(state.jobs).toMatchObject([{ name: webhookDispatchJob, status: 'pending', attempts: 0,
      payload: { value: { eventId: delivery.eventId } } }]);
    expect(f.handler).not.toHaveBeenCalled();
    expect(await f.queue.runNext()).toBe(true);
    expect((await f.receive(delivery)).status).toBe(200);
    expect(await f.queue.runNext()).toBe(false);
    state = await f.read();
    expect(state.events).toMatchObject([{ eventId: delivery.eventId, processedAt: f.clock.now(), error: null }]);
    expect(state.jobs).toMatchObject([{ name: webhookDispatchJob, status: 'succeeded', attempts: 1 }]);
    expect(f.handler).toHaveBeenCalledTimes(1);

    // Another event for the same processor object gets its own dispatch.
    const next = f.delivery();
    expect((await f.receive(next)).status).toBe(200);
    expect((await f.receive(next)).status).toBe(200);
    expect(await f.queue.runNext()).toBe(true);
    expect(await f.queue.runNext()).toBe(false);
    state = await f.read();
    expect(state.events).toHaveLength(2);
    expect(state.jobs).toHaveLength(2);
    expect(state.jobs.every(job => job.status === 'succeeded' && job.attempts === 1)).toBe(true);
    expect(f.handler).toHaveBeenCalledTimes(2);
  });
});
