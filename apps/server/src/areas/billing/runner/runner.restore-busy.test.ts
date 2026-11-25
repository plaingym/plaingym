// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test turns billing on without go-live's gate.
import { auditEvents, gyms, invoices, paymentAttempts, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { TestClock } from '../../../core/clock.js';
import type { GymSettings, GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { FakeJobs, type Jobs } from '../../../infra/jobs/index.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import { stripeProvisioner } from '../../../infra/payments/setup.js';
import { authConfig } from '../../../infra/auth/config.js';
import { createRestoreCheckLease } from '../../health/restore.billing-lease.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createGoLiveService } from '../../settings/go-live.js';
import { createIntegrationsService } from '../../settings/integrations.js';
import { createInvoiceTransitions, type BillingInvoiceTransitions } from '../transitions/index.js';
import { latestTestSwitch, latestTestSwitchId, stripeSwitchSnapshot, stripeTestClearedAction, StripeTestModeSwitched } from '../stripe-writes.js';
import { createChargeRunner, type ChargeRunner } from './index.js';
import { createRunnerJobs } from './runner.jobs.js';
import type { RestoreCheck } from './reconciliation.js';

const db = useTestDatabase(), factory = createFactories(db), lease = createRestoreCheckLease(() => db.appUrl);
const snapshotAt = '2028-03-01T16:00:00.000Z';

/** The restore job over the real lease, with a spied runner. */
function spiedJob() {
  const gymId = uuidv7(), restoreId = uuidv7(), clock = new TestClock('2028-03-01T17:00:00Z');
  const settings = { async get() { return { billingEnabled: false } as GymSettings; } } satisfies GymSettingsAccessor;
  const postRestore = vi.fn(async (): Promise<RestoreCheck> => ({ inspected: 0, readyForOwnerReview: true, issues: [] }));
  const followUpRestore = vi.fn(async (): Promise<RestoreCheck | null> => null);
  const queueRestoreCheck = vi.fn(async () => undefined);
  const runner = { postRestore, followUpRestore, queueRestoreCheck } as unknown as ChargeRunner;
  const job = createRunnerJobs(() => runner, settings, lease).find(entry => entry.id === 'billing.runner.restore')!;
  const context = { jobId: uuidv7(), gymId, timezone: 'UTC', attempt: 1, clock };
  return { gymId, restoreId, clock, job, context, postRestore, followUpRestore, queueRestoreCheck };
}

describe('a queued restore check that finds the lease busy', () => {
  it('queues one follow-up a minute later and succeeds, even when the holder then fails', async () => {
    const r = spiedJob(), payload = { snapshotAt, restoreId: r.restoreId };
    await expect(lease(r.gymId, async () => {
      await expect(r.job.handler(payload, r.context)).resolves.toBeUndefined();
      throw new Error('holder failed');
    })).rejects.toThrow('holder failed');
    expect(r.postRestore).not.toHaveBeenCalled();
    expect(r.followUpRestore).not.toHaveBeenCalled();
    expect(r.queueRestoreCheck).toHaveBeenCalledTimes(1);
    expect(r.queueRestoreCheck).toHaveBeenCalledWith(r.gymId, 'UTC', { snapshotAt, restoreId: r.restoreId, after: r.context.jobId },
      new Date(r.clock.now().getTime() + 60_000));
  });
  it('runs a follow-up as one, and retries it when its check leaves issues with Stripe', async () => {
    const r = spiedJob();
    r.followUpRestore.mockResolvedValueOnce({ inspected: 1, readyForOwnerReview: false,
      issues: [{ kind: 'charge', id: 'pi_test', reason: 'manual_resolution_required' }], stripeConfigured: true, stripeMode: 'test' });
    const followUp = { snapshotAt, restoreId: r.restoreId, after: uuidv7() };
    await expect(r.job.handler(followUp, { ...r.context, jobId: uuidv7() }))
      .rejects.toThrow('Restore reconciliation requires manual resolution');
    expect(r.followUpRestore).toHaveBeenCalledTimes(1);
    expect(r.followUpRestore).toHaveBeenCalledWith(r.gymId, new Date(snapshotAt), r.restoreId);
    // A follow-up with nothing left to check succeeds.
    await expect(r.job.handler(followUp, { ...r.context, jobId: uuidv7() })).resolves.toBeUndefined();
    expect(r.postRestore).not.toHaveBeenCalled();
    expect(r.queueRestoreCheck).not.toHaveBeenCalled();
  });
  it('still runs a first job as a full check and does not swallow StripeTestModeSwitched on it', async () => {
    const r = spiedJob();
    await r.job.handler({ snapshotAt }, r.context);
    expect(r.postRestore).toHaveBeenCalledTimes(1);
    expect(r.postRestore).toHaveBeenCalledWith(r.gymId, new Date(snapshotAt), undefined);
    expect(r.followUpRestore).not.toHaveBeenCalled();
    r.postRestore.mockRejectedValueOnce(new StripeTestModeSwitched());
    await expect(r.job.handler({ snapshotAt }, r.context)).rejects.toBeInstanceOf(StripeTestModeSwitched);
    expect(r.queueRestoreCheck).not.toHaveBeenCalled();
  });
  it('keys the follow-up by the busy job, so its replays queue no second one', async () => {
    const gymId = uuidv7(), enqueue = vi.fn(async () => undefined);
    const runner = createChargeRunner({ scope: db.forGym, clock: new TestClock('2028-03-01T17:00:00Z'),
      settings: { async get() { return { billingEnabled: false } as GymSettings; } },
      transitions: {} as BillingInvoiceTransitions, jobs: { enqueue } as unknown as Pick<Jobs, 'enqueue'>,
      async payments() { throw new Error('No provider in this test'); } });
    const payload = { snapshotAt, restoreId: uuidv7(), after: uuidv7() }, runAt = new Date('2028-03-01T17:01:00Z');
    await runner.queueRestoreCheck(gymId, 'UTC', payload, runAt);
    expect(enqueue).toHaveBeenCalledWith('billing.runner.restore', payload,
      { gymId, timezone: 'UTC', runAt, idempotencyKey: 'restore-check:' + gymId + ':after:' + payload.after });
  });
});

// The real runner, lease and go-live service, so a follow-up and turning billing on meet on the gym row lock.
const clock = new TestClock('2028-03-01T17:00:00Z'), scope = db.forGym, settings = createGymSettingsAccessor({ scope, clock });
const connected = new Map<string, FakePayments>(), resolvers = new Map<string, () => Promise<FakePayments>>();
const payments = async (gymId: string) => {
  const resolve = resolvers.get(gymId);
  if (resolve) return resolve();
  const provider = connected.get(gymId);
  if (!provider) throw new AppError('unavailable', 'Stripe is not configured for this gym');
  return provider;
};
const jobs = new FakeJobs(clock);
const runner = createChargeRunner({ scope, clock, settings, jobs, payments,
  transitions: createInvoiceTransitions({ scope, clock }) });
const restoreJob = createRunnerJobs(() => runner, settings, lease).find(job => job.id === 'billing.runner.restore')!;
const goLive = createGoLiveService({ scope, clock, smtpConfigured: async () => true, restoreCheckLease: lease,
  paymentsConfigured: async gymId => connected.has(gymId), restoreCheck: (gymId, at, restoreId) => runner.postRestore(gymId, at, restoreId) });

/**
 * A restored gym with billing paused; `stripe` connects a test-mode provider whose mode the gym's saved settings record,
 * and `stored` also stores its (opaque) encrypted settings on the gym.
 */
async function restoredGym(stripe = false, stored = false) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled: false, ...(stored ? { stripeConfig: 'opaque-encrypted-configuration' } : {}) });
  const userId = (await factory('authUser', gymId)).id;
  const restore = await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'restore.completed',
    targetType: 'gym', targetId: gymId, occurredAt: clock.now() }));
  await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.runner.restore_requested',
    targetType: 'restore', targetId: restore.id, after: { snapshotAt }, occurredAt: clock.now() }));
  const provider = new FakePayments(gymId, clock);
  provider.keyMode = 'test';
  if (stripe) {
    connected.set(gymId, provider);
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'user', actorUserId: userId, action: 'integrations.stripe_saved',
      targetType: 'gym', targetId: gymId, after: { mode: 'test' }, occurredAt: clock.now() }));
  }
  const context = (options?: { jobId?: string; attempt?: number }) =>
    ({ jobId: options?.jobId ?? uuidv7(), gymId, timezone: 'UTC', attempt: options?.attempt ?? 1, clock });
  const first = () => restoreJob.handler({ snapshotAt, restoreId: restore.id }, context());
  const followUp = (restoreId = restore.id, options?: { jobId?: string; attempt?: number }) =>
    restoreJob.handler({ snapshotAt, restoreId, after: uuidv7() }, context(options));
  const enable = async () => goLive.update({ gymId, actor: { kind: 'user', userId } },
    { revision: (await goLive.checklist(gymId)).revision, billingEnabled: true });
  const count = async (action: string) => (await scope(gymId, tx => tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(eq(auditEvents.action, action)))).length;
  const starts = () => count('billing.runner.restore_check_started');
  return { gymId, userId, restoreId: restore.id, provider, first, followUp, enable, starts,
    reports: () => count('billing.runner.restore_checked') };
}

