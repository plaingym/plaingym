// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { TestClock } from '../../core/clock.js';
import { authConfig } from '../../infra/auth/config.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { stripeProvisioner } from '../../infra/payments/setup.js';
import { createChargeRunner } from '../billing/runner/index.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createStripeStep } from '../setup/stripe-step.js';
import { createGoLiveService } from './go-live.js';
import { createIntegrationsService } from './integrations.js';
import { createGymSettingsAccessor } from './settings.js';

const database = useTestDatabase(), factory = createFactories(database), scope = database.forGym;
const clock = new TestClock('2026-11-02T12:00:00Z'), snapshotAt = new Date('2026-11-01T12:00:00Z');
const key = Buffer.alloc(32, 9), origin = 'https://gym.invalid';
const env = { AUTH_SECRET: 'restore-stripe-settings-secret-32-characters', TENANCY: 'single' };

async function fixture(restored = true) {
  const gymId = uuidv7(); await factory('gyms', gymId, { billingEnabled: !restored });
  const userId = (await factory('authUser', gymId)).id, context = { gymId, actor: { kind: 'user', userId } } as const;
  await scope(gymId, tx => tx.update(gyms).set({ settings: { setup: { ownerId: userId, completed: false, completedSteps: [5] } } }));
  const provider = new FakePayments(gymId, clock), transport = new StripeFixtures(gymId);
  let connected = false;
  const settings = createGymSettingsAccessor({ scope, clock });
  const runner = createChargeRunner({ scope, clock, settings, jobs: new FakeJobs(clock),
    transitions: createInvoiceTransitions({ scope, clock }), payments: async () => {
      if (!connected) throw new AppError('unavailable', 'Stripe is not configured');
      return provider;
    } });
  const service = createGoLiveService({ scope, clock, smtpConfigured: async () => false, paymentsConfigured: async () => connected,
    restoreCheck: (id, at, restoreId) => runner.postRestore(id, at, restoreId) });
  let restoreId: string | undefined;
  if (restored) {
    restoreId = (await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'restore.completed',
      targetType: 'gym', targetId: gymId, occurredAt: clock.now() }))).id;
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.runner.restore_requested',
      targetType: 'restore', targetId: restoreId!, after: { snapshotAt: snapshotAt.toISOString() }, occurredAt: clock.now() }));
    await runner.postRestore(gymId, snapshotAt, restoreId);
    await service.update(context, { revision: (await service.checklist(gymId)).revision, billingEnabled: true });
  }
  const read = () => scope(gymId, async tx => ({ gym: (await tx.select().from(gyms))[0]!, audits: await tx.select().from(auditEvents) }));
  async function save(path: 'settings' | 'setup', saveScope = scope) {
    const revision = (await read()).gym.revision;
    const options = { key, clock, scope: saveScope, provisioner: () => stripeProvisioner(transport) };
    if (path === 'setup') return createStripeStep({ ...options, origin }).configure(context,
      { choice: 'configure', revision, restrictedKey: 'rk_test_RESTORED' });
    return createIntegrationsService({ ...options, env, config: authConfig(env, false), origin: async () => origin,
      hasPassword: async () => false, transport: () => transport }).saveStripe(context, { revision, restrictedKey: 'rk_test_RESTORED', clearTestData: false });
  }
  return { gymId, context, provider, service, read, save, restoreId, connect: () => { connected = true; } };
}

describe.each(['settings', 'setup'] as const)('connecting Stripe through %s after a restore', path => {
  it('pauses billing and requires a clear check against Stripe before it can be turned back on', async () => {
    const f = await fixture();
    expect((await f.read()).gym.billingEnabled).toBe(true);
    expect((await f.service.checklist(f.gymId)).restoreReconciliation).toMatchObject({ stripeConfigured: false, unresolved: 0 });
    await f.save(path); f.connect();
    const saved = await f.read();
    expect(saved.gym).toMatchObject({ billingEnabled: false, revision: 3 });
    expect(saved.gym.stripeConfig).not.toBeNull();
    expect(saved.audits.filter(row => row.action === 'settings.go_live.billing_paused_for_stripe')).toMatchObject([
      { actorKind: 'user', actorUserId: f.context.actor.userId, before: { billingEnabled: true },
        after: { billingEnabled: false, restoreId: f.restoreId }, occurredAt: clock.now() },
    ]);
    await expect(f.service.update(f.context, { revision: saved.gym.revision, billingEnabled: true })).rejects.toMatchObject({ code: 'conflict' });
    const list = vi.spyOn(f.provider, 'listChangesSince');
    await f.service.rerunReconciliation(f.context, { revision: saved.gym.revision, restoreId: f.restoreId! });
    expect(list).toHaveBeenCalledWith(new Date(snapshotAt.getTime() - 5 * 60_000), {});
    const clear = await f.service.checklist(f.gymId);
    expect(clear.restoreReconciliation).toMatchObject({ stripeConfigured: true, unresolved: 0 });
    await f.service.update(f.context, { revision: clear.revision, billingEnabled: true });
    expect((await f.read()).gym.billingEnabled).toBe(true);
  });
  it('leaves billing enabled for a gym that has never been restored', async () => {
    const f = await fixture(false); await f.save(path);
    const saved = await f.read();
    expect(saved.gym.billingEnabled).toBe(true);
    expect(saved.gym.stripeConfig).not.toBeNull();
    expect(saved.audits.some(row => row.action === 'settings.go_live.billing_paused_for_stripe')).toBe(false);
  });
  it('rolls back the Stripe settings, billing pause and its audit together if the save fails', async () => {
    const f = await fixture();
    const failing: typeof scope = (gymId, fn) => scope(gymId, async tx => {
      const result = await fn(tx);
      if ((await tx.select().from(gyms).where(eq(gyms.id, gymId)))[0]?.stripeConfig) throw new Error('Save interrupted');
      return result;
    });
    await expect(f.save(path, failing)).rejects.toThrow('Save interrupted');
    const saved = await f.read();
    expect(saved.gym).toMatchObject({ stripeConfig: null, billingEnabled: true, revision: 2 });
    expect(saved.audits.some(row => row.action === 'settings.go_live.billing_paused_for_stripe')).toBe(false);
  });
});

it('refuses to turn billing on when Stripe settings were saved after the request read whether payments are configured', async () => {
  const f = await fixture();
  await f.service.update(f.context, { revision: (await f.read()).gym.revision, billingEnabled: false });
  // Not connected for `paymentsConfigured`: it answers as it did when read before the save committed.
  await f.save('settings');
  const saved = await f.read();
  expect(saved.gym).toMatchObject({ billingEnabled: false });
  expect(saved.gym.stripeConfig).not.toBeNull();
  await expect(f.service.update(f.context, { revision: saved.gym.revision, billingEnabled: true })).rejects.toMatchObject({ code: 'conflict' });
  expect((await f.read()).gym.billingEnabled).toBe(false);
});
