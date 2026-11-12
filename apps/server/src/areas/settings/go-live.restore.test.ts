// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { allocateInvoiceNumber, auditEvents, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, staffRoles, type StaffRole } from '@plaingym/shared';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createChargeRunner } from '../billing/runner/index.js';
import { createRunnerJobs } from '../billing/runner/runner.jobs.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createGymSettingsAccessor } from './settings.js';
import { createGoLiveService } from './go-live.js';
import { createGoLiveRoutes } from './go-live.routes.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T12:00:00Z');
const snapshotAt = '2026-10-20T12:00:00.000Z';
/** Gyms with Stripe connected. The others resolve as the runtime's resolver does for a gym with no Stripe settings. */
const connected = new Map<string, FakePayments>();
const payments = vi.fn(async (gymId: string) => {
  const provider = connected.get(gymId);
  if (!provider) throw new AppError('unavailable', 'Stripe is not configured for this gym');
  return provider;
});
const scope = database.forGym, settings = createGymSettingsAccessor({ scope, clock });
const runner = createChargeRunner({ scope, clock, settings, jobs: new FakeJobs(clock), payments,
  transitions: createInvoiceTransitions({ scope, clock }) });
const restoreJob = createRunnerJobs(() => runner, settings).find((job) => job.id === 'billing.runner.restore')!;
const service = createGoLiveService({ scope, clock, smtpConfigured: async () => true,
  paymentsConfigured: async (gymId) => connected.has(gymId),
  restoreCheck: (gymId, at, restoreId) => runner.postRestore(gymId, at, restoreId) });