/** The normal Payments save, with separate test and live fixture accounts behind the restricted keys. */
function paymentsSave(gymId: string, userId: string) {
  class LiveFixtures extends StripeFixtures {
    override async request(input: Parameters<StripeFixtures['request']>[0]) {
      const result = await super.request(input), stored = typeof result.id === 'string' ? this.objects.get(result.id) : undefined;
      if (stored) stored.livemode = true;
      return 'livemode' in result ? { ...result, livemode: true } : result;
    }
  }
  const test = new StripeFixtures(gymId), live = new LiveFixtures(gymId);
  const env = { TENANCY: 'single', AUTH_SECRET: 'restore-settings-secret-with-32-characters' };
  const integrations = createIntegrationsService({ scope, clock, key: Buffer.alloc(32, 7), env, config: authConfig(env, false),
    origin: async () => 'https://gym.invalid', hasPassword: async () => true,
    provisioner: apiKey => stripeProvisioner(apiKey.startsWith('rk_live_') ? live : test, apiKey.startsWith('rk_live_') ? 'live' : 'test') });
  return async (mode: 'test' | 'live', clearTestData = false) => integrations.saveStripe({ gymId, actor: { kind: 'user', userId } },
    { revision: (await goLive.checklist(gymId)).revision, restrictedKey: 'rk_' + mode + '_RESTORED', clearTestData });
}
const snapshots = (gymId: string) => scope(gymId, async tx => ({
  cleared: await latestTestSwitchId(tx, gymId), snapshot: await stripeSwitchSnapshot(tx, gymId) }));

