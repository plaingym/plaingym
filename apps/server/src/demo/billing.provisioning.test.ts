// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { gymDomains, gyms, households, invoices, kioskDevices, paymentMethods, staffRoles, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../core/clock.js';
import { createApp } from '../core/app.js';
import { setLogSink } from '../core/log.js';
import { StripePayments } from '../infra/payments/stripe.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { createAccountService } from '../infra/auth/accounts.js';
import { createGymSettingsAccessor } from '../areas/settings/settings.js';
import { createWebhookInbox, webhookDispatchJob } from '../areas/billing/webhooks/inbox.js';
import { demoBootCheck } from './config.js';
import { createDemoPayments } from './payments.js';
import { demoWebhookMiddleware } from './webhook.js';
import { demoEmail } from './identities.js';
import { createDemoRoutes } from './demo.routes.js';
import { baseEnv, fixture, secret } from './billing.fixture.test-helper.js';

const db = useTestDatabase(), factory = createFactories(db);

it.each([false, true])('preserves a billing seed failure after switch revisions change, even if upload cleanup fails (%s)', async cleanupFails => {
  const f = fixture(db, true), failure = Object.assign(new Error('provider credential=PRIVATE_SEED_SECRET'), { code: 'permission_denied' });
  const cleanupFailure = Object.assign(new Error('storage credential=PRIVATE_STORAGE_SECRET'), { code: 'AccessDenied' });
  const entries: string[] = [], previous = setLogSink(line => entries.push(line));
  const original = f.provider.getMockImplementation()!;
  const remove = vi.spyOn(f.deletion, 'remove');
  let failedGymId = '';
  f.provider.mockImplementation(async gymId => {
    failedGymId = gymId;
    const gateway = await original(gymId);
    vi.spyOn(gateway, 'seedCard').mockRejectedValue(failure);
    return gateway;
  });
  if (cleanupFails) f.removeUploads.mockRejectedValueOnce(cleanupFailure);
  try {
    const unrelated = uuidv7(); await factory('gyms', unrelated, { revision: 7 });
    await expect(f.service.create()).rejects.toBe(failure);
    // The real billing seed toggles billing on and back off before failing: revision 1 -> 3.
    expect(remove).toHaveBeenCalledExactlyOnceWith(failedGymId, 3);
    expect(f.removeUploads).toHaveBeenCalledExactlyOnceWith(failedGymId);
    expect(await db.forGym(unrelated, tx => tx.select().from(gyms))).toMatchObject([{ revision: 7, status: 'active' }]);
    const rows = await db.forGym(failedGymId, async tx => ({
      gyms: await tx.select().from(gyms), households: await tx.select().from(households),
      roles: await tx.select().from(staffRoles), devices: await tx.select().from(kioskDevices),
    }));
    if (cleanupFails) {
      expect(rows.gyms).toMatchObject([{ status: 'suspended', revision: 4, billingEnabled: false, settings: { demo: { ready: false } } }]);
      await expect(f.service.status(failedGymId)).rejects.toMatchObject({ code: 'not_found' });
      expect(entries.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
        event: 'demo.cleanup_failed', gymId: failedGymId, error: expect.objectContaining({ code: 'AccessDenied' }),
      }));
      // Expiration uses the surviving revision and can retry the normal deletion path.
      f.clock.advance(24 * 60 * 60 * 1000);
      await f.service.expire(failedGymId);
    } else {
      expect(rows).toEqual({ gyms: [], households: [], roles: [], devices: [] });
      expect(entries.map(line => JSON.parse(line)).some(entry => entry.event === 'demo.cleanup_failed')).toBe(false);
    }
    expect(await db.forGym(failedGymId, tx => tx.select().from(gyms))).toEqual([]);
    expect(await db.forGym(failedGymId, tx => tx.select().from(households))).toEqual([]);
    expect(await db.forSystem(tx => tx.select().from(gymDomains).where(eq(gymDomains.gymId, failedGymId)))).toEqual([]);
    const accounts = createAccountService(f.authentication, () => db.system.db);
    for (const role of ['owner', 'coach', 'student'] as const)
      expect(await accounts.findUserByEmail(demoEmail(failedGymId, role))).toBeNull();
    const logs = entries.map(line => JSON.parse(line));
    expect(logs).toContainEqual(expect.objectContaining({ event: 'demo.seed_failed', gymId: failedGymId, step: 'billing',
      error: expect.objectContaining({ code: 'permission_denied' }) }));
    expect(logs).toContainEqual(expect.objectContaining({ event: 'demo.provisioning_failed', gymId: failedGymId,
      error: expect.objectContaining({ code: 'permission_denied' }) }));
    for (const secret of ['PRIVATE_SEED_SECRET', 'PRIVATE_STORAGE_SECRET']) expect(entries.join('\n')).not.toContain(secret);
  } finally { setLogSink(previous); }
}, 90_000);

