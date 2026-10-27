// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, households, invoices, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../core/clock.js';
import { createApp } from '../core/app.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { FakePayments, type CreateCharge } from '../infra/payments/index.js';
import { StripePayments } from '../infra/payments/stripe.js';
import { FakeUploads } from '../infra/storage/index.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { authConfig } from '../infra/auth/config.js';
import { createAccountService } from '../infra/auth/accounts.js';
import { createAuthService } from '../infra/auth/service.js';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';
import { createGymSettingsAccessor } from '../areas/settings/settings.js';
import { createWebhookInbox, webhookDispatchJob } from '../areas/billing/webhooks/inbox.js';
import { effectJob } from '../areas/billing/transitions/effects.js';
import { composeBillingWebhooks } from '../areas/billing/webhooks/handlers/composition.js';
import type { TransitionEffect } from '../areas/billing/transitions/store.js';
import { demoBootCheck } from './config.js';
import { createDemoPayments } from './payments.js';
import { demoWebhookMiddleware } from './webhook.js';
import { createDemoService } from './service.js';
import { createDemoIdentities } from './identities.js';
import { createSeedCommand } from './seed-cli.js';
import { runSeeds } from './seed/index.js';
import type { BillingSeedProvider } from './seed/billing-payments.js';

const db = useTestDatabase(), factory = createFactories(db), secret = 'whsec_SYNTHETIC';
const baseEnv = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test',
  APP_ENCRYPTION_KEY: 'cd'.repeat(32), AUTH_SECRET: 'demo-billing-test-secret-with-more-than-32-characters', AUTH_PASSWORD_LOGIN: 'off' };
async function drain(queue: PostgresJobs) {
  for (let count = 0; count < 200; count++) if (!await queue.runNext()) return;
  throw new Error('Demo test job drain exceeded its bound');
}
function fixture(configured: boolean) {
  const env = { ...baseEnv, ...(configured ? { DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: secret } : {}) };
  const config = demoBootCheck(env), clock = new TestClock('2026-10-26T12:00:00Z'), scope = db.forGym;
  const gateways = new Map<string, BillingSeedProvider>();
  const provider = vi.fn(async (gymId: string) => {
    let gateway = gateways.get(gymId);
    if (gateway) return gateway;
    const declined = new Set<string>();
    class TestPayments extends FakePayments {
      override async createCharge(input: CreateCharge) {
        const charge = await super.createCharge(input);
        this.respondNextConfirmation(declined.has(input.paymentMethodId) ? 'declined' : 'succeeded');
        return charge;
      }
    }
    const payments = new TestPayments(gymId, clock);
    gateway = { gymId, mode: 'test', payments, async seedCard(customerId, _householdId, fails) {
      const id = 'pm_' + uuidv7().replaceAll('-', '');
      payments.recordPaymentMethod({ id, customerId, last4: fails ? '0341' : '4242', expiresMonth: 12, expiresYear: 2030 });
      if (fails) declined.add(id);
      return id;
    } };
    gateways.set(gymId, gateway); return gateway;
  });
  const payments = createDemoPayments({ config, scope, system: db.forSystem, clock, provider });
  const authentication = authConfig(env, true);
  const identities = createDemoIdentities({ config, authConfig: authentication, clock, scope,
    accounts: createAccountService(authentication, () => db.system.db),
    authFactory: options => createAuthService({ ...options, database: () => db.system.db }) });
  const uploads = new Map<string, FakeUploads>(), log = vi.fn();
  const seedOptions = { env, scope, clock, pinSecret: null, log, billingPaymentsFor: payments.forSeed,
    uploadsFor: async (gymId: string) => {
      if (!uploads.has(gymId)) uploads.set(gymId, new FakeUploads(gymId, clock));
      return uploads.get(gymId)!;
    } };
  const seed: typeof runSeeds = (context, steps) => runSeeds(context, steps, seedOptions);
  const service = createDemoService({ config, key: parseEncryptionKey(env.APP_ENCRYPTION_KEY), clock, scope, system: db.forSystem, identities, seed,
    deletion: createGymDeleteService({ clock, scope, system: db.forSystem, removeUploads: async () => {} }) });
  return { service, seed, clock, config, payments, provider, gateways, log };
}