/** Spies every method the fake provider has, so a test can show that no check reached it. */
function spyAll(provider: FakePayments) {
  const methods = provider as unknown as Record<string, (...args: unknown[]) => unknown>;
  const names = Object.getOwnPropertyNames(FakePayments.prototype)
    .filter(name => name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(FakePayments.prototype, name)?.value === 'function');
  return new Map(names.map(name => [name, vi.spyOn(methods, name)]));
}
const billingRows = (gymId: string) => scope(gymId, async tx => ({
  attempts: await tx.select().from(paymentAttempts), invoices: await tx.select().from(invoices) }));

describe('a busy check’s follow-up and a test-to-live switch', () => {
  it('makes no Stripe call with a key resolved across a switch, and checks with the current key on retry', async () => {
    const g = await restoredGym(true, true);
    await factory('paymentAttempts', g.gymId, { status: 'pending', paymentIntentId: 'pi_restored', createdAt: clock.now() });
    const spies = spyAll(g.provider), before = await billingRows(g.gymId);
    expect(spies.has('listChangesSince') && spies.has('findCharge') && spies.has('readPaymentObject')).toBe(true);
    // The resolver reads the stored test settings, then the owner's switch to live commits before it returns.
    resolvers.set(g.gymId, async () => {
      const [gym] = await scope(g.gymId, tx => tx.select({ stripeConfig: gyms.stripeConfig }).from(gyms).where(eq(gyms.id, g.gymId)));
      expect(gym?.stripeConfig).toBe('opaque-encrypted-configuration');
      await scope(g.gymId, tx => tx.insert(auditEvents).values({ gymId: g.gymId, actorKind: 'system', action: stripeTestClearedAction,
        targetType: 'gym', targetId: g.gymId, before: null, after: {}, occurredAt: clock.now() }));
      return g.provider;
    });
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).rejects.toBeInstanceOf(StripeTestModeSwitched);
      for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([0, 0]);
      expect(await billingRows(g.gymId)).toEqual(before);
      // The retry resolves the live key and checks with it.
      const live = new FakePayments(g.gymId, clock);
      live.keyMode = 'live';
      resolvers.set(g.gymId, async () => live);
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toMatchObject({ stripeMode: 'live' });
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
      const [report] = await scope(g.gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
        .where(eq(auditEvents.action, 'billing.runner.restore_checked')));
      expect(report?.after).toMatchObject({ stripeConfigured: true, stripeMode: 'live' });
      for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
    } finally { resolvers.delete(g.gymId); connected.delete(g.gymId); }
  });
  it('queues one follow-up on the last attempt when a switch commits during listChangesSince, and the follow-up checks in the new mode', async () => {
    const g = await restoredGym(true), jobId = uuidv7();
    const list = vi.spyOn(g.provider, 'listChangesSince').mockImplementationOnce(async () => {
      await scope(g.gymId, tx => writeAudit(tx, { gymId: g.gymId, actorKind: 'system', action: stripeTestClearedAction,
        targetType: 'gym', targetId: g.gymId, occurredAt: clock.now() }));
      return { changes: [], nextCursor: null };
    });
    const enqueue = vi.spyOn(jobs, 'enqueue');
    try {
      await expect(g.followUp(g.restoreId, { jobId, attempt: 3 })).resolves.toBeUndefined();
      expect(list).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith('billing.runner.restore',
        { snapshotAt, restoreId: g.restoreId, after: jobId },
        { gymId: g.gymId, timezone: 'UTC', runAt: new Date(clock.now().getTime() + 60_000),
          idempotencyKey: 'restore-check:' + g.gymId + ':after:' + jobId });
      expect([await g.starts(), await g.reports()]).toEqual([1, 0]);
      const queuedPayload = enqueue.mock.calls[0]![1];
      const live = new FakePayments(g.gymId, clock);
      live.keyMode = 'live';
      connected.set(g.gymId, live);
      await expect(restoreJob.handler(queuedPayload, { jobId: uuidv7(), gymId: g.gymId, timezone: 'UTC', attempt: 1, clock }))
        .resolves.toBeUndefined();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect([await g.starts(), await g.reports()]).toEqual([2, 1]);
      const [report] = await scope(g.gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
        .where(eq(auditEvents.action, 'billing.runner.restore_checked')));
      expect(report?.after).toMatchObject({ unresolved: 0, stripeConfigured: true, stripeMode: 'live' });
    } finally { enqueue.mockRestore(); connected.delete(g.gymId); }
  });
});

