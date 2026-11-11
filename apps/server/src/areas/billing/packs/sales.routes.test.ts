// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
// eslint-disable-next-line database/system-tables -- Real lock probes make the concurrent move/erasure test deterministic.
import { eq, sql } from 'drizzle-orm';
import { auditEvents, classCreditEntries, classPackSales, classPacks, households, invoiceLineItems, invoices, members, payments, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { billingContracts } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../../core/context.js';
import { createServerRegistry } from '../../../core/registry.js';
import { errorHandler } from '../../../core/errors.js';
import { TestClock } from '../../../core/clock.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { effectCreated } from '../transitions/store.js';
import { createPackSalesService } from './sales.js';
import { configurePackSales, createPackSalesRoutes } from './sales.routes.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-10T12:00:00Z');
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'USD' });
  const user = await factory('authUser', gymId), member = await factory('members', gymId);
  const pack = await factory('classPacks', gymId, { credits: 10, expiryDays: 30 });
  const tax = await factory('taxRates', gymId, { rateMillionths: 50000, inclusive: false });
  await factory('classPackTaxRates', gymId, { packId: pack.id, taxRateId: tax.id });
  const service = createPackSalesService({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) });
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  return { gymId, user, member, pack, tax, service, context };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function server(f: Fixture, principal: Principal, routes = createPackSalesRoutes(f.service)) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'pack-sale-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes }).mount(app, authorize, new Set());
  return app;
}
const staff = (f: Fixture, role: 'owner' | 'admin' | 'front_desk' | 'coach'): Principal =>
  ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
