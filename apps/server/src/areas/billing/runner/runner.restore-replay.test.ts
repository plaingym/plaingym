// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { auditEvents, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakePayments, type Payments } from '../../../infra/payments/index.js';
import { createRestoreCheckLease } from '../../health/restore.billing-lease.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { createChargeRunner } from './index.js';
import { configureChargeRunner, createRunnerJobs, rerunRestoreReconciliation } from './runner.jobs.js';

// The real runner, lease and settings over PostgreSQL; only the Stripe resolver is chosen per gym.
const db = useTestDatabase(), factory = createFactories(db), lease = createRestoreCheckLease(() => db.appUrl);
const clock = new TestClock('2028-03-01T17:00:00Z'), scope = db.forGym, settings = createGymSettingsAccessor({ scope, clock });
const snapshotAt = '2028-03-01T16:00:00.000Z';
const resolvers = new Map<string, () => Promise<Payments>>();
const jobs = new FakeJobs(clock);
const runner = createChargeRunner({ scope, clock, settings, jobs, transitions: createInvoiceTransitions({ scope, clock }),
  async payments(gymId) {
    const resolve = resolvers.get(gymId);
    if (!resolve) throw new AppError('unavailable', 'Stripe is not configured for this gym');
    return resolve();
  } });
configureChargeRunner(runner);
const restoreJob = createRunnerJobs(() => runner, settings, lease).find(job => job.id === 'billing.runner.restore')!;

/** A restored gym with no Stripe settings stored, and its original restore job payload. */
async function restoredGym(billingEnabled = false) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled });
  const restore = await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'restore.completed',
    targetType: 'gym', targetId: gymId, occurredAt: clock.now() }));
  const payload = { snapshotAt, restoreId: restore.id };
  const run = (attempt: number, jobId = uuidv7()) => restoreJob.handler(payload, { jobId, gymId, timezone: 'UTC', attempt, clock });
  const count = async (action: string) => (await scope(gymId, tx => tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(eq(auditEvents.action, action)))).length;
  const latestReport = async () => (await scope(gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(eq(auditEvents.action, 'billing.runner.restore_checked')).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1)))[0]
    ?.after as { unresolved: number } | undefined;
  return { gymId, restoreId: restore.id, payload, run, latestReport,
    starts: () => count('billing.runner.restore_check_started'), reports: () => count('billing.runner.restore_checked') };
}
/** A resolver that fails the test's expectations if it is ever called. */
function throwingResolver(gymId: string) {
  const resolve = vi.fn(async (): Promise<Payments> => { throw new Error('Stripe credentials cannot be read'); });
  resolvers.set(gymId, resolve);
  return resolve;
}

describe('a retried attempt of the original restore job', () => {
  it('leaves a clear report for the current restore alone, without reading Stripe credentials', async () => {
    const g = await restoredGym();
    // The first attempt wrote a clear report, but the queue reclaimed it before it was acknowledged.
    await expect(g.run(1)).resolves.toBeUndefined();
    expect(await g.latestReport()).toMatchObject({ unresolved: 0 });
    const resolve = throwingResolver(g.gymId);
    await expect(g.run(2)).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(await g.starts()).toBe(1);
    expect(await g.reports()).toBe(1);
  });
  it('checks again when the latest report has issues, and resolves once it is clear', async () => {
    const g = await restoredGym();
    const started = await scope(g.gymId, tx => writeAudit(tx, { gymId: g.gymId, actorKind: 'system',
      action: 'billing.runner.restore_check_started', targetType: 'restore', targetId: g.restoreId,
      after: { snapshotAt }, occurredAt: clock.now() }));
    await scope(g.gymId, tx => writeAudit(tx, { gymId: g.gymId, actorKind: 'system', action: 'billing.runner.restore_checked',
      targetType: 'restore_check', targetId: started.id, occurredAt: clock.now(), after: { snapshotAt, inspected: 0, unresolved: 1,
        issues: [{ kind: 'provider', id: g.gymId, reason: 'provider_or_transition_error' }] } }));
    const provider = new FakePayments(g.gymId, clock);
    provider.keyMode = 'test';
    resolvers.set(g.gymId, async () => provider);
    await expect(g.run(2)).resolves.toBeUndefined();
    expect(await g.starts()).toBe(2);
    expect(await g.reports()).toBe(2);
    expect(await g.latestReport()).toMatchObject({ unresolved: 0, stripeConfigured: true, stripeMode: 'test' });
  });
  it('does nothing once the owner has turned billing on', async () => {
    const g = await restoredGym(true);
    const resolve = throwingResolver(g.gymId);
    await expect(g.run(2)).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(await g.starts()).toBe(0);
    expect(await g.reports()).toBe(0);
  });
  it('queues one follow-up keyed by its own job when the lease is busy', async () => {
    const g = await restoredGym(), jobId = uuidv7();
    const enqueue = vi.spyOn(jobs, 'enqueue');
    try {
      await lease(g.gymId, async () => { await expect(g.run(2, jobId)).resolves.toBeUndefined(); });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith('billing.runner.restore', { ...g.payload, after: jobId },
        { gymId: g.gymId, timezone: 'UTC', runAt: new Date(clock.now().getTime() + 60_000),
          idempotencyKey: 'restore-check:' + g.gymId + ':after:' + jobId });
    } finally { enqueue.mockRestore(); }
    expect(await g.starts()).toBe(0);
  });
});

describe('the first attempt and the owner rerun', () => {
  it('still refuse to run with billing on', async () => {
    const g = await restoredGym(true);
    await expect(g.run(1)).rejects.toThrow('Pause billing before restore reconciliation');
    expect(await g.starts()).toBe(0);
  });
  it('still start a new check after a clear report', async () => {
    const g = await restoredGym();
    await g.run(1);
    expect(await g.latestReport()).toMatchObject({ unresolved: 0 });
    await expect(g.run(1)).resolves.toBeUndefined();
    expect(await g.starts()).toBe(2);
    expect(await g.reports()).toBe(2);
    expect(await rerunRestoreReconciliation(g.gymId, new Date(snapshotAt), g.restoreId))
      .toMatchObject({ readyForOwnerReview: true, issues: [] });
    expect(await g.starts()).toBe(3);
    expect(await g.reports()).toBe(3);
  });
});
