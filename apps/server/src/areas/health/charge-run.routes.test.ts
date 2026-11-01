// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, invoices, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { chargeFailuresResponseSchema, dismissChargeFailuresResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createChargeRunner } from '../billing/runner/index.js';
import { reportChargeFailures } from '../billing/runner/failures.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { authorize } from '../staff/auth.permissions.js';
import { createChargeRunHealthProvider, monitorChargeRunner } from './charge-run.js';
import { createChargeFailureRoutes } from './charge-run.routes.js';

const db = useTestDatabase(), factory = createFactories(db);
const roles = ['owner', 'admin', 'coach', 'front_desk'] as const;
const dismissed = 'billing.runner.charge_failures.dismissed';
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { billingEnabled: true });
  const clock = new TestClock('2026-10-26T12:00:00Z');
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock });
  const options = { scope: db.forGym, clock, settings, jobs: new FakeJobs(clock) };
  const runner = createChargeRunner({ ...options, transitions: createInvoiceTransitions(options), payments: async () => new FakePayments(gymId, clock) });
  const provider = createChargeRunHealthProvider(options), user = await factory('authUser', gymId), home = await factory('households', gymId);
  const tile = () => provider.read({ gymId, roles: ['owner'], clock });
  const invoice = (number: number, status = 'open') => factory('invoices', gymId, { householdId: home.id, status, number });
  const report = (runId: string, ids: readonly string[], cause: 'unexpected' | 'needs_reconciliation' = 'unexpected') =>
    db.forGym(gymId, tx => reportChargeFailures(tx, { gymId, actor: { kind: 'system' } }, clock, runId, '2026-10-26',
      ids.map(invoiceId => ({ invoiceId, cause }))));
  /** A request as one staff role of this gym, through the real routes and permission check. */
  const request = (role: (typeof roles)[number], path: string, body?: unknown, configured: typeof runner | null = runner) => createApp({ clock, authorize, skipSetup: true,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId, userId: user.id, roles: [role] } }); await next(); },
    contributions: { routes: createChargeFailureRoutes(configured ?? undefined) },
  }).request(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const list = async (role: (typeof roles)[number] = 'owner') => chargeFailuresResponseSchema.parse(await (await request(role, '/api/health/charge-failures')).json()).data;
  return { gymId, clock, options, runner, user, tile, invoice, report, request, list };
}