describe('a busy check’s follow-up and a Payments save that changes the mode', () => {
  it('makes no Stripe call with a test key resolved before a live save that cleared nothing, and checks live on retry', async () => {
    const g = await restoredGym(), save = paymentsSave(g.gymId, g.userId);
    await save('test');
    expect(await snapshots(g.gymId)).toEqual({ cleared: null, snapshot: null });
    const spies = spyAll(g.provider);
    // The resolver returns the test key; the owner's live save, with no references to clear, commits before it does.
    resolvers.set(g.gymId, async () => { await save('live'); return g.provider; });
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).rejects.toBeInstanceOf(StripeTestModeSwitched);
      for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([0, 0]);
      // The save changed the snapshot, while the cleared-data marker still names no clear.
      const [saved] = await scope(g.gymId, tx => tx.select({ id: auditEvents.id }).from(auditEvents)
        .where(eq(auditEvents.action, 'integrations.stripe_saved')).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1));
      expect(await snapshots(g.gymId)).toEqual({ cleared: null, snapshot: saved!.id });
      const live = new FakePayments(g.gymId, clock);
      live.keyMode = 'live';
      resolvers.set(g.gymId, async () => live);
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toMatchObject({ stripeMode: 'live' });
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
      const [report] = await scope(g.gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
        .where(eq(auditEvents.action, 'billing.runner.restore_checked')));
      expect(report?.after).toMatchObject({ stripeConfigured: true, stripeMode: 'live' });
      for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
    } finally { resolvers.delete(g.gymId); }
  });
  it('keeps the snapshot across a same-mode save, and the cleared-data marker on a save that clears', async () => {
    const g = await restoredGym(), save = paymentsSave(g.gymId, g.userId);
    await save('test');
    await save('test');
    expect(await snapshots(g.gymId)).toEqual({ cleared: null, snapshot: null });
    await save('live', true);
    const [clear] = await scope(g.gymId, tx => tx.select({ id: auditEvents.id }).from(auditEvents)
      .where(eq(auditEvents.action, stripeTestClearedAction)));
    expect((await scope(g.gymId, tx => latestTestSwitch(tx, g.gymId)))?.id).toBe(clear!.id);
    const after = await snapshots(g.gymId);
    expect(after.cleared).toBe(clear!.id);
    expect(after.snapshot).not.toBeNull();
  });
});

