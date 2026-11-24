// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, paymentMethods, uuidv7, type forGym } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { createServerRegistry } from '../../core/registry.js';
import { authConfig } from '../../infra/auth/config.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments, type DetachOptions } from '../../infra/payments/index.js';
import { stripeProvisioner } from '../../infra/payments/setup.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { createIntegrationsService } from '../settings/integrations.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createPaymentService } from './payments.js';
import { createPaymentJobs } from './payments.jobs.js';
import { cardDetachedAction, cardRevokedAction, detachJob } from './payments.mutations.js';
import { revokeBankMethod } from './transitions/bank.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
  const user = await factory('authUser', gymId), home = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
  const card = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_4242', isDefault: true });
  const other = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_other', isDefault: false });
  const provider = new FakePayments(gymId, clock), jobs = new FakeJobs(clock), settings = createGymSettingsAccessor({ scope: db.forGym });
  const detachCard = vi.fn(async (_gym: string, _id: string, _options?: DetachOptions) => { assertNoTransaction('detachCard'); });
  const service = createPaymentService({ scope: db.forGym, clock, settings, jobs, detachCard, paymentsFor: async () => provider });
  createServerRegistry({ jobs: createPaymentJobs({ scope: db.forGym, detachCard, notifications: {} as never }) }).registerJobs(jobs, new Set());
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const detached = (gym = gymId) => db.forGym(gym, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, cardDetachedAction)));
  const list = async (household = home.id, gym = gymId) => (await service.listPaymentMethods(gym, household, {})).data;
  return { gymId, clock, home, card, other, jobs, detachCard, service, context, detached, list };
}