it('creates a sandbox through the composed seeds with paid/past-due invoices, cards and day-3/7 retry jobs', async () => {
  const f = fixture(true), { gymId } = await f.service.create();
  const rows = await db.forGym(gymId, async tx => ({
    invoices: await tx.select().from(invoices), cards: await tx.select().from(paymentMethods),
    homes: await tx.select().from(households), gym: (await tx.select().from(gyms))[0]!,
  }));
  expect(rows.invoices.filter(row => row.status === 'paid').length).toBeGreaterThan(15);
  expect(rows.invoices.filter(row => row.status === 'past_due')).toHaveLength(2);
  expect(rows.cards).toHaveLength(14); expect(rows.cards.every(row => row.isDefault && !row.revokedAt)).toBe(true);
  expect(rows.homes.filter(row => row.stripeCustomerId)).toHaveLength(14);
  expect(rows.gym.stripeConfig).toBeNull(); expect(JSON.stringify(rows.gym)).not.toContain('rk_test_');
  expect(await f.payments.paymentsFor(gymId)).toBe(f.gateways.get(gymId)!.payments);
  const queue = new PostgresJobs({ clock: f.clock, database: db });
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock: f.clock });
  const inbox = createWebhookInbox({ clock: f.clock, scope: db.forGym, system: db.forSystem, jobs: queue, gymSettings: settings, paymentsFor: f.payments.paymentsFor });
  const billing = composeBillingWebhooks({ inbox, jobs: queue, settings, scope: db.forGym, clock: f.clock, paymentsFor: f.payments.paymentsFor,
    prepare: async () => { throw new Error('No delivery while publishing effects'); }, staffRecipients: async () => [] });
  // The production runtime's existing publisher converts durable seed effects into ordinary jobs.
  await billing.effects.publish(gymId);
  const effects = await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.transition.effect.created')));
  const retries = effects.filter(row => (row.after as TransitionEffect).kind === 'retry');
  expect(retries.map(row => (row.after as TransitionEffect).retryDay).sort()).toEqual([3, 3, 7, 7]);
  const retryIds = new Map(retries.map(row => [row.targetId, (row.after as TransitionEffect).retryDay]));
  const ran: number[] = [];
  queue.handle(effectJob, async payload => {
    const day = retryIds.get((payload as { effectId: string }).effectId);
    if (day) ran.push(day);
  });
  await drain(queue); expect(ran).toEqual([]);
  f.clock.set('2026-10-27T08:59:59Z'); expect(await queue.runNext()).toBe(false);
  f.clock.set('2026-10-27T09:00:00Z'); await drain(queue); expect(ran).toEqual([3, 3]);
  f.clock.set('2026-10-31T08:59:59Z'); expect(await queue.runNext()).toBe(false);
  f.clock.set('2026-10-31T09:00:00Z'); await drain(queue); expect(ran).toEqual([3, 3, 7, 7]);
  f.clock.set('2026-10-26T12:00:00Z');
  const stdout = vi.fn(), stderr = vi.fn();
  expect(await createSeedCommand(db.forGym, f.seed).run([gymId], { stdout, stderr })).toBe(0);
  expect(stderr).not.toHaveBeenCalled(); expect(stdout).toHaveBeenCalledWith('Seed complete');
  expect(await db.forGym(gymId, tx => tx.select().from(invoices))).toHaveLength(rows.invoices.length);
});

it('creates a sandbox without a key, logs the billing skip, and leaves billing unconfigured', async () => {
  const f = fixture(false), { gymId } = await f.service.create();
  expect(await f.service.status(gymId)).toHaveProperty('expiresAt');
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/billing seed skipped.*DEMO_STRIPE_TEST_KEY.*not configured/));
  expect(await f.payments.paymentsFor(gymId)).toBeNull();
  expect(await db.forGym(gymId, tx => tx.select().from(invoices))).toEqual([]);
  expect(await db.forGym(gymId, tx => tx.select().from(paymentMethods))).toEqual([]);
});

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
