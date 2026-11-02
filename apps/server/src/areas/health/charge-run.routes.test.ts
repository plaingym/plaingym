// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- The test reads the database's lock table to know the second dismissal is waiting; it touches no gym data.
import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, gymAdvisoryLockKey, invoices, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { chargeFailuresResponseSchema, dismissChargeFailuresResponseSchema, maxDismissedChargeRuns } from '@plaingym/shared/contracts';
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
/**
 * How many advisory lock requests of this test database are waiting. The probe is given the connection no dismissal under test is using (a dismissal
 * under test may hold both connections of the gym pool) and counts only this test database's locks.
 */
async function advisoryWaiters(connection: typeof db.system): Promise<number> {
  // eslint-disable-next-line database/system-tables -- The lock-table probe.
  return (await connection.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`))[0]!.n as number;
}
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
    const all = await f.request('admin', '/api/health/charge-failures/dismiss', { runIds: [two, three] });
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
    for (const body of [{ runId: 'nope' }, { runId, extra: true }, { runId: null }, { runIds: ['nope'] }, { runIds: [] }, { runId, runIds: [runId] }])
      expect((await f.request('owner', '/api/health/charge-failures/dismiss', body)).status).toBe(400);
    expect((await f.list()).map(report => report.runId)).toEqual([runId]);
  });
  it('leaves a report written after the list loaded open when staff dismiss the runs they saw', async () => {
    const f = await fixture(), seen = uuidv7(), later = uuidv7();
    const [a, b] = [await f.invoice(1), await f.invoice(2)];
    await f.report(seen, [a.id]);
    const onScreen = (await f.list()).map(report => report.runId);
    f.clock.advance(60_000);
    await f.report(later, [b.id]);
    const response = await f.request('owner', '/api/health/charge-failures/dismiss', { runIds: onScreen });
    expect(dismissChargeFailuresResponseSchema.parse(await response.json()).data.dismissed).toEqual([a.id]);
    expect((await f.list()).map(report => report.runId)).toEqual([later]);
    expect(await f.tile()).toMatchObject({ status: 'error' });
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, dismissed)));
    expect(audits.map(row => row.targetId)).toEqual([seen]);
  });
  it('dismisses several named runs, once each however often they are named', async () => {
    const f = await fixture(), one = uuidv7(), two = uuidv7();
    const [a, b] = [await f.invoice(1), await f.invoice(2)];
    await f.report(one, [a.id]); await f.report(two, [b.id]);
    const response = await f.request('owner', '/api/health/charge-failures/dismiss', { runIds: [one, two, one] });
    expect(dismissChargeFailuresResponseSchema.parse(await response.json()).data.dismissed.sort()).toEqual([a.id, b.id].sort());
    expect(await f.list()).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, dismissed)))).toBe(2);
  });
  it('writes one audit when two dismissals of one report run at once', async () => {
    const f = await fixture(), runId = uuidv7(), id = (await f.invoice(8)).id;
    await f.report(runId, [id]);
    // The first dismissal finishes its work and holds its transaction open until the second is waiting on it.
    let hold = true; const inside = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const scope: typeof db.forGym = (gymId, work) => {
      const mine = hold; hold = false;
      return db.forGym(gymId, async (tx) => {
        const result = await work(tx);
        if (mine) { inside.resolve(); await release.promise; }
        return result;
      });
    };
    const runner = createChargeRunner({ ...f.options, scope, transitions: createInvoiceTransitions(f.options),
      payments: async () => new FakePayments(f.gymId, f.clock) });
    const context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: f.user.id } };
    const first = runner.dismissChargeFailures(context, [runId]);
    await inside.promise;
    const second = runner.dismissChargeFailures(context, [runId]);
    let finished = false; const done = second.then(() => { finished = true; }, () => { finished = true; });
    // Wait on the database's own state, with no timer: the second dismissal is either waiting for the lock or already finished.
    let sawWait = false;
    for (let tries = 0; tries < 5_000 && !sawWait && !finished; tries++) sawWait = await advisoryWaiters(db.system) > 0;
    // A second dismissal that finished, or never showed up as waiting, didn't wait on the first.
    expect(sawWait).toBe(true);
    expect(finished).toBe(false);
    release.resolve(); await done;
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.dismissed)).toEqual([[id], []]);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, dismissed)))).toBe(1);
    expect(await f.list()).toEqual([]);
  });
  it('takes the registered per-gym lock, so a held lock stops that gym\'s dismissal and no other gym\'s', async () => {
    const a = await fixture(), b = await fixture(), runA = uuidv7(), runB = uuidv7();
    const [invoiceA, invoiceB] = [await a.invoice(1), await b.invoice(1)];
    await a.report(runA, [invoiceA.id]); await b.report(runB, [invoiceB.id]);
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    // Hold gym A's lock the way the registry names it, from the system connection (the two gym connections stay free).
    const holder = db.system.db.transaction(async (tx) => {
      // eslint-disable-next-line database/system-tables -- The same lock: the registry's key for gym A, taken directly.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${gymAdvisoryLockKey('chargeFailures', a.gymId)}, 0))`);
      held.resolve(); await release.promise;
    });
    let blocked: ReturnType<typeof a.runner.dismissChargeFailures> | undefined;
    try {
      await held.promise;
      // Gym B finishes while gym A's lock is held.
      const context = (f: typeof a) => ({ gymId: f.gymId, actor: { kind: 'user' as const, userId: f.user.id } });
      expect((await b.runner.dismissChargeFailures(context(b), [runB])).dismissed).toEqual([invoiceB.id]);
      let finished = false;
      blocked = a.runner.dismissChargeFailures(context(a), [runA]);
      void blocked.then(() => { finished = true; }, () => { finished = true; });
      let sawWait = false;
      for (let tries = 0; tries < 5_000 && !sawWait && !finished; tries++) sawWait = await advisoryWaiters(db.app) > 0;
      expect(sawWait).toBe(true);
      expect(finished).toBe(false);
    } finally { release.resolve(); await holder; }
    expect((await blocked!).dismissed).toEqual([invoiceA.id]);
    expect(await a.list()).toEqual([]); expect(await b.list()).toEqual([]);
  });
  it('answers a named report past the 90-day window 404, like an unknown one, and dismisses nothing', async () => {
    const f = await fixture(), old = uuidv7(), recent = uuidv7();
    const [a, b] = [await f.invoice(1), await f.invoice(2)];
    await f.report(old, [a.id]);
    f.clock.advance(91 * 86_400_000);
    await f.report(recent, [b.id]);
    expect((await f.request('owner', '/api/health/charge-failures/dismiss', { runId: old })).status).toBe(404);
    expect((await f.request('owner', '/api/health/charge-failures/dismiss', { runId: uuidv7() })).status).toBe(404);
    // Naming it beside a listed report refuses the whole request.
    expect((await f.request('owner', '/api/health/charge-failures/dismiss', { runIds: [recent, old] })).status).toBe(404);
    expect((await f.list()).map(report => report.runId)).toEqual([recent]);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, dismissed)))).toBe(0);
    // Inside the window it still dismisses.
    expect((await f.request('owner', '/api/health/charge-failures/dismiss', { runId: recent })).status).toBe(200);
  });
  it('reads only the named runs, so another report in the gym can\'t get in the way', async () => {
    const f = await fixture(), named = uuidv7(), other = uuidv7(), id = (await f.invoice(1)).id;
    await f.report(named, [id]);
    // A report the open-list read couldn't parse: dismissing a different run must not read it.
    await db.forGym(f.gymId, tx => writeAudit(tx, { gymId: f.gymId, actorKind: 'system', action: 'billing.runner.charge_failures.reported',
      targetType: 'charge_run', targetId: other, after: { day: '2026-10-26' }, occurredAt: f.clock.now() }));
    await expect(f.list()).rejects.toThrow();
    const response = await f.request('owner', '/api/health/charge-failures/dismiss', { runId: named });
    expect(response.status).toBe(200);
    expect(dismissChargeFailuresResponseSchema.parse(await response.json()).data.dismissed).toEqual([id]);
  });
  it('dismisses as many reports as one request may name', async () => {
    const f = await fixture(), invoice = await f.invoice(1);
    const runIds = Array.from({ length: maxDismissedChargeRuns }, () => uuidv7());
    await db.forGym(f.gymId, async (tx) => { for (const runId of runIds) await reportChargeFailures(tx, { gymId: f.gymId, actor: { kind: 'system' } }, f.clock, runId, '2026-10-26', [{ invoiceId: invoice.id, cause: 'unexpected' }]); });
    const response = await f.request('owner', '/api/health/charge-failures/dismiss', { runIds });
    expect(response.status).toBe(200);
    expect(dismissChargeFailuresResponseSchema.parse(await response.json()).data.dismissed).toEqual([invoice.id]);
    expect(await f.list()).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, dismissed)))).toBe(maxDismissedChargeRuns);
  });
  it('shows gym B nothing of gym A and answers its dismissal of gym A\'s run 404', async () => {
    const a = await fixture(), b = await fixture(), runId = uuidv7();
    await a.report(runId, [(await a.invoice(7)).id]);
    await monitorChargeRunner(b.runner, b.options).daily(b.gymId);
    expect(await b.list()).toEqual([]);
    expect(await b.list('admin')).toEqual([]);
    expect((await b.request('owner', '/api/health/charge-failures/dismiss', { runId })).status).toBe(404);
    expect(await b.tile()).toMatchObject({ status: 'healthy' });
    // Naming gym A's run among its own as gym B refuses the whole request and leaves gym A's report alone.
    const own = uuidv7(); await b.report(own, [(await b.invoice(8)).id]);
    expect((await b.request('owner', '/api/health/charge-failures/dismiss', { runIds: [own, runId] })).status).toBe(404);
    expect((await b.list()).map(report => report.runId)).toEqual([own]);
    expect((await a.list()).map(report => report.runId)).toEqual([runId]);
    expect(await a.tile()).toMatchObject({ status: 'error' });
  });
  it('answers 503 until the runtime supplies the runner', async () => {
    const f = await fixture();
    const response = await f.request('owner', '/api/health/charge-failures', undefined, null);
    expect(response.status).toBe(503);
  });
});