describe('a finished card removal', () => {
  it('is returned and listed as finished, with one audit and no state on active cards', async () => {
    const f = await fixture();
    expect((await f.service.revokeCard(f.context, f.home.id, f.card.id)).removal).toBe('finished');
    const rows = await f.list();
    expect(rows.find(r => r.id === f.card.id)).toMatchObject({ removal: 'finished' });
    const active = rows.filter(r => r.revokedAt === null);
    expect(active.length).toBeGreaterThan(0);
    for (const row of active) expect('removal' in row).toBe(false);
    const audits = await f.detached();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ targetType: 'payment_method', targetId: f.card.id, after: { householdId: f.home.id } });
  });

  it('stays pending after a Stripe outage until the queued detach job finishes it', async () => {
    const f = await fixture();
    f.detachCard.mockRejectedValueOnce(Object.assign(new Error('Stripe unavailable'), { statusCode: 503 }));
    await expect(f.service.revokeCard(f.context, f.home.id, f.card.id)).rejects.toThrow('Stripe unavailable');
    expect((await f.list()).find(r => r.id === f.card.id)).toMatchObject({ revokedAt: expect.any(String), removal: 'pending' });
    expect(await f.detached()).toHaveLength(0);
    await f.jobs.runNext();
    expect((await f.list()).find(r => r.id === f.card.id)).toMatchObject({ removal: 'finished' });
    expect(await f.detached()).toHaveLength(1);
  });

  it('still fails the request when the gym cannot reach Stripe at all, and leaves the card pending', async () => {
    const f = await fixture();
    f.detachCard.mockRejectedValueOnce(new AppError('unavailable', 'Stripe is not configured for this gym'));
    await expect(f.service.revokeCard(f.context, f.home.id, f.card.id)).rejects.toThrow('Stripe is not configured for this gym');
    expect((await f.list()).find(r => r.id === f.card.id)).toMatchObject({ revokedAt: expect.any(String), removal: 'pending' });
    expect(await f.detached()).toHaveLength(0);
  });

  it('is recorded once however often the removal or its job is repeated', async () => {
    const f = await fixture();
    await f.service.revokeCard(f.context, f.home.id, f.card.id);
    await f.service.revokeCard(f.context, f.home.id, f.card.id);
    for (let i = 0; i < 5 && await f.jobs.runNext(); i++) { /* bounded drain */ }
    await f.jobs.enqueue(detachJob, { paymentMethodId: f.card.id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: 'detach:again' });
    await f.jobs.runNext();
    expect(await f.detached()).toHaveLength(1);
    const revoked = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(
      eq(auditEvents.action, cardRevokedAction), eq(auditEvents.targetId, f.card.id))));
    expect(revoked).toHaveLength(1);
  });

  it('returns pending when recording the detach audit fails once, and the queued job finishes it with one audit', async () => {
    const f = await fixture();
    let failNextScope = false;
    const scope: typeof forGym = (gym, fn) => {
      if (failNextScope) { failNextScope = false; return Promise.reject(new Error('audit write failed')); }
      return db.forGym(gym, fn);
    };
    const detachCard = vi.fn(async (_gym: string, _id: string, _options?: DetachOptions) => {
      assertNoTransaction('detachCard');
      failNextScope = true;
    });
    const service = createPaymentService({ scope, clock: f.clock, settings: createGymSettingsAccessor({ scope: db.forGym }),
      jobs: f.jobs, detachCard });
    const logs: { event?: string; gymId?: string; paymentMethodId?: string }[] = [];
    const previous = setLogSink(entry => { logs.push(JSON.parse(entry)); });
    let result;
    try { result = await service.revokeCard(f.context, f.home.id, f.card.id); }
    finally { setLogSink(previous); }
    expect(result).toMatchObject({ id: f.card.id, revokedAt: f.clock.now().toISOString(), removal: 'pending' });
    expect(logs).toEqual([expect.objectContaining({ event: 'billing.card.detach_record_failed', gymId: f.gymId, paymentMethodId: f.card.id })]);
    expect(JSON.stringify(logs)).not.toContain('audit write failed');
    expect(await f.detached()).toHaveLength(0);
    expect((await f.list()).find(r => r.id === f.card.id)).toMatchObject({ removal: 'pending' });
    await f.jobs.runNext();
    expect((await f.list()).find(r => r.id === f.card.id)).toMatchObject({ removal: 'finished' });
    expect(await f.detached()).toHaveLength(1);
  });

  it('defers an ownership refusal on an untagged customer to the queued job, which adopts and finishes it', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
    await factory('gyms', gymId, { currency: 'CAD', billingEnabled: true });
    const user = await factory('authUser', gymId);
    const home = await factory('households', gymId, { stripeCustomerId: 'cus_csv' });
    const card = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_csv_pad', type: 'acss_debit', isDefault: true });
    const stripe = new StripeFixtures(gymId);
    stripe.objects.clear();
    stripe.objects.set('cus_csv', { id: 'cus_csv', object: 'customer', email: 'payer@example.invalid', metadata: {} });
    stripe.objects.set('pm_csv_pad', { id: 'pm_csv_pad', object: 'payment_method', created: stripe.now, type: 'acss_debit',
      customer: 'cus_csv', metadata: {}, acss_debit: { bank_name: 'STRIPE TEST BANK', last4: '6789' } });
    const provider = new StripePayments(gymId, { transport: stripe, webhookSecret: 'whsec_SYNTHETIC' });
    const detachCard = vi.fn(async (_gym: string, id: string, options?: DetachOptions) => {
      assertNoTransaction('detachCard');
      await provider.detachPaymentMethod(id, options);
    });
    const adoptCustomer = vi.fn(async (_gym: string, id: string) => {
      assertNoTransaction('adoptCustomer');
      return provider.adoptCustomer(id);
    });
    const jobs = new FakeJobs(clock), settings = createGymSettingsAccessor({ scope: db.forGym });
    const service = createPaymentService({ scope: db.forGym, clock, settings, jobs, detachCard, paymentsFor: async () => provider });
    createServerRegistry({ jobs: createPaymentJobs({ scope: db.forGym, detachCard, adoptCustomer, notifications: {} as never }) })
      .registerJobs(jobs, new Set());
    const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
    const logs: { event?: string; gymId?: string; paymentMethodId?: string }[] = [];
    const previous = setLogSink(entry => { logs.push(JSON.parse(entry)); });
    let result;
    try { result = await service.revokeCard(context, home.id, card.id); }
    finally { setLogSink(previous); }
    expect(result).toMatchObject({ id: card.id, revokedAt: clock.now().toISOString(), removal: 'pending' });
    expect(logs).toEqual([expect.objectContaining({ event: 'billing.card.detach_deferred', gymId, paymentMethodId: card.id })]);
    expect((await service.listPaymentMethods(gymId, home.id, {})).data.find(r => r.id === card.id)).toMatchObject({ removal: 'pending' });
    expect(stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');

    await jobs.runNext();
    expect(adoptCustomer).toHaveBeenCalledOnce();
    expect(stripe.objects.get('cus_csv')!.metadata).toEqual({ gym_id: gymId });
    expect(stripe.objects.get('pm_csv_pad')!.customer).toBeNull();
    expect((await service.listPaymentMethods(gymId, home.id, {})).data.find(r => r.id === card.id)).toMatchObject({ removal: 'finished' });
    expect(await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, cardDetachedAction)))).toHaveLength(1);
  });

  it('skips Stripe in the queued staff detach job once recorded, while an erasure job still redacts billing details', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
    await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
    const user = await factory('authUser', gymId);
    const home = await factory('households', gymId, { stripeCustomerId: 'cus_owned' });
    const card = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_owned', isDefault: true });
    const stripe = new StripeFixtures(gymId);
    stripe.objects.clear();
    stripe.objects.set('cus_owned', { id: 'cus_owned', object: 'customer', email: 'payer@example.invalid', metadata: { gym_id: gymId } });
    stripe.objects.set('pm_owned', { id: 'pm_owned', object: 'payment_method', created: stripe.now, type: 'card',
      customer: 'cus_owned', metadata: { gym_id: gymId }, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2035 } });
    const provider = new StripePayments(gymId, { transport: stripe, webhookSecret: 'whsec_SYNTHETIC' });
    const detachCard = vi.fn(async (_gym: string, id: string, options?: DetachOptions) => {
      assertNoTransaction('detachCard');
      await provider.detachPaymentMethod(id, options);
    });
    const jobs = new FakeJobs(clock), settings = createGymSettingsAccessor({ scope: db.forGym });
    const service = createPaymentService({ scope: db.forGym, clock, settings, jobs, detachCard, paymentsFor: async () => provider });
    createServerRegistry({ jobs: createPaymentJobs({ scope: db.forGym, detachCard, notifications: {} as never }) }).registerJobs(jobs, new Set());
    const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };

    expect((await service.revokeCard(context, home.id, card.id)).removal).toBe('finished');
    const callsAfterRevoke = detachCard.mock.calls.length, requestsAfterRevoke = stripe.requests.length;
    expect(callsAfterRevoke).toBe(1);

    await jobs.runNext();
    expect(detachCard).toHaveBeenCalledTimes(callsAfterRevoke);
    expect(stripe.requests).toHaveLength(requestsAfterRevoke);
    expect(await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, cardDetachedAction)))).toHaveLength(1);

    await jobs.enqueue(detachJob, { paymentMethodId: card.id, redactBillingDetails: true },
      { gymId, timezone: 'UTC', idempotencyKey: 'detach:erased:' + card.id });
    await jobs.runNext();
    expect(detachCard).toHaveBeenCalledTimes(callsAfterRevoke + 1);
    expect(detachCard).toHaveBeenLastCalledWith(gymId, 'pm_owned', { redactBillingDetails: true });
    expect(await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, cardDetachedAction)))).toHaveLength(1);
    const revoked = await db.forGym(gymId, tx => tx.select().from(auditEvents).where(and(
      eq(auditEvents.action, cardRevokedAction), eq(auditEvents.targetId, card.id))));
    expect(revoked).toHaveLength(1);
  });

  it('omits removal state for bank failures and cleared test cards, and lists pending only with a revoked audit', async () => {
    const f = await fixture();
    const bank = await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_bank_fail',
      type: 'us_bank_account', bankName: 'Test Bank', brand: null, last4: '6789', expiryMonth: null, expiryYear: null, isDefault: false });
    const invoice = await factory('invoices', f.gymId, { householdId: f.home.id, number: 1, status: 'past_due', amountCents: 5000, currency: 'USD' });
    await db.forGym(f.gymId, tx => revokeBankMethod(tx, f.context, f.clock, invoice, bank.processorId));

    const queuedOnly = await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_queued_only',
      isDefault: false, revokedAt: f.clock.now() });
    await factory('auditEvents', f.gymId, { action: cardRevokedAction, targetType: 'payment_method', targetId: queuedOnly.id });

    const testGymId = uuidv7();
    await factory('gyms', testGymId, { currency: 'USD', billingEnabled: true });
    const owner = await factory('authUser', testGymId);
    class LiveFixtures extends StripeFixtures {
      override async request(input: Parameters<StripeFixtures['request']>[0]) {
        const result = await super.request(input), stored = typeof result.id === 'string' ? this.objects.get(result.id) : undefined;
        if (stored) stored.livemode = true;
        return 'livemode' in result ? { ...result, livemode: true } : result;
      }
    }
    const accounts = new Map<string, StripeFixtures>();
    const account = (apiKey: string) => {
      if (!accounts.has(apiKey)) accounts.set(apiKey, new (apiKey.startsWith('rk_live_') ? LiveFixtures : StripeFixtures)('provisioning', undefined, (accounts.size + 1) * 1000));
      return accounts.get(apiKey)!;
    };
    const env = { AUTH_SECRET: 'removal-state-test-secret-32-chars', TENANCY: 'single', AUTH_PASSWORD_LOGIN: 'auto' };
    const integrations = createIntegrationsService({
      key: Buffer.alloc(32, 9), env, config: authConfig(env, false), origin: async () => 'https://gym.invalid',
      hasPassword: async () => false, clock: f.clock, requestSnapshot: async () => undefined, checkDestination: async () => undefined,
      scope: db.forGym, sendTest: async () => undefined,
      provisioner: apiKey => stripeProvisioner(account(apiKey), apiKey.startsWith('rk_live_') ? 'live' : 'test'),
      transport: apiKey => account(apiKey),
    });
    const testContext = { gymId: testGymId, actor: { kind: 'user' as const, userId: owner.id } };
    const first = await integrations.saveStripe(testContext, { revision: 1, restrictedKey: 'rk_test_clear', clearTestData: false });
    const testHome = await factory('households', testGymId, { stripeCustomerId: 'cus_test_mode' });
    const testCard = await factory('paymentMethods', testGymId, { householdId: testHome.id, processorId: 'pm_test_clear', isDefault: true });
    await integrations.saveStripe(testContext, { revision: first.revision, restrictedKey: 'rk_live_clear', clearTestData: true });

    const rows = await f.list();
    const bankRow = rows.find(r => r.id === bank.id)!;
    expect(bankRow.revokedAt).not.toBeNull();
    expect('removal' in bankRow).toBe(false);
    expect(rows.find(r => r.id === queuedOnly.id)).toMatchObject({ revokedAt: f.clock.now().toISOString(), removal: 'pending' });
    expect(f.jobs.jobs).toHaveLength(0);

    const testRows = await f.list(testHome.id, testGymId);
    const clearedRow = testRows.find(r => r.id === testCard.id)!;
    expect(clearedRow.revokedAt).toBe(f.clock.now().toISOString());
    expect('removal' in clearedRow).toBe(false);
    expect(await db.forGym(testGymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, testCard.id))))
      .toMatchObject([{ id: testCard.id, isDefault: false, revokedAt: f.clock.now() }]);
  });

  it('is not recorded by a detach job for a card that is still active', async () => {
    const f = await fixture();
    await f.jobs.enqueue(detachJob, { paymentMethodId: f.other.id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: 'detach:' + f.other.id });
    await f.jobs.runNext();
    expect(f.detachCard).not.toHaveBeenCalled();
    expect(await f.detached()).toHaveLength(0);
  });

  it('is not visible to another household or gym', async () => {
    const f = await fixture();
    await f.service.revokeCard(f.context, f.home.id, f.card.id);
    const sibling = await factory('households', f.gymId);
    expect(await f.list(sibling.id)).toEqual([]);
    const gymB = uuidv7(); await factory('gyms', gymB, { currency: 'USD', billingEnabled: true });
    await expect(f.list(f.home.id, gymB)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.detached(gymB)).toHaveLength(0);
  });
});