describe('charge failure routes', () => {
  it('lists the open reports to owners and admins only, and refuses the other staff roles', async () => {
    const f = await fixture(), runId = uuidv7();
    await f.report(runId, [(await f.invoice(41)).id], 'needs_reconciliation');
    for (const role of roles) {
      const response = await f.request(role, '/api/health/charge-failures');
      expect(response.status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
      if (response.status === 200) {
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(chargeFailuresResponseSchema.parse(await response.json()).data).toEqual([{ runId, day: '2026-10-26',
          reportedAt: '2026-10-26T12:00:00.000Z', failures: [{ invoiceId: expect.any(String), number: 41, cause: 'needs_reconciliation' }] }]);
      }
    }
  });
  it('lists only what still needs staff, oldest report first', async () => {
    const f = await fixture(), first = uuidv7(), second = uuidv7();
    const [paid, open, other] = [await f.invoice(1), await f.invoice(2), await f.invoice(3)];
    await f.report(first, [paid.id, open.id]);
    f.clock.advance(1000);
    await f.report(second, [other.id]);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'paid' }).where(eq(invoices.id, paid.id)));
    expect((await f.list()).map(report => [report.runId, report.failures.map(failure => failure.number)])).toEqual([[first, [2]], [second, [3]]]);
    expect(await (await f.request('owner', '/api/health/charge-failures')).json()).toHaveProperty('data.0.failures.0.invoiceId', open.id);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, open.id)));
    expect((await f.list()).map(report => report.runId)).toEqual([second]);
  });
  it('allows owners and admins to dismiss and refuses the other staff roles without changing anything', async () => {
    const f = await fixture();
    for (const role of roles) {
      const id = (await f.invoice(10 + roles.indexOf(role))).id, runId = uuidv7();
      await f.report(runId, [id]);
      const response = await f.request(role, '/api/health/charge-failures/dismiss', { runId });
      expect(response.status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
      if (response.status === 200) expect(dismissChargeFailuresResponseSchema.parse(await response.json()).data.dismissed).toEqual([id]);
      else expect((await f.list()).map(report => report.runId)).toContain(runId);
    }
    expect((await f.list()).map(report => report.failures[0]!.number)).toEqual([12, 13]);
    // The refused roles left no audit; the two dismissals name their user.
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, dismissed)));
    expect(audits).toHaveLength(2);
    expect(audits.every(row => row.actorKind === 'user' && row.actorUserId === f.user.id)).toBe(true);
  });
  it('dismisses one report or all of them, leaves the invoices as they were, and returns the tile to healthy', async () => {
    const f = await fixture(), one = uuidv7(), two = uuidv7(), three = uuidv7();
    await monitorChargeRunner(f.runner, f.options).daily(f.gymId);
    expect(await f.tile()).toMatchObject({ status: 'healthy' });
    const [a, b, c] = [await f.invoice(1, 'past_due'), await f.invoice(2), await f.invoice(3)];
    await f.report(one, [a.id, b.id]); await f.report(two, [b.id]); await f.report(three, [c.id]);
    expect(await f.tile()).toMatchObject({ status: 'error' });
    const dismissOne = await f.request('owner', '/api/health/charge-failures/dismiss', { runId: one });
    expect(dismissChargeFailuresResponseSchema.parse(await dismissOne.json()).data.dismissed.sort()).toEqual([a.id, b.id].sort());
    expect((await f.list()).map(report => report.runId)).toEqual([two, three]);
    expect(await f.tile()).toMatchObject({ status: 'error' });
    // Dismissing a dismissed report is harmless and dismisses nothing.
    const again = await f.request('admin', '/api/health/charge-failures/dismiss', { runId: one });
    expect(again.status).toBe(200);
    expect(dismissChargeFailuresResponseSchema.parse(await again.json()).data.dismissed).toEqual([]);
    const all = await f.request('admin', '/api/health/charge-failures/dismiss', {});
    expect(dismissChargeFailuresResponseSchema.parse(await all.json()).data.dismissed.sort()).toEqual([b.id, c.id].sort());
    expect(await f.list()).toEqual([]);
    expect(await f.tile()).toMatchObject({ status: 'healthy', details: { failures: 0 } });
    expect(await db.forGym(f.gymId, tx => tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, a.id)))).toEqual([{ status: 'past_due' }]);
    // One audit per dismissed report (two, three and the earlier one), none for the harmless repeat.
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, and(eq(auditEvents.action, dismissed))))).toBe(3);
  });
  it('answers an unknown run 404 and rejects a malformed body', async () => {
    const f = await fixture(), runId = uuidv7();
    await f.report(runId, [(await f.invoice(5)).id]);
    expect((await f.request('owner', '/api/health/charge-failures/dismiss', { runId: uuidv7() })).status).toBe(404);
    for (const body of [{ runId: 'nope' }, { runId, extra: true }, { runId: null }])
      expect((await f.request('owner', '/api/health/charge-failures/dismiss', body)).status).toBe(400);
    expect((await f.list()).map(report => report.runId)).toEqual([runId]);
  });
  it('shows gym B nothing of gym A and answers its dismissal of gym A\'s run 404', async () => {
    const a = await fixture(), b = await fixture(), runId = uuidv7();
    await a.report(runId, [(await a.invoice(7)).id]);
    await monitorChargeRunner(b.runner, b.options).daily(b.gymId);
    expect(await b.list()).toEqual([]);
    expect(await b.list('admin')).toEqual([]);
    expect((await b.request('owner', '/api/health/charge-failures/dismiss', { runId })).status).toBe(404);
    expect(await b.tile()).toMatchObject({ status: 'healthy' });
    // Dismissing everything as gym B leaves gym A's report alone.
    const all = await b.request('owner', '/api/health/charge-failures/dismiss', {});
    expect(dismissChargeFailuresResponseSchema.parse(await all.json()).data.dismissed).toEqual([]);
    expect((await a.list()).map(report => report.runId)).toEqual([runId]);
    expect(await a.tile()).toMatchObject({ status: 'error' });
  });
  it('answers 503 until the runtime supplies the runner', async () => {
    const f = await fixture();
    const response = await f.request('owner', '/api/health/charge-failures', undefined, null);
    expect(response.status).toBe(503);
  });
});