const input = (f: Fixture) => ({ memberId: f.member.id, dueOn: '2026-11-10' });
const request = (app: ReturnType<typeof server>, f: Fixture, body: unknown = input(f)) =>
  app.request('/api/billing/packs/' + f.pack.id + '/sell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('pack sale route and transaction', () => {
  for (const role of ['owner', 'admin', 'front_desk', 'coach'] as const) it('enforces ' + role, async () => {
    const f = await fixture(), response = await request(server(f, staff(f, role)), f);
    expect(response.status, await response.clone().text()).toBe(role === 'coach' ? 403 : 201);
    if (role !== 'coach') {
      const result = billingContracts.sellClassPack.response.parse(await response.json());
      expect(result.data).toMatchObject({ householdId: f.member.householdId, kind: 'one_off', status: 'open', number: 1, amountCents: 10500 });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('refuses anonymous, household and device identities before validation', async () => {
    const f = await fixture();
    for (const [principal, status] of [
      [{ kind: 'anonymous' }, 401], [{ kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }, 403],
      [{ kind: 'member', userId: f.user.id, scope: { gymId: f.gymId, householdId: f.member.householdId, role: 'payer' } }, 403],
    ] as const) expect((await request(server(f, principal), f, { invalid: true })).status).toBe(status);
  });
  it('returns 404 for another gym pack or member and never writes an invoice', async () => {
    const f = await fixture(), other = await fixture(), app = server(f, staff(f, 'front_desk'));
    expect((await request(app, other, input(f))).status).toBe(404);
    expect((await request(app, f, input(other))).status).toBe(404);
    expect(await db.forGym(f.gymId, tx => tx.select().from(invoices))).toHaveLength(0);
    expect(await db.forGym(other.gymId, tx => tx.select().from(invoices))).toHaveLength(0);
  });
  it('refuses archived packs, erased members and injected payer/invoice fields', async () => {
    const f = await fixture(), app = server(f, staff(f, 'owner'));
    for (const extra of [{ householdId: uuidv7() }, { invoiceId: uuidv7() }, { amountCents: 1 }, { credits: 100 }])
      expect((await request(app, f, { ...input(f), ...extra })).status).toBe(400);
    await db.forGym(f.gymId, tx => tx.update(classPacks).set({ active: false }).where(eq(classPacks.id, f.pack.id)));
    expect((await request(app, f)).status).toBe(409);
    await db.forGym(f.gymId, async tx => {
      await tx.update(classPacks).set({ active: true }).where(eq(classPacks.id, f.pack.id));
      await tx.update(members).set({ anonymizedAt: clock.now() }).where(eq(members.id, f.member.id));
    });
    expect((await request(app, f)).status).toBe(404);
    expect(await db.forGym(f.gymId, tx => tx.select().from(invoices))).toHaveLength(0);
  });
  it('snapshots taxed invoice lines and sale terms together, audits them, and grants no credits at issuance', async () => {
    const f = await fixture(), invoice = await f.service.sell(f.context, f.pack.id, input(f));
    expect(invoice.amountCents).toBe(10500);
    const rows = await db.forGym(f.gymId, async tx => ({ sales: await tx.select().from(classPackSales),
      lines: await tx.select().from(invoiceLineItems), credits: await tx.select().from(classCreditEntries), audit: await tx.select().from(auditEvents) }));
    expect(rows.sales).toMatchObject([{ invoiceId: invoice.id, memberId: f.member.id, householdId: invoice.householdId,
      packId: f.pack.id, credits: 10, expiryDays: 30 }]);
    expect(rows.lines).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'charge', description: f.pack.name, amountCents: 10000 }),
      expect.objectContaining({ kind: 'tax', amountCents: 500, taxRateId: f.tax.id, taxRateMillionths: 50000 })]));
    expect(rows.credits).toHaveLength(0);
    expect(rows.audit.map(row => row.action).sort()).toEqual(['billing.class_pack.sold', 'billing.invoice.issued']);
    for (const row of rows.audit) expect(row).toMatchObject({ actorUserId: f.user.id, occurredAt: clock.now() });
    const next = await f.service.sell(f.context, f.pack.id, input(f));
    expect(next.number).toBe(2);
  });
  it.each(['default', 'publishing'])('returns a paid zero-total invoice using %s transitions', async mode => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(classPacks).set({ amountCents: 0 }).where(eq(classPacks.id, f.pack.id)));
    const afterCommit = vi.fn((gymId: string) => db.forGym(gymId, async tx => ({
      sales: await tx.select().from(classPackSales), invoices: await tx.select().from(invoices),
    })));
    // The production barrel creates its routes before runtime configuration, so resolve the service at request time.
    const routes = mode === 'publishing' ? createPackSalesRoutes() : createPackSalesRoutes(f.service);
    try {
      if (mode === 'publishing') configurePackSales(createPackSalesService({ scope: db.forGym, clock,
        settings: createGymSettingsAccessor({ scope: db.forGym }), transitions: createInvoiceTransitions({ scope: db.forGym, clock, afterCommit }) }));
      const response = await request(server(f, staff(f, 'front_desk'), routes), f, { ...input(f), dueOn: '2026-12-10' });
      expect(response.status, await response.clone().text()).toBe(201);
      const { data: invoice } = billingContracts.sellClassPack.response.parse(await response.json());
      expect(invoice).toMatchObject({ householdId: f.member.householdId, kind: 'one_off', number: 1, amountCents: 0,
        status: 'paid', paidAt: clock.now().toISOString(), dueOn: '2026-12-10' });
      const rows = await db.forGym(f.gymId, async tx => ({ payments: await tx.select().from(payments), audits: await tx.select().from(auditEvents) }));
      expect(rows.payments).toHaveLength(0);
      expect(rows.audits.filter(row => row.action === 'billing.invoice.settled_zero')).toMatchObject([
        { targetId: invoice.id, actorUserId: f.user.id, occurredAt: clock.now() },
      ]);
      expect(rows.audits.filter(row => row.action === effectCreated)).toMatchObject([
        { after: { kind: 'activate_memberships', invoiceId: invoice.id } },
      ]);
      expect(afterCommit).toHaveBeenCalledTimes(mode === 'publishing' ? 1 : 0);
      if (mode === 'publishing') {
        expect(afterCommit).toHaveBeenCalledWith(f.gymId);
        await expect(afterCommit.mock.results[0]!.value).resolves.toMatchObject({
          sales: [{ invoiceId: invoice.id, memberId: f.member.id }], invoices: [{ id: invoice.id, status: 'paid', paidAt: clock.now() }],
        });
      }
    } finally { configurePackSales(undefined); }
  });
  it.each(['move', 'erase'])('refuses a sale after a concurrent %s while keeping household before member lock order', async change => {
    const f = await fixture(), nextHome = await factory('households', f.gymId);
    const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const changing = db.forGym(f.gymId, async tx => {
      await tx.select().from(households).where(eq(households.id, f.member.householdId)).for('update');
      // eslint-disable-next-line database/system-tables -- Identify this holder for the bounded lock probe below.
      locked.resolve((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await release.promise;
      await tx.update(members).set(change === 'move' ? { householdId: nextHome.id } : { anonymizedAt: clock.now() })
        .where(eq(members.id, f.member.id));
    });
    const holder = await locked.promise;
    const selling = f.service.sell(f.context, f.pack.id, input(f)).catch((error: unknown) => error);
    try {
      await expect.poll(async () => {
        // Both app connections are occupied; the system pool sees only lock metadata.
        // eslint-disable-next-line database/system-tables -- Test-only probe of the known transaction, without reading tenant data.
        const rows = await db.system.db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_locks waiting join pg_locks held
          on held.locktype = waiting.locktype and held.transactionid = waiting.transactionid
          where held.pid = ${holder} and held.granted and not waiting.granted
        ) as waiting`);
        return rows[0]!.waiting;
      }, { timeout: 10_000, interval: 10 }).toBe(true);
    } finally { release.resolve(); await changing; }
    expect(await selling).toMatchObject({ code: 'not_found' });
    expect(await db.forGym(f.gymId, tx => tx.select().from(invoices))).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classPackSales))).toHaveLength(0);
  });
});