describe('a busy check’s follow-up and a switch during a read that changes nothing', () => {
  /** A restored gym whose one reference is an open invoice's Checkout session, so the check's first read is that session. */
  async function checkoutGym() {
    const g = await restoredGym(true);
    await factory('invoices', g.gymId, { status: 'open', number: 1, checkoutSessionId: 'cs_restored' });
    const read = vi.spyOn(g.provider, 'readPaymentObject'), list = vi.spyOn(g.provider, 'listChangesSince');
    const find = vi.spyOn(g.provider, 'findCharge');
    const clear = () => scope(g.gymId, tx => tx.insert(auditEvents).values({ gymId: g.gymId, actorKind: 'system',
      action: stripeTestClearedAction, targetType: 'gym', targetId: g.gymId, before: null, after: {}, occurredAt: clock.now() }));
    return { ...g, read, list, find, clear };
  }
  it('stops at a clear committed while the Checkout session read found nothing', async () => {
    const g = await checkoutGym();
    g.read.mockImplementationOnce(async reference => { await g.clear(); return { status: 'unknown' as const, reference }; });
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).rejects.toBeInstanceOf(StripeTestModeSwitched);
      expect(g.read).toHaveBeenCalledTimes(1);
      expect(g.list).not.toHaveBeenCalled();
      expect(g.find).not.toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([1, 0]);
    } finally { connected.delete(g.gymId); }
  });
  it('stops at a clear committed while the Checkout session read failed', async () => {
    const g = await checkoutGym();
    g.read.mockImplementationOnce(async () => { await g.clear(); throw new Error('Stripe is unreachable'); });
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).rejects.toBeInstanceOf(StripeTestModeSwitched);
      expect(g.read).toHaveBeenCalledTimes(1);
      expect(g.list).not.toHaveBeenCalled();
      expect(g.find).not.toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([1, 0]);
    } finally { connected.delete(g.gymId); }
  });
  it('uses the Checkout session already read and queues a follow-up if its mode switched during the read', async () => {
    const g = await checkoutGym(), jobId = uuidv7();
    g.read.mockImplementationOnce(async ref => {
      await g.clear();
      return { status: 'found', value: { kind: 'checkout', object: { id: ref.id, mode: 'payment', savesCard: false,
        status: 'open', paymentStatus: 'unpaid', customerId: 'cus_restored', url: 'https://gym.invalid/checkout',
        metadata: { gymId: g.gymId } } } };
    });
    const enqueue = vi.spyOn(jobs, 'enqueue');
    try {
      await expect(g.followUp(g.restoreId, { jobId })).resolves.toBeUndefined();
      expect(g.read).toHaveBeenCalledTimes(1);
      expect(g.list).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith('billing.runner.restore',
        { snapshotAt, restoreId: g.restoreId, after: jobId },
        { gymId: g.gymId, timezone: 'UTC', runAt: new Date(clock.now().getTime() + 60_000),
          idempotencyKey: 'restore-check:' + g.gymId + ':after:' + jobId });
      expect([await g.starts(), await g.reports()]).toEqual([1, 0]);
    } finally { enqueue.mockRestore(); connected.delete(g.gymId); }
  });
  it('reports the unread session as an issue when no switch commits', async () => {
    const g = await checkoutGym();
    g.read.mockImplementationOnce(async reference => ({ status: 'unknown' as const, reference }));
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toMatchObject({
        readyForOwnerReview: false, issues: expect.arrayContaining([{ kind: 'checkout', id: 'cs_restored', reason: 'manual_resolution_required' }]) });
      expect(g.list).toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
    } finally { connected.delete(g.gymId); }
  });
  it('queues a follow-up without publishing a provider error when the mode switches during a failed change-page read', async () => {
    const g = await restoredGym(true), jobId = uuidv7();
    const list = vi.spyOn(g.provider, 'listChangesSince').mockImplementationOnce(async () => {
      await scope(g.gymId, tx => writeAudit(tx, { gymId: g.gymId, actorKind: 'system', action: stripeTestClearedAction,
        targetType: 'gym', targetId: g.gymId, occurredAt: clock.now() }));
      throw new Error('Stripe is unreachable');
    });
    const enqueue = vi.spyOn(jobs, 'enqueue');
    try {
      await expect(g.followUp(g.restoreId, { jobId })).resolves.toBeUndefined();
      expect(list).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith('billing.runner.restore',
        { snapshotAt, restoreId: g.restoreId, after: jobId },
        { gymId: g.gymId, timezone: 'UTC', runAt: new Date(clock.now().getTime() + 60_000),
          idempotencyKey: 'restore-check:' + g.gymId + ':after:' + jobId });
      expect([await g.starts(), await g.reports()]).toEqual([1, 0]);
    } finally { enqueue.mockRestore(); connected.delete(g.gymId); }
  });
});

