// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, invoices, paymentAttempts, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { billingRulesSchema, gymSettingsResponseSchema } from '@plaingym/shared/contracts';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../core/app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { authorize } from '../staff/auth.permissions.js';
import { createSettingsService, createGymSettingsAccessor, readBillingRules } from './settings.js';
import { createSettingsRoutes } from './settings.routes.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createTransitionEffects } from '../billing/transitions/effects.js';
import { createTransitionJobs } from '../billing/transitions/transitions.jobs.js';
import { createTransitionNotifications } from '../billing/transitions/notifications.js';
import { createMembershipService } from '../billing/memberships.js';
import { createChargeRunner } from '../billing/runner/index.js';
import type { JobContext } from '../../infra/jobs/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { effect, effectCreated } from '../billing/transitions/store.js';

const database = useTestDatabase(), factory = createFactories(database);
const origin = 'https://settings.example.test';
async function fixture(executeRetries = false) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { timezone: 'America/Vancouver', memberEmailsEnabled: true, billingEnabled: true });
  const userId = (await factory('authUser', gymId)).id;
  const household = await factory('households', gymId, { email: 'payer@example.test', ...(executeRetries ? { stripeCustomerId: 'cus_test' } : {}) });
  const clock = new TestClock('2028-03-10T17:00:00Z'), options = { scope: database.forGym, clock };
  const context = { gymId, actor: { kind: 'system' } } as const;
  const service = createSettingsService(options), settings = createGymSettingsAccessor(options);
  const transitions = createInvoiceTransitions(options), jobs = new FakeJobs(clock), email = new FakeEmail();
  const provider = new FakePayments(gymId, clock);
  if (executeRetries) {
    provider.seedCustomer({ id: 'cus_test', email: household.email! });
    await factory('paymentMethods', gymId, { householdId: household.id, processorId: 'pm_test', isDefault: true });
  }
  const runner = createChargeRunner({ ...options, settings, transitions, jobs, async payments() { return provider; } });
  const retry = vi.fn(async (invoiceId: string, context: JobContext) => { if (executeRetries) await runner.retry(invoiceId, context); });
  const effects = createTransitionEffects({ ...options, jobs, settings, transitions,
    memberships: createMembershipService({ ...options, settings }),
    async payments() { return provider; }, retry,
    notifications: createTransitionNotifications({ ...options, settings,
      async prepare() { return { email, origin }; }, async staffRecipients() { return []; } }),
  });
  for (const job of createTransitionJobs(() => effects)) jobs.handle(job.id, job.handler);
  let number = 0;
  const invoice = () => factory('invoices', gymId, { householdId: household.id, kind: 'cycle', status: executeRetries ? 'open' : 'processing', number: ++number,
    dueOn: addDays('2028-03-10', number - 1), periodStartsOn: '2028-03-10', periodEndsOn: '2028-04-10' });
  async function failure(invoiceId: string, attemptNumber = 1) {
    const attempt = await factory('paymentAttempts', gymId, { invoiceId, attemptNumber, paymentIntentId: 'pi_' + uuidv7() });
    return { invoiceId, attemptId: attempt.id, paymentIntentId: attempt.paymentIntentId!, outcome: 'failed' as const };
  }
  const drain = async () => { await effects.publish(gymId); while (await jobs.runNext()) { await effects.publish(gymId); } };
  const audits = () => database.forGym(gymId, tx => tx.select().from(auditEvents));
  function server(role: StaffRole = 'owner', principalGym = gymId) {
    return createApp({ clock, origin, authorize, contributions: { routes: createSettingsRoutes(service) },
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] } }); await next(); },
    });
  }
  const patch = (body: unknown, role: StaffRole = 'owner', principalGym = gymId) => server(role, principalGym).request(origin + '/api/settings/billing', {
    method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  async function save(retryDays: number[]) {
    const revision = (await service.get(gymId)).revision, response = await patch({ revision, retryDays });
    expect(response.status).toBe(200);
    return gymSettingsResponseSchema.parse(await response.json()).data;
  }
  return { gymId, context, clock, service, settings, transitions, jobs, email, effects, retry, runner, provider, invoice, failure, drain, audits, server, patch, save };
}

describe('billing retry rules through real PostgreSQL and application composition', () => {
  it('registers the endpoint in the production contributions', () => {
    expect(areaContributions.routes?.find(route => route.id === 'PATCH /api/settings/billing')?.definition.permission)
      .toEqual({ kind: 'staff', capability: 'settings.manage' });
  });
  it.each(staffRoles)('allows and denies %s before validating the retry schedule', async role => {
    const f = await fixture(), allowed = role === 'owner' || role === 'admin';
    expect((await f.patch({}, role)).status).toBe(allowed ? 400 : 403);
    const response = await f.patch({ revision: 1, retryDays: [1, 4, 14, 28] }, role);
    expect(response.status).toBe(allowed ? 200 : 403);
    expect((await f.service.get(f.gymId)).retryDays).toEqual(allowed ? [1, 4, 14, 28] : [3, 7]);
  });
  it.each([[7, 3], [3, 3], [0], [-1], [29], [1.5], [1, 2, 3, 4, 5], ['3'], [null]].map(retryDays => ({ retryDays })))('returns a field error for invalid retry days $retryDays', async ({ retryDays }) => {
    const f = await fixture();
    const response = await f.patch({ revision: 1, retryDays });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request', details: { retryDays: ['invalid_retry_days'] } } });
    expect((await f.service.get(f.gymId)).revision).toBe(1);
  });
  it('revises and audits settings, rejects stale saves, and isolates gyms', async () => {
    const a = await fixture(), b = await fixture();
    expect((await a.service.get(a.gymId)).retryDays).toEqual([3, 7]);
    const saved = await a.save([2, 8]);
    expect(saved).toMatchObject({ revision: 2, retryDays: [2, 8], updatedAt: a.clock.now().toISOString() });
    expect((await a.patch({ revision: 1, retryDays: [] })).status).toBe(409);
    const event = (await a.audits()).find(row => row.action === 'settings.billing.updated')!;
    expect(event).toMatchObject({ actorKind: 'user', before: { retryDays: [3, 7] }, after: { retryDays: [2, 8] }, occurredAt: a.clock.now() });
    expect((await a.patch({ revision: 2, retryDays: [] }, 'owner', b.gymId)).status).toBe(403);
    expect((await a.patch({ revision: 2, retryDays: [], gymId: b.gymId })).status).toBe(400);
    await expect(database.forGym(a.gymId, tx => readBillingRules(tx, b.gymId))).rejects.toMatchObject({ code: 'not_found' });
    expect((await b.service.get(b.gymId)).retryDays).toEqual([3, 7]);
    expect((await a.service.get(a.gymId)).retryDays).toEqual([2, 8]);
  });
  it('changes the next first failure while keeping an existing schedule and queued jobs across DST', async () => {
    const f = await fixture(), first = await f.invoice(), failure = await f.failure(first.id);
    await f.transitions.cardFailed(f.context, failure); await f.drain();
    const originalJobs = f.jobs.jobs.filter(job => job.status === 'queued');
    expect(originalJobs.map(job => job.runAt.toISOString()).sort()).toEqual(['2028-03-13T16:00:00.000Z', '2028-03-17T16:00:00.000Z']);
    await f.save([1, 4, 14, 28]);
    f.clock.set('2028-03-13T16:00:00Z'); await f.drain();
    await f.transitions.cardFailed(f.context, await f.failure(first.id, 2)); await f.drain();
    const existing = f.jobs.jobs.filter(job => originalJobs.some(original => original.id === job.id));
    expect(existing.map(job => ({ id: job.id, runAt: job.runAt }))).toEqual(originalJobs.map(job => ({ id: job.id, runAt: job.runAt })));
    expect(f.retry).toHaveBeenCalledTimes(1);
    const second = await f.invoice(), secondFailure = await f.failure(second.id);
    await f.transitions.cardFailed(f.context, secondFailure); await f.drain();
    await f.transitions.cardFailed(f.context, secondFailure); await f.drain();
    const events = await f.audits();
    expect(events.filter(row => row.action === 'billing.invoice.dunning_started').map(row => row.after)).toEqual([
      { attemptId: failure.attemptId, retryDays: [3, 7] }, { attemptId: secondFailure.attemptId, retryDays: [1, 4, 14, 28] },
    ]);
    expect(f.email.messages).toHaveLength(3); // one for each distinct failed attempt, including the retry
    const retryEffects = events.filter(row => row.action === effectCreated && (row.after as { kind: string }).kind === 'retry');
    const chosen = retryEffects.filter(row => (row.after as { invoiceId: string }).invoiceId === second.id);
    expect(chosen.map(row => (row.after as { retryDay: number }).retryDay).sort((a, b) => a - b)).toEqual([1, 4, 14, 28]);
    expect(f.jobs.jobs.filter(job => chosen.some(row => row.targetId === (job.payload as { effectId: string }).effectId))
      .map(job => job.runAt.toISOString()).sort()).toEqual(['2028-03-14T16:00:00.000Z', '2028-03-17T16:00:00.000Z', '2028-03-27T16:00:00.000Z', '2028-04-10T16:00:00.000Z']);
  });
  it('snapshots before publishing, even if settings change before effects are queued', async () => {
    const f = await fixture(), invoice = await f.invoice();
    await f.save([1, 28]);
    await f.transitions.cardFailed(f.context, await f.failure(invoice.id));
    await f.save([]);
    await f.drain();
    // Effects in one transition share a millisecond, so their audit IDs (and queue order) are unordered.
    expect(f.jobs.jobs.filter(job => job.status === 'queued').map(job => job.runAt.toISOString()).sort())
      .toEqual(['2028-03-11T16:00:00.000Z', '2028-04-07T16:00:00.000Z']);
    expect(f.email.messages).toHaveLength(1);
  });
  it('keeps legacy dunning without a schedule snapshot or queued jobs unchanged', async () => {
    const f = await fixture(), invoice = await f.invoice();
    await factory('auditEvents', f.gymId, { action: 'billing.invoice.dunning_started', targetType: 'invoice', targetId: invoice.id, after: { attemptId: uuidv7() } });
    await f.save([1, 2]);
    await f.transitions.cardFailed(f.context, await f.failure(invoice.id)); await f.drain();
    expect(f.jobs.jobs.filter(job => job.status === 'queued')).toEqual([]);
    expect((await f.audits()).filter(row => row.action === 'billing.invoice.dunning_started')).toHaveLength(1);
    expect(f.email.messages).toHaveLength(1);
  });
  it('leaves an invoice past due with one email and no retry when the list is empty', async () => {
    const f = await fixture(), invoice = await f.invoice(); await f.save([]);
    const failure = await f.failure(invoice.id);
    await f.transitions.cardFailed(f.context, failure); await f.transitions.cardFailed(f.context, failure); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    expect(f.jobs.jobs).toHaveLength(1); expect(f.jobs.jobs[0]!.status).toBe('completed');
    expect(await database.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, invoice.id))))
      .toMatchObject([{ status: 'past_due' }]);
    expect((await f.audits()).find(row => row.action === 'billing.invoice.dunning_started')!.after).toMatchObject({ retryDays: [] });
    await f.save([3, 7]);
    await f.transitions.cardFailed(f.context, await f.failure(invoice.id, 2)); await f.drain();
    expect(f.jobs.jobs.filter(job => job.status === 'queued')).toEqual([]);
    expect(f.email.messages).toHaveLength(2);
  });
  it('enforces the default and retry bounds in PostgreSQL as well as the shared schema', async () => {
    const f = await fixture();
    for (const retryDays of [[], [1], [1, 7, 14, 28]]) {
      expect(billingRulesSchema.safeParse({ retryDays }).success).toBe(true); await f.save(retryDays);
    }
    for (const retryDays of [[2, 1], [2, 2], [0], [29], [1, 2, 3, 4, 5]]) {
      await expect(database.forGym(f.gymId, tx => tx.update(gyms).set({ retryDays }).where(eq(gyms.id, f.gymId))))
        .rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });
  it('executes custom day 2/5 retries through the real runner, with no attempts on days 3/7', async () => {
    const f = await fixture(true), invoice = await f.invoice(); await f.save([2, 5]);
    f.provider.respondNextConfirmation('declined');
    expect(await f.runner.charge(f.gymId, invoice.id)).toEqual({ status: 'failed' }); await f.drain();
    await f.save([3, 7]); // The runner must use the invoice snapshot, not the edited gym rule.
    const attempts = () => database.forGym(f.gymId, tx => tx.select().from(paymentAttempts));
    for (const [day, count] of [[2, 2], [3, 2], [5, 3], [7, 3]]) {
      f.clock.set(zonedInstant(addDays('2028-03-10', day!), '09:00', 'America/Vancouver', { gap: 'shift' })!);
      if (day === 2 || day === 5) f.provider.respondNextConfirmation('declined');
      await f.drain();
      expect(await attempts()).toHaveLength(count!);
      // Replayed or unscheduled retries cannot consume a window a second time.
      expect(await f.runner.charge(f.gymId, invoice.id, { mode: 'retry' })).toEqual({ status: 'skipped', reason: 'outside_retry_window' });
    }
    expect((await attempts()).map(row => localDate(row.createdAt, 'America/Vancouver')).sort()).toEqual(['2028-03-10', '2028-03-12', '2028-03-15']);
    expect(f.email.messages).toHaveLength(3);
  });
  it('executes legacy day 3/7 retries without saved days even when the current gym schedule differs', async () => {
    const f = await fixture(true), invoice = await f.invoice(); await f.save([2, 5]);
    await factory('auditEvents', f.gymId, { action: 'billing.invoice.dunning_started', targetType: 'invoice', targetId: invoice.id,
      after: { attemptId: uuidv7() }, occurredAt: f.clock.now() });
    await database.forGym(f.gymId, async tx => {
      for (const retryDay of [3, 7]) await effect(tx, f.context, f.clock, { kind: 'retry', invoiceId: invoice.id, retryDay });
    });
    f.provider.respondNextConfirmation('declined');
    expect(await f.runner.charge(f.gymId, invoice.id)).toEqual({ status: 'failed' }); await f.drain();
    const attempts = () => database.forGym(f.gymId, tx => tx.select().from(paymentAttempts));
    for (const [day, count] of [[2, 1], [3, 2], [5, 2], [7, 3]]) {
      f.clock.set(zonedInstant(addDays('2028-03-10', day!), '09:00', 'America/Vancouver', { gap: 'shift' })!);
      if (day === 3 || day === 7) f.provider.respondNextConfirmation('declined');
      await f.drain(); expect(await attempts()).toHaveLength(count!);
      expect(await f.runner.charge(f.gymId, invoice.id, { mode: 'retry' })).toEqual({ status: 'skipped', reason: 'outside_retry_window' });
    }
    expect((await attempts()).map(row => localDate(row.createdAt, 'America/Vancouver')).sort()).toEqual(['2028-03-10', '2028-03-13', '2028-03-17']);
    expect(f.email.messages).toHaveLength(3);
  });
  it('never creates a retry attempt through the real runner for an explicitly empty saved schedule', async () => {
    const f = await fixture(true), invoice = await f.invoice(); await f.save([]);
    f.provider.respondNextConfirmation('declined');
    expect(await f.runner.charge(f.gymId, invoice.id)).toEqual({ status: 'failed' }); await f.drain();
    await f.save([3, 7]);
    for (const day of [2, 3, 5, 7, 28]) {
      f.clock.set(zonedInstant(addDays('2028-03-10', day), '09:00', 'America/Vancouver', { gap: 'shift' })!);
      await f.drain();
      expect(await f.runner.charge(f.gymId, invoice.id, { mode: 'retry' })).toEqual({ status: 'skipped', reason: 'outside_retry_window' });
    }
    expect(await database.forGym(f.gymId, tx => tx.select().from(paymentAttempts))).toHaveLength(1);
    expect(f.email.messages).toHaveLength(1); expect(f.jobs.jobs.filter(job => job.status === 'queued')).toEqual([]);
    expect(await database.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, invoice.id)))).toMatchObject([{ status: 'past_due' }]);
  });
});