/** A gym restored from a snapshot with billing paused, as a restore leaves it. */
async function restoredGym() {
  const gymId = uuidv7(); await factory('gyms', gymId, { billingEnabled: false });
  const userId = (await factory('authUser', gymId)).id;
  const restore = await scope(gymId, (tx) => writeAudit(tx, { gymId, actorKind: 'system', action: 'restore.completed',
    targetType: 'gym', targetId: gymId, occurredAt: clock.now() }));
  await scope(gymId, (tx) => writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.runner.restore_requested',
    targetType: 'restore', targetId: restore.id, after: { snapshotAt }, occurredAt: clock.now() }));
  const job = () => restoreJob.handler({ snapshotAt, restoreId: restore.id },
    { jobId: uuidv7(), gymId, timezone: 'UTC', attempt: 1, clock });
  return { gymId, userId, restoreId: restore.id, job };
}
/** Stripe references a restored database can hold: a pending charge, an open Checkout and a pending refund. */
async function stripeReferences(gymId: string) {
  const attempt = await factory('paymentAttempts', gymId, { status: 'pending', paymentIntentId: 'pi_restored', createdAt: clock.now() });
  const number = await scope(gymId, (tx) => allocateInvoiceNumber(tx, gymId));
  await factory('invoices', gymId, { status: 'open', number, checkoutSessionId: 'cs_restored' });
  const refund = await factory('refunds', gymId, { status: 'pending', processorId: 're_restored' });
  return { attempt, refund };
}
function server(role: StaffRole, gymId: string, userId: string, principalGym = gymId) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] }, clock, requestId: 'test' }); await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createGoLiveRoutes(service) }).mount(app, authorize, new Set());
  return app;
}
const send = (app: ReturnType<typeof server>, path: string, method: string, body: unknown) => app.request(path, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const enable = async (app: ReturnType<typeof server>, gymId: string) =>
  send(app, '/api/settings/go-live', 'PATCH', { revision: (await service.checklist(gymId)).revision, billingEnabled: true });
const rerun = async (app: ReturnType<typeof server>, gymId: string, restoreId: string) =>
  send(app, '/api/settings/go-live/reconciliation', 'POST', { revision: (await service.checklist(gymId)).revision, restoreId });
const item = async (gymId: string) => (await service.checklist(gymId)).items.find((entry) => entry.id === 'reconciliation_complete')!.status;
const reports = (gymId: string) => scope(gymId, (tx) => tx.select().from(auditEvents)
  .where(eq(auditEvents.action, 'billing.runner.restore_checked')));

describe('restore check without Stripe', () => {
  it('is clear with no payment records, so the job succeeds and billing can be turned on', async () => {
    const { gymId, userId, job } = await restoredGym();
    expect(await item(gymId)).toBe('needs_attention'); // No result yet.
    await expect(job()).resolves.toBeUndefined();
    expect(payments).toHaveBeenCalledWith(gymId);
    expect((await service.checklist(gymId)).restoreReconciliation).toMatchObject({ inspected: 0, unresolved: 0 });
    expect((await reports(gymId))[0]!.after).toMatchObject({ inspected: 0, unresolved: 0, issues: [], stripeConfigured: false });
    expect(await item(gymId)).toBe('not_applicable');
    expect((await enable(server('owner', gymId, userId), gymId)).status).toBe(200);
    expect((await service.checklist(gymId)).billingEnabled).toBe(true);
  });
  it('lists stored Stripe references without failing or retrying the job, and keeps billing off', async () => {
    const { gymId, userId, job } = await restoredGym(), { attempt, refund } = await stripeReferences(gymId);
    await expect(job()).resolves.toBeUndefined();
    const report = (await reports(gymId))[0]!.after as { inspected: number; unresolved: number; issues: unknown[] };
    expect(report.issues).toEqual(expect.arrayContaining([
      { kind: 'charge', id: 'pi_restored', reason: 'stripe_not_configured' },
      { kind: 'checkout', id: 'cs_restored', reason: 'stripe_not_configured' },
      { kind: 'refund', id: 're_restored', reason: 'stripe_not_configured' },
      { kind: 'attempt', id: attempt.id, reason: 'unresolved' },
      { kind: 'refund', id: refund.id, reason: 'unresolved' },
    ]));
    expect(report).toMatchObject({ inspected: 3, unresolved: 5 });
    expect(await item(gymId)).toBe('needs_attention');
    expect((await enable(server('owner', gymId, userId), gymId)).status).toBe(409);
  });
  it('stops counting a check made without Stripe once Stripe is connected, until a check with Stripe is clear', async () => {
    const { gymId, userId, restoreId, job } = await restoredGym(), app = server('owner', gymId, userId);
    await job();
    const provider = new FakePayments(gymId, clock), list = vi.spyOn(provider, 'listChangesSince');
    connected.set(gymId, provider);
    try {
      expect(await item(gymId)).toBe('needs_attention');
      expect((await enable(app, gymId)).status).toBe(409);
      expect((await rerun(app, gymId, restoreId)).status).toBe(200);
      expect(list).toHaveBeenCalledWith(new Date(new Date(snapshotAt).getTime() - 300_000), {});
      expect((await reports(gymId)).map((row) => (row.after as { stripeConfigured: boolean }).stripeConfigured).sort())
        .toEqual([false, true]);
      expect(await item(gymId)).toBe('ready');
      expect((await enable(app, gymId)).status).toBe(200);
    } finally { connected.delete(gymId); }
  });
  it('still fails on a provider error when Stripe is configured, with the provider reason', async () => {
    const { gymId, userId, restoreId, job } = await restoredGym(), app = server('owner', gymId, userId);
    const provider = new FakePayments(gymId, clock);
    vi.spyOn(provider, 'listChangesSince').mockRejectedValue(new Error('Stripe is unreachable'));
    connected.set(gymId, provider);
    try {
      await expect(job()).rejects.toThrow('Stripe is unreachable');
      expect((await reports(gymId))[0]!.after).toMatchObject({ inspected: 0, unresolved: 1,
        issues: [{ kind: 'provider', reason: 'provider_or_transition_error' }] });
      expect(await item(gymId)).toBe('needs_attention');
      const response = await rerun(app, gymId, restoreId);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
      expect((await enable(app, gymId)).status).toBe(409);
    } finally { connected.delete(gymId); }
    // Settings that can't be read are an error too, not a gym without Stripe.
    payments.mockRejectedValueOnce(new Error('Invalid Stripe configuration'));
    await expect(job()).rejects.toThrow('Invalid Stripe configuration');
  });
});

describe('rechecking restored payments without Stripe', () => {
  it('runs the same check from the route and clears the item', async () => {
    const { gymId, userId, restoreId } = await restoredGym(), app = server('owner', gymId, userId);
    const response = await rerun(app, gymId, restoreId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { restoreReconciliation: { restoreId, inspected: 0, unresolved: 0 } } });
    expect(await item(gymId)).toBe('not_applicable');
    expect((await enable(app, gymId)).status).toBe(200);
  });
  it('lists stored Stripe references from the route without an error', async () => {
    const { gymId, userId, restoreId } = await restoredGym(), app = server('admin', gymId, userId);
    await stripeReferences(gymId);
    const response = await rerun(app, gymId, restoreId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { restoreReconciliation: { restoreId, inspected: 3, unresolved: 5 } } });
    expect(await item(gymId)).toBe('needs_attention');
  });
  it.each(staffRoles)('lets only go-live managers recheck (%s)', async (role) => {
    const { gymId, userId, restoreId } = await restoredGym();
    const response = await rerun(server(role, gymId, userId), gymId, restoreId);
    expect(response.status).toBe(role === 'owner' || role === 'admin' ? 200 : 403);
    expect(await reports(gymId)).toHaveLength(role === 'owner' || role === 'admin' ? 1 : 0);
  });
  it("never rechecks another gym's restore", async () => {
    const a = await restoredGym(), b = await restoredGym();
    // Gym B's owner, naming gym A's restore: not found, and neither gym is checked.
    expect((await rerun(server('owner', b.gymId, b.userId), b.gymId, a.restoreId)).status).toBe(404);
    // A principal of gym A on gym B's host is refused outright.
    expect((await rerun(server('owner', b.gymId, a.userId, a.gymId), b.gymId, b.restoreId)).status).toBe(403);
    expect(await reports(a.gymId)).toHaveLength(0);
    expect(await reports(b.gymId)).toHaveLength(0);
  });
});
