// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { classCreditEntries, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { billingContracts } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../../core/context.js';
import { createServerRegistry } from '../../../core/registry.js';
import { errorHandler } from '../../../core/errors.js';
import { TestClock } from '../../../core/clock.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createCreditLedgerRoutes } from './ledger.handlers.js';
import { createCreditLedgerService } from './ledger.service.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2028-03-13T04:00:00Z');
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const user = await factory('authUser', gymId), member = await factory('members', gymId);
  return { gymId, user, member, service: createCreditLedgerService({ scope: db.forGym, clock }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function server(f: Fixture, principal: Principal) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId: f.gymId, timezone: 'America/New_York', enabledModules: new Set() },
      principal, clock, requestId: 'credit-ledger-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createCreditLedgerRoutes(f.service) }).mount(app, authorize, new Set());
  return app;
}
const staff = (f: Fixture, role: 'owner' | 'admin' | 'front_desk' | 'coach'): Principal =>
  ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
const input = (f: Fixture) => ({ memberId: f.member.id, credits: 2, reason: 'Class credit correction', adjustmentId: uuidv7() });
const adjust = (app: ReturnType<typeof server>, body: unknown) => app.request('/api/billing/credits/adjust',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const path = (f: Fixture) => '/api/billing/members/' + f.member.id + '/credits';

describe('staff credit ledger routes', () => {
  it.each(['owner', 'admin', 'front_desk', 'coach'] as const)('enforces read and adjustment permissions for %s', async role => {
    const f = await fixture(), app = server(f, staff(f, role)), response = await adjust(app, input(f));
    expect(response.status, await response.clone().text()).toBe(role === 'coach' ? 403 : 200);
    const read = await app.request(path(f));
    expect(read.status, await read.clone().text()).toBe(role === 'coach' ? 403 : 200);
    if (role !== 'coach') {
      expect(billingContracts.adjustClassCredits.response.parse(await response.json()).data.balance).toBe(2);
      expect(billingContracts.getClassCreditLedger.response.parse(await read.json()).data.balance).toBe(2);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(read.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('denies anonymous, member and device principals on both routes', async () => {
    const f = await fixture();
    for (const [principal, status] of [
      [{ kind: 'anonymous' }, 401], [{ kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }, 403],
      [{ kind: 'member', userId: f.user.id, scope: { gymId: f.gymId, householdId: f.member.householdId, role: 'payer' } }, 403],
    ] as const) {
      const app = server(f, principal);
      expect((await adjust(app, {})).status).toBe(status);
      expect((await app.request(path(f))).status).toBe(status);
    }
  });

  it('returns 404 across gyms on both routes, and rejects adjustments to erased members', async () => {
    const a = await fixture(), b = await fixture(), app = server(a, staff(a, 'front_desk'));
    expect((await adjust(app, input(b))).status).toBe(404);
    expect((await app.request(path(b))).status).toBe(404);
    expect(await db.forGym(a.gymId, tx => tx.select().from(classCreditEntries))).toHaveLength(0);
    expect(await db.forGym(b.gymId, tx => tx.select().from(classCreditEntries))).toHaveLength(0);
    await db.forGym(a.gymId, tx => tx.update(members).set({ anonymizedAt: clock.now() }).where(eq(members.id, a.member.id)));
    expect((await adjust(app, input(a))).status).toBe(404);
  });

  it('requires a nonblank reason, bounded nonzero integers, a UUID and strict input', async () => {
    const f = await fixture(), app = server(f, staff(f, 'front_desk'));
    for (const changes of [{ reason: undefined }, { reason: '' }, { reason: '  ' }, { reason: 'a'.repeat(501) },
      { credits: 0 }, { credits: 101 }, { credits: -101 }, { credits: 0.5 }, { adjustmentId: 'invalid' }, { gymId: uuidv7() }])
      expect((await adjust(app, { ...input(f), ...changes })).status).toBe(400);
    expect((await app.request(path(f) + '?limit=101')).status).toBe(400);
    const response = await adjust(app, { ...input(f), credits: -1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: ['insufficient_credits'] } } });
    expect(await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries))).toHaveLength(0);
  });

  it('reads balance, expired remainders and paginated history with invoice numbers inherited from each lot', async () => {
    const f = await fixture(), app = server(f, staff(f, 'front_desk'));
    const invoice = await factory('invoices', f.gymId, { householdId: f.member.householdId, status: 'paid', number: 73, paidAt: clock.now() });
    const sale = await factory('classPackSales', f.gymId, { memberId: f.member.id, householdId: f.member.householdId, invoiceId: invoice.id });
    const grant = await factory('classCreditEntries', f.gymId, { memberId: f.member.id, kind: 'grant', credits: 3,
      saleId: sale.id, reason: null, adjustmentId: null, createdAt: new Date('2028-03-12T10:00:00Z') });
    const expired = await factory('classCreditEntries', f.gymId, { memberId: f.member.id, credits: 7, expiresAt: clock.now(),
      createdAt: new Date('2028-03-12T10:01:00Z') });
    const adjustment = { ...input(f), credits: -1 };
    const first = await adjust(app, adjustment), replay = await adjust(app, adjustment);
    expect(await first.json()).toEqual(await replay.json());
    const read = billingContracts.getClassCreditLedger.response.parse(await (await app.request(path(f) + '?limit=1')).json());
    expect(read.data).toMatchObject({ balance: 2, entries: [{ credits: -1, lotId: grant.id, invoiceNumber: 73 }] });
    expect(read.data.lots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: grant.id, remaining: 2, invoiceNumber: 73, expiresAt: null }),
      expect.objectContaining({ id: expired.id, remaining: 7, expiresAt: clock.now().toISOString() }),
    ]));
    expect(read.pagination).toEqual({ limit: 1, offset: 0, total: 3 });
    const older = billingContracts.getClassCreditLedger.response.parse(await (await app.request(path(f) + '?offset=1&limit=2')).json());
    expect(older.data.entries.map(row => row.id)).toEqual([expired.id, grant.id]);
    expect(older.data.entries[1]!.invoiceNumber).toBe(73);
    const emptyPage = await (await app.request(path(f) + '?offset=50')).json();
    expect(emptyPage).toMatchObject({ data: { balance: 2, entries: [] }, pagination: { total: 3 } });
  });
});