describe('a busy check’s follow-up with a live key and a Payments save back to test', () => {
  /** A live gym with no local Stripe references: the live provider, and a test one for the retry in the saved mode. */
  async function liveGym() {
    const g = await restoredGym(), save = paymentsSave(g.gymId, g.userId);
    await save('live');
    const live = new FakePayments(g.gymId, clock);
    live.keyMode = 'live';
    live.seedCustomer({ id: 'cus_live', email: 'payer@example.invalid' });
    const reports = async () => (await scope(g.gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
      .where(eq(auditEvents.action, 'billing.runner.restore_checked')))).map(row => row.after);
    return { ...g, save, live, reports: reports };
  }
  async function retriesInTestMode(g: Awaited<ReturnType<typeof liveGym>>) {
    resolvers.set(g.gymId, async () => g.provider);
    await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toMatchObject({ stripeMode: 'test' });
    expect(await g.starts()).toBe(2);
    expect(await g.reports()).toEqual([expect.objectContaining({ stripeConfigured: true, stripeMode: 'test' })]);
  }
  it('makes no further live call, no cancellation and no report when the save commits during the change listing', async () => {
    const g = await liveGym();
    // A pending intent the restored database doesn't hold: an orphan the listing would otherwise cancel.
    const orphan = await g.live.createCharge({ amount: 10000, currency: 'cad', customerId: 'cus_live', paymentMethodId: 'pm_live',
      invoiceId: uuidv7(), attemptId: uuidv7(), idempotencyKey: 'orphan' });
    const list = g.live.listChangesSince.bind(g.live), spies = spyAll(g.live);
    spies.get('listChangesSince')!.mockImplementationOnce(async (...args: unknown[]) => {
      const page = await list(...args as Parameters<typeof list>);
      await g.save('test');
      return page;
    });
    resolvers.set(g.gymId, async () => g.live);
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).rejects.toBeInstanceOf(StripeTestModeSwitched);
      for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(name === 'listChangesSince' ? 1 : 0);
      expect(await g.live.findCharge({ kind: 'charge', id: orphan.id })).toMatchObject({ status: 'pending' });
      expect([await g.starts(), (await g.reports()).length]).toEqual([1, 0]);
      await retriesInTestMode(g);
      expect(spies.get('listChangesSince')).toHaveBeenCalledTimes(1);
    } finally { resolvers.delete(g.gymId); }
  });
  it('cancels nothing when the save commits while a stale restored intent is read', async () => {
    const g = await liveGym();
    const intent = await g.live.createCharge({ amount: 10000, currency: 'cad', customerId: 'cus_live', paymentMethodId: 'pm_live',
      invoiceId: uuidv7(), attemptId: uuidv7(), idempotencyKey: 'stale' });
    await factory('paymentAttempts', g.gymId, { status: 'pending', paymentIntentId: intent.id,
      createdAt: new Date(clock.now().getTime() - 60 * 60_000) });
    const find = g.live.findCharge.bind(g.live), spies = spyAll(g.live);
    // The read itself returns the pending intent; only the recheck before the cancel can see the mode change. The
    // restored attempt is a local reference, which the Payments form refuses to change modes over, so the save's
    // audit is recorded directly.
    spies.get('findCharge')!.mockImplementationOnce(async (...args: unknown[]) => {
      const outcome = await find(...args as Parameters<typeof find>);
      await scope(g.gymId, tx => writeAudit(tx, { gymId: g.gymId, actorKind: 'user', actorUserId: g.userId,
        action: 'integrations.stripe_saved', targetType: 'gym', targetId: g.gymId,
        before: { mode: 'live', endpointId: null }, after: { mode: 'test', endpointId: null }, occurredAt: clock.now() }));
      return outcome;
    });
    resolvers.set(g.gymId, async () => g.live);
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).rejects.toBeInstanceOf(StripeTestModeSwitched);
      for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(name === 'findCharge' ? 1 : 0);
      expect([await g.starts(), (await g.reports()).length]).toEqual([1, 0]);
    } finally { resolvers.delete(g.gymId); }
  });
  it('still lists and cancels the orphan with the live key when no save commits', async () => {
    const g = await liveGym();
    const orphan = await g.live.createCharge({ amount: 10000, currency: 'cad', customerId: 'cus_live', paymentMethodId: 'pm_live',
      invoiceId: uuidv7(), attemptId: uuidv7(), idempotencyKey: 'orphan' });
    const cancel = vi.spyOn(g.live, 'cancelCharge');
    resolvers.set(g.gymId, async () => g.live);
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toMatchObject({ stripeMode: 'live' });
      expect(cancel).toHaveBeenCalledExactlyOnceWith(orphan.id);
      expect(await g.reports()).toEqual([expect.objectContaining({ stripeConfigured: true, stripeMode: 'live' })]);
    } finally { resolvers.delete(g.gymId); }
  });
});