it('returns a safe provisioning error with its request ID instead of a rollback conflict on the demo entry route', async () => {
  const f = fixture(db, true), original = f.provider.getMockImplementation()!;
  f.provider.mockImplementation(async gymId => {
    const gateway = await original(gymId);
    vi.spyOn(gateway, 'seedCard').mockRejectedValue(Object.assign(new Error('PRIVATE_STRIPE_CREDENTIAL'), { code: 'more_permissions_required' }));
    return gateway;
  });
  f.removeUploads.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_CREDENTIAL'));
  const entries: string[] = [], previous = setLogSink(line => entries.push(line));
  const tenant = vi.fn(async () => { throw new Error('Install request reached tenant middleware'); });
  const app = createApp({ resolveGym: tenant, session: tenant, authorize: () => tenant, clock: f.clock,
    installOrigin: 'https://demo.example.test', contributions: { routes: createDemoRoutes(f.service, { installOrigin: 'https://demo.example.test' }) } });
  try {
    const response = await app.request('https://demo.example.test/api/demo/sandboxes', { method: 'POST',
      headers: { host: 'demo.example.test', origin: 'https://demo.example.test', 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'internal', message: 'An unexpected error occurred.' }, requestId: response.headers.get('x-request-id') });
    expect(entries.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'http.unhandled',
      requestId: response.headers.get('x-request-id'), error: expect.objectContaining({ code: 'more_permissions_required' }) }));
    expect(entries.join('\n')).not.toContain('PRIVATE_');
    expect(tenant).not.toHaveBeenCalled();
    const gymId = f.provider.mock.calls[0]![0];
    f.clock.advance(24 * 60 * 60 * 1000);
    await f.service.expire(gymId);
  } finally { setLogSink(previous); }
}, 90_000);

async function drain(queue: PostgresJobs) {
  for (let count = 0; count < 200; count++) if (!await queue.runNext()) return;
  throw new Error('Demo test job drain exceeded its bound');
}


it('creates a sandbox without a key, logs the billing skip, and leaves billing unconfigured', async () => {
  const f = fixture(db, false), { gymId } = await f.service.create();
  expect(await f.service.status(gymId)).toHaveProperty('expiresAt');
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/billing seed skipped.*DEMO_STRIPE_TEST_KEY.*not configured/));
  expect(await f.payments.paymentsFor(gymId)).toBeNull();
  expect(await db.forGym(gymId, tx => tx.select().from(invoices))).toEqual([]);
  expect(await db.forGym(gymId, tx => tx.select().from(paymentMethods))).toEqual([]);
}, 90_000);

it('dispatches the install webhook only to its active sandbox and drops expired, unknown and unrelated events', async () => {
  const clock = new TestClock('2026-10-26T12:00:00Z'), a = uuidv7(), b = uuidv7(), ordinary = uuidv7();
  for (const gymId of [a, b]) await factory('gyms', gymId, { settings: { demo: { sandbox: true, ready: true, expiresAt: '2026-10-27T12:00:00Z' } } });
  await factory('gyms', ordinary);
  const config = demoBootCheck({ ...baseEnv, DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: secret });
  const transport = { request: vi.fn(async () => { throw new Error('Unexpected network lookup'); }) };
  const payments = createDemoPayments({ config, scope: db.forGym, system: db.forSystem, clock, provider: async gymId => ({
    gymId, mode: 'test', payments: new StripePayments(gymId, { transport, webhookSecret: secret, mode: 'test', clock }),
    async seedCard() { throw new Error('No card seeding during webhooks'); },
  }) });
  const queue = new PostgresJobs({ clock, database: db }), settings = createGymSettingsAccessor({ scope: db.forGym, clock });
  const inbox = createWebhookInbox({ paymentsFor: payments.paymentsFor, jobs: queue, gymSettings: settings, clock, scope: db.forGym, system: db.forSystem });
  const handled = vi.fn(async () => {});
  inbox.register('payment_intent.succeeded', handled);
  queue.handle(webhookDispatchJob, inbox.dispatch);
  const tenant = vi.fn(async () => { throw new Error('Install webhook reached tenant middleware'); });
  let restoring = false;
  const app = createApp({ resolveGym: tenant, session: tenant, authorize: () => tenant, clock,
    restoreGate: demoWebhookMiddleware({ configured: true, inbox, demoGyms: payments.demoGyms,
      restoreGate: async (c, next) => { if (restoring) return c.json({ restoring: true }, 503); await next(); } }),
  });
  const deliver = async (gymId: string, id: string, type = 'payment_intent.succeeded') => {
    const body = JSON.stringify({ id, object: 'event', type, livemode: false,
      data: { object: { id: 'pi_demo', object: type === 'ignored' ? 'unrelated' : 'payment_intent', metadata: { gym_id: gymId } } } });
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')}`;
    return app.request('https://demo.example.test/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signature } });
  };
  expect((await deliver(a, 'evt_A')).status).toBe(200);
  expect((await deliver(a, 'evt_A')).status).toBe(200);
  await drain(queue); expect(handled).toHaveBeenCalledOnce();
  expect(handled).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_A', gymId: a }), expect.objectContaining({ gymId: a }));
  await expect(inbox.replay(b, 'evt_A')).rejects.toMatchObject({ code: 'not_found' });
  expect((await deliver(uuidv7(), 'evt_unknown')).status).toBe(200);
  expect((await deliver(ordinary, 'evt_ordinary')).status).toBe(200);
  expect((await deliver(a, 'evt_unrelated', 'ignored')).status).toBe(200);
  await db.forGym(a, tx => tx.update(gyms).set({ settings: { demo: { sandbox: true, ready: true, expiresAt: clock.now().toISOString() } } }).where(eq(gyms.id, a)));
  expect((await deliver(a, 'evt_expired')).status).toBe(200);
  expect(await payments.paymentsFor(a)).toBeNull();
  restoring = true; expect((await deliver(b, 'evt_restore')).status).toBe(503); restoring = false;
  clock.advance(86_400_000);
  expect((await deliver(b, 'evt_no_active')).status).toBe(200);
  expect(await queue.runNext()).toBe(false); expect(handled).toHaveBeenCalledOnce();
  for (const eventId of ['evt_unknown', 'evt_ordinary', 'evt_unrelated', 'evt_expired', 'evt_restore', 'evt_no_active'])
    await expect(inbox.replay(a, eventId)).rejects.toMatchObject({ code: 'not_found' });
  expect(tenant).not.toHaveBeenCalled(); expect(transport.request).not.toHaveBeenCalled();
});
