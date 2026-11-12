// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
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
it('registers the hourly lapsed refund sweep, and a run with nothing lapsed ends without a provider', async () => {
  const handler = app.handlers.get('billing.payments.settle_lapsed');
  expect(handler).toBeDefined();
  // This runtime has no Stripe keys: with no lapsed reservation the sweep must not ask for a provider.
  await expect(handler!({}, { gymId: app.sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 })).resolves.toBeUndefined();
});
it('registers the hourly per-gym portal invitation sweep, which leaves the install\'s other verification rows to the install sweep', async () => {
  const handler = app.handlers.get('members.portal-invitations.expire');
  expect(handler).toBeDefined();
  const stale = { id: uuidv7(), identifier: `magic-link:${uuidv7()}`, value: '{}', expiresAt: new Date(clock.now().getTime() - 60_000) };
  const live = { id: uuidv7(), identifier: `magic-link:${uuidv7()}`, value: '{}', expiresAt: new Date(clock.now().getTime() + 600_000) };
  await database.forSystem(tx => tx.insert(authVerification).values([stale, live]));
  try {
    await handler!({}, { gymId: app.sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
    const left = await database.forSystem(tx => tx.select({ id: authVerification.id }).from(authVerification)
      .where(inArray(authVerification.id, [stale.id, live.id])));
    expect(left.map(row => row.id).sort()).toEqual([stale.id, live.id].sort());
  } finally { await database.forSystem(tx => tx.delete(authVerification).where(inArray(authVerification.id, [stale.id, live.id]))); }
});
it('registers the hourly per-gym email delivery upkeep', async () => {
  const handler = app.handlers.get('email.deliveries.upkeep');
  expect(handler).toBeDefined();
  await expect(handler!({}, { gymId: app.sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 })).resolves.toBeUndefined();
});
it('registers the install\'s verification sweep, which leaves portal invitations and onboarding claim holds alone', async () => {
  const handler = app.systemHandlers.get('auth.verifications.sweep');
  expect(handler).toBeDefined();
  const gymId = app.sandbox.gymId, past = new Date(clock.now().getTime() - 60_000), future = new Date(clock.now().getTime() + 600_000);
  const stale = { id: uuidv7(), identifier: `magic-link:${uuidv7()}`, value: '{}', expiresAt: past };
  const live = { id: uuidv7(), identifier: `magic-link:${uuidv7()}`, value: '{}', expiresAt: future };
  const invitation = { id: uuidv7(), identifier: `portal-invitation:${gymId}:${uuidv7()}`, value: '{}', expiresAt: past, gymId, householdId: uuidv7() };
  const hold = { id: uuidv7(), identifier: `portal-claim:${gymId}:${uuidv7()}`, value: '{}', expiresAt: past, gymId, householdId: uuidv7() };
  const ids = [stale.id, live.id, invitation.id, hold.id];
  await database.forSystem(tx => tx.insert(authVerification).values([stale, live, invitation, hold]));
  try {
    await handler!({}, { gymId: null, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
    const left = await database.forSystem(tx => tx.select({ id: authVerification.id }).from(authVerification)
      .where(inArray(authVerification.id, ids)));
    expect(left.map(row => row.id).sort()).toEqual([live.id, invitation.id, hold.id].sort());
  } finally { await database.forSystem(tx => tx.delete(authVerification).where(inArray(authVerification.id, ids))); }
});
it('schedules one verification sweep an hour for the install, however many runtimes start', async () => {
  const sweeps = () => database.forSystem(tx => tx.select({ gymId: jobs.gymId, runAt: jobs.runAt }).from(jobs)
    .where(eq(jobs.name, 'auth.verifications.sweep')));
  const hour = () => new Date(Math.floor(clock.now().getTime() / 3_600_000) * 3_600_000).toISOString();
  expect((await sweeps()).map(job => job.gymId)).toContain(null);
  await database.forSystem(tx => tx.delete(jobs).where(eq(jobs.name, 'auth.verifications.sweep')));
  // Two more starts against the same database: each schedules the current hour, which its idempotency key collapses.
  const before = hour();
  await app.restart(); await app.restart();
  const after = hour(), queued = await sweeps(), hours = queued.map(job => job.runAt.toISOString());
  expect(queued.every(job => job.gymId === null)).toBe(true);
  expect(new Set(hours).size).toBe(hours.length);
  expect(hours).toContain(after);
  expect(hours.every(at => at === before || at === after)).toBe(true);
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
// Known long-running jobs must keep declaring their lane, even if a registration accidentally loses it.
const knownBatchJobs = ['billing.runner.daily', 'imports.pipeline', 'imports.export',
  'links.campaigns.scan', 'links.campaigns.publish', 'links.campaigns.send'];
/** A pending or leased job of the sandbox gym; due at `runAt`, so the earliest ones are claimed first. */
function leaseOf(name: string, runAt: Date, running: boolean) {
  return { id: uuidv7(), gymId: app.sandbox.gymId, name, status: running ? 'running' : 'pending', attempts: running ? 1 : 0, maxAttempts: 3,
    payload: { version: 1, timezone: 'UTC', value: name === 'billing.webhooks.dispatch' ? { eventId: uuidv7() } : {} },
    idempotencyKey: `unique:${uuidv7()}`, runAt, createdAt: runAt,
    ...(running ? { lockedUntil: new Date(Date.now() + 600_000), lockToken: uuidv7() } : {}) };
}
/** Leaves the gym one running job, one waiting job of the same name and one webhook dispatch, then claims once. */
async function claimBeside(name: string) {
  const gymId = app.sandbox.gymId;
  await database.forSystem(tx => tx.delete(jobs).where(and(eq(jobs.gymId, gymId), eq(jobs.status, 'pending'))));
  const running = leaseOf(name, new Date('2000-01-01T00:00:00Z'), true), waiting = leaseOf(name, new Date('2000-01-01T00:00:00Z'), false),
    dispatch = leaseOf('billing.webhooks.dispatch', new Date('2000-01-01T00:00:01Z'), false);
  await database.forSystem(tx => tx.insert(jobs).values([running, waiting, dispatch]));
  try {
    await app.queue.runNext();
    const rows = await database.forSystem(tx => tx.select({ id: jobs.id, status: jobs.status }).from(jobs)
      .where(inArray(jobs.id, [waiting.id, dispatch.id])));
    const status = Object.fromEntries(rows.map(row => [row.id, row.status]));
    return { waiting: status[waiting.id], dispatch: status[dispatch.id] };
  } finally { await database.forSystem(tx => tx.delete(jobs).where(inArray(jobs.id, [running.id, waiting.id, dispatch.id]))); }
}
it.each(knownBatchJobs)('registers %s in the batch lane', (name) => {
  expect(app.batchJobs.has(name), name).toBe(true);
});
it('isolates every registered batch job from webhook dispatch, including new registrations', async () => {
  expect(app.batchJobs.size).toBeGreaterThan(0);
  for (const name of app.batchJobs) {
    expect(await claimBeside(name), name).toEqual({ waiting: 'pending', dispatch: 'succeeded' });
  }
});
it('runs a job registered without a lane in the default lane, where it holds up the gym\'s webhook dispatch', async () => {
  // The hourly reconcile sits in the charge runner's registrations beside the daily run, but names no lane.
  expect(app.handlers.has('billing.runner.reconcile')).toBe(true);
  expect(await claimBeside('billing.runner.reconcile')).toMatchObject({ waiting: 'pending', dispatch: 'pending' });
});