describe('a busy check’s follow-up and a first Stripe connection', () => {
  it('doesn’t succeed with a no-Stripe report when the first Payments save commits before its locked decision', async () => {
    const g = await restoredGym(), save = paymentsSave(g.gymId, g.userId);
    const resolver = vi.fn(async (): Promise<FakePayments> => {
      // The resolver finds no Stripe settings; the owner's first save commits before it reports that.
      const [gym] = await scope(g.gymId, tx => tx.select({ stripeConfig: gyms.stripeConfig }).from(gyms).where(eq(gyms.id, g.gymId)));
      expect(gym?.stripeConfig ?? '').toBe('');
      await save('test');
      throw new AppError('unavailable', 'Stripe is not configured for this gym');
    });
    const reports = async () => (await scope(g.gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
      .where(eq(auditEvents.action, 'billing.runner.restore_checked')))).map(row => row.after);
    const enqueue = vi.spyOn(jobs, 'enqueue'), jobId = uuidv7();
    resolvers.set(g.gymId, resolver);
    try {
      await expect(g.followUp(g.restoreId, { jobId })).resolves.toBeUndefined();
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith('billing.runner.restore',
        { snapshotAt, restoreId: g.restoreId, after: jobId },
        { gymId: g.gymId, timezone: 'UTC', runAt: new Date(clock.now().getTime() + 60_000),
          idempotencyKey: 'restore-check:' + g.gymId + ':after:' + jobId });
      expect([await g.starts(), await g.reports()]).toEqual([0, 0]);
      expect(await snapshots(g.gymId)).toEqual({ cleared: null, snapshot: null });
      // The queued follow-up inspects the new account.
      resolvers.set(g.gymId, async () => g.provider);
      await expect(restoreJob.handler(enqueue.mock.calls[0]![1],
        { jobId: uuidv7(), gymId: g.gymId, timezone: 'UTC', attempt: 1, clock })).resolves.toBeUndefined();
      expect(await g.starts()).toBe(1);
      expect(await reports()).toEqual([expect.objectContaining({ stripeConfigured: true, stripeMode: 'test' })]);
    } finally { enqueue.mockRestore(); resolvers.delete(g.gymId); }
  });
  it('still checks, without retrying, when a resolver finds no provider for settings already stored at its early read', async () => {
    const g = await restoredGym(false, true);
    resolvers.set(g.gymId, async () => null as unknown as FakePayments);
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toMatchObject({ stripeConfigured: false });
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
    } finally { resolvers.delete(g.gymId); }
  });
});

describe('a busy check’s follow-up with nothing to do', () => {
  /** A resolver that can't read the stored settings, as when they fail to decrypt. */
  const unreadable = (gymId: string) => {
    const resolve = vi.fn(async (): Promise<FakePayments> => { throw new Error('Stripe settings are unreadable'); });
    resolvers.set(gymId, resolve);
    return resolve;
  };
  it('skips a restore that isn’t the latest without reading the Stripe settings', async () => {
    const g = await restoredGym(true, true), resolve = unreadable(g.gymId);
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), uuidv7())).resolves.toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([0, 0]);
    } finally { resolvers.delete(g.gymId); connected.delete(g.gymId); }
  });
  it('skips when billing is on without reading the Stripe settings', async () => {
    const g = await restoredGym(true, true), resolve = unreadable(g.gymId);
    await scope(g.gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, g.gymId)));
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([0, 0]);
    } finally { resolvers.delete(g.gymId); connected.delete(g.gymId); }
  });
  it('skips a latest check already clear for the saved mode without reading the Stripe settings', async () => {
    const g = await restoredGym(true, true);
    try {
      await g.first();
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
      const resolve = unreadable(g.gymId);
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).resolves.toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
    } finally { resolvers.delete(g.gymId); connected.delete(g.gymId); }
  });
  it('still fails, with no start, when a follow-up that needs to run can’t read the Stripe settings', async () => {
    const g = await restoredGym(true, true), resolve = unreadable(g.gymId);
    try {
      await expect(runner.followUpRestore(g.gymId, new Date(snapshotAt), g.restoreId)).rejects.toThrow('Stripe settings are unreadable');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect([await g.starts(), await g.reports()]).toEqual([0, 0]);
    } finally { resolvers.delete(g.gymId); connected.delete(g.gymId); }
  });
});

