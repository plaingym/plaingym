// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Assembly test inspects gym settings, queued jobs, verification rows and stored webhooks in real PostgreSQL.
import { authVerification, emailOutbox, gyms, jobs, stripeEvents, uuidv7 } from '@plaingym/db';
import * as stripeAdapter from '../infra/payments/stripe.js';
import { StripeFixtures } from '../infra/payments/stripe-fixtures.js';
import { clock } from './clock.js';
import { demoStripeEnv, useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;

it('publishes, sends and scans campaigns through the runtime composition', async () => {
  const sandbox = app.sandbox, ownerCookie = await app.login('owner');
  await database.forGym(sandbox.gymId, (tx) => tx.update(gyms).set({ memberEmailsEnabled: true }).where(eq(gyms.id, sandbox.gymId)));
  const household = await factory('households', sandbox.gymId, { email: 'campaign@example.test', stripeCustomerId: 'cus_campaign_runtime' });
  const response = await app.post('/api/link-campaigns', { name: 'Collect cards', purpose: 'update_card',
    recipients: [{ householdId: household.id }], reminderSchedule: [], expiresAt: new Date(clock.now().getTime() + 86400000).toISOString(),
  }, sandbox.origin, { cookie: ownerCookie });
  expect(response.status).toBe(200);
  const run = async (name: string, payload: unknown) => {
    const handler = app.handlers.get(name); expect(handler, name).toBeDefined();
    await handler!(payload, { gymId: sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  };
  for (const name of ['links.campaigns.publish', 'links.campaigns.send']) {
    const queued = await database.forGym(sandbox.gymId, tx => tx.select().from(jobs).where(eq(jobs.name, name)));
    expect(queued).toHaveLength(1);
    await run(name, (queued[0]!.payload as { value: unknown }).value);
  }
  await run('links.campaigns.scan', {});
  const messages = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox));
  expect(messages.filter(message => message.recipient === household.email)).toEqual([
    expect.objectContaining({ text: expect.stringContaining(sandbox.origin + '/l/') }),
  ]);
});
it('stores a signed Stripe event for its gym and queues its dispatch through the runtime composition', async () => {
  const sandbox = app.sandbox, delivery = app.deliverStripeEvent;
  // This runtime has no install-level shared key.
  const unconfigured = await delivery('evt_runtime');
  expect(unconfigured.status).toBe(503);
  expect(await unconfigured.text()).toContain('Payments are not set up for this gym');
  const provider = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(new StripeFixtures(sandbox.gymId));
  try {
    await app.restart(demoStripeEnv);
    expect((await delivery('evt_runtime')).status).toBe(200);
    expect((await delivery('evt_runtime')).status).toBe(200);
    const stored = await database.forGym(sandbox.gymId, (tx) => tx.select().from(stripeEvents));
    expect(stored).toMatchObject([{ eventId: 'evt_runtime', gymId: sandbox.gymId, type: 'payment_intent.succeeded' }]);
    expect(await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.name, 'billing.webhooks.dispatch')))).toHaveLength(1);
  } finally { provider.mockRestore(); await app.restart(); }
});
it('schedules daily job retention on the worker queue, keeping billing alert jobs', async () => {
  // The worker's first tick schedules today's retention run at 03:30 UTC as an install job.
  const queue = app.queue, date = new Date().toISOString().slice(0, 10);
  await queue.scheduleDue();
  const retention = await database.forSystem(tx => tx.select().from(jobs).where(eq(jobs.name, 'jobs.retention')));
  expect(retention.map(job => ({ gymId: job.gymId, status: job.status, runAt: job.runAt.toISOString() })))
    .toContainEqual({ gymId: null, status: 'pending', runAt: `${date}T03:30:00.000Z` });
  const old = new Date(Date.now() - 30 * 86_400_000);
  const finished = (name: string) => ({ id: uuidv7(), gymId: app.sandbox.gymId, name, status: 'succeeded', attempts: 1, maxAttempts: 3,
    payload: { version: 1, timezone: 'UTC', value: {} }, idempotencyKey: `unique:${uuidv7()}`, runAt: old, createdAt: old });
  const alert = finished('billing.alerts.send'), other = finished('bookings.notice');
  await database.forSystem(tx => tx.insert(jobs).values([alert, other]));
  await queue.prune();
  const kept = await database.forSystem(tx => tx.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, [alert.id, other.id])));
  expect(kept).toEqual([{ id: alert.id }]);
});
it('registers the hourly portal invitation sweep, which deletes expired verification rows on the auth pool', async () => {
  const handler = app.handlers.get('members.portal-invitations.expire');
  expect(handler).toBeDefined();
  const stale = { id: uuidv7(), identifier: `magic-link:${uuidv7()}`, value: '{}', expiresAt: new Date(clock.now().getTime() - 60_000) };
  const live = { id: uuidv7(), identifier: `magic-link:${uuidv7()}`, value: '{}', expiresAt: new Date(clock.now().getTime() + 600_000) };
  await database.forSystem(tx => tx.insert(authVerification).values([stale, live]));
  try {
    await handler!({}, { gymId: app.sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
    const left = await database.forSystem(tx => tx.select({ id: authVerification.id }).from(authVerification)
      .where(inArray(authVerification.id, [stale.id, live.id])));
    expect(left).toEqual([{ id: live.id }]);
  } finally { await database.forSystem(tx => tx.delete(authVerification).where(inArray(authVerification.id, [stale.id, live.id]))); }
});
it('runs a webhook dispatch while a daily charge run holds the gym\'s batch lane', async () => {
  const queue = app.queue, gymId = app.sandbox.gymId, now = Date.now();
  const job = (name: string, value: object, runAt: Date) => ({ id: uuidv7(), gymId, name, status: 'pending', attempts: 0, maxAttempts: 3,
    payload: { version: 1, timezone: 'UTC', value }, idempotencyKey: `unique:${uuidv7()}`, runAt, createdAt: runAt });
  // Another slot is mid-way through the daily run; due first, a second daily run and then a webhook dispatch wait.
  const running = { ...job('billing.runner.daily', {}, new Date(now - 60_000)), status: 'running', attempts: 1,
    lockedUntil: new Date(now + 600_000), lockToken: uuidv7() };
  const waiting = job('billing.runner.daily', { continues: '2000-01-01' }, new Date('2000-01-01T00:00:00Z'));
  const dispatch = job('billing.webhooks.dispatch', { eventId: uuidv7() }, new Date('2000-01-01T00:00:01Z'));
  await database.forSystem(tx => tx.insert(jobs).values([running, waiting, dispatch]));
  try {
    expect(await queue.runNext()).toBe(true);
    const rows = await database.forSystem(tx => tx.select({ id: jobs.id, status: jobs.status }).from(jobs)
      .where(inArray(jobs.id, [waiting.id, dispatch.id])));
    expect(Object.fromEntries(rows.map(row => [row.id, row.status]))).toEqual({ [waiting.id]: 'pending', [dispatch.id]: 'succeeded' });
  } finally { await database.forSystem(tx => tx.delete(jobs).where(inArray(jobs.id, [running.id, waiting.id, dispatch.id]))); }
});