describe('a busy check’s follow-up and the holder’s result', () => {
  it('keeps a clear result from the holder and checks nothing, so the owner can still turn billing on', async () => {
    const g = await restoredGym(true), list = vi.spyOn(g.provider, 'listChangesSince');
    try {
      await g.first();
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
      await expect(g.followUp()).resolves.toBeUndefined();
      expect([await g.starts(), await g.reports()]).toEqual([1, 1]);
      expect(list).toHaveBeenCalledTimes(1);
      await expect(g.enable()).resolves.toMatchObject({ billingEnabled: true });
    } finally { connected.delete(g.gymId); }
  });
  it('checks again when the holder failed, and clears the gate once that check is clear', async () => {
    const g = await restoredGym(true);
    vi.spyOn(g.provider, 'listChangesSince').mockRejectedValueOnce(new Error('Stripe is unreachable'));
    try {
      await expect(g.first()).rejects.toThrow('Stripe is unreachable');
      await expect(g.enable()).rejects.toBeInstanceOf(AppError);
      await expect(g.followUp()).resolves.toBeUndefined();
      expect([await g.starts(), await g.reports()]).toEqual([2, 2]);
      await expect(g.enable()).resolves.toMatchObject({ billingEnabled: true });
    } finally { connected.delete(g.gymId); }
  });
  it('checks again when the holder left issues', async () => {
    const g = await restoredGym();
    await factory('paymentAttempts', g.gymId, { status: 'pending', paymentIntentId: 'pi_restored', createdAt: clock.now() });
    await g.first();
    await expect(g.followUp()).resolves.toBeUndefined();
    expect([await g.starts(), await g.reports()]).toEqual([2, 2]);
  });
  it('does nothing for a restore that isn’t the latest', async () => {
    const g = await restoredGym();
    await expect(g.followUp(uuidv7())).resolves.toBeUndefined();
    expect(await g.starts()).toBe(0);
  });
});

describe('a busy check’s follow-up and turning billing on', () => {
  it('ends without a check or an error when billing was turned on first', async () => {
    const g = await restoredGym();
    // A holder that ended without a report, then billing turned on outside go-live's gate.
    await scope(g.gymId, tx => writeAudit(tx, { gymId: g.gymId, actorKind: 'system', action: 'billing.runner.restore_check_started',
      targetType: 'restore', targetId: g.restoreId, after: { snapshotAt }, occurredAt: clock.now() }));
    await scope(g.gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, g.gymId)));
    await expect(g.followUp()).resolves.toBeUndefined();
    expect([await g.starts(), await g.reports()]).toEqual([1, 0]);
  });
  it('keeps billing off while a follow-up that started first runs, and lets it on after its clear report', async () => {
    const g = await restoredGym(true);
    // A holder that ended without a report.
    await scope(g.gymId, tx => writeAudit(tx, { gymId: g.gymId, actorKind: 'system', action: 'billing.runner.restore_check_started',
      targetType: 'restore', targetId: g.restoreId, after: { snapshotAt }, occurredAt: clock.now() }));
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(g.provider, 'listChangesSince').mockImplementationOnce(async () => {
      entered(); await hold; return { changes: [], nextCursor: null };
    });
    try {
      const running = g.followUp();
      await began;
      expect(await g.starts()).toBe(2);
      await expect(g.enable()).rejects.toBeInstanceOf(AppError);
      expect((await settings.get(g.gymId)).billingEnabled).toBe(false);
      release();
      await expect(running).resolves.toBeUndefined();
      await expect(g.enable()).resolves.toMatchObject({ billingEnabled: true });
    } finally { release(); connected.delete(g.gymId); }
  });
});
