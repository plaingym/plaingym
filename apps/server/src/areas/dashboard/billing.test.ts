// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles } from '@plaingym/shared';
import type { StaffRole } from '@plaingym/shared';
import { billingDashboardResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService } from '../billing/memberships.js';
import { createPaymentService } from '../billing/payments.js';
import { createBillingDashboardService } from './billing.js';
import { createBillingDashboardRoutes } from './billing.routes.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T00:30:00Z'); // Still October 31 in Vancouver, across the DST change.
const settings = createGymSettingsAccessor({ scope: database.forGym, clock });
const services = { settings,
  memberships: createMembershipService({ scope: database.forGym, settings, clock }),
  payments: createPaymentService({ scope: database.forGym, settings, clock }),
};
const service = createBillingDashboardService(services);
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone: 'America/Vancouver', currency: 'CAD' });
  const user = await factory('authUser', gymId), household = await factory('households', gymId);
  const member = await factory('members', gymId, { householdId: household.id });
  const plan = await factory('plans', gymId);
  const membership = (extra = {}) => factory('memberships', gymId, { householdId: household.id, memberId: member.id,
    planId: plan.id, status: 'active', amountCents: 10000, nextDueOn: '2026-11-01', ...extra });
  let number = 0;
  const invoice = (extra = {}) => factory('invoices', gymId, { householdId: household.id,
    status: 'open', number: ++number, dueOn: '2026-11-01', amountCents: 500, ...extra });
  return { gymId, user, membership, invoice };
}
function app(f: Awaited<ReturnType<typeof fixture>>, roles: readonly StaffRole[] = ['owner'], principal?: Principal) {
  return createApp({ clock, authorize, skipSetup: true,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles } }); await next(); },
    contributions: { routes: createBillingDashboardRoutes(() => service) },
  });
}
async function read(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await app(f).request('/api/dashboard/billing');
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  return billingDashboardResponseSchema.parse(await response.json()).data;
}
describe('billing dashboard through production route composition and real billing services', () => {
  it('normalizes annual MRR once, excludes frozen/trial/cancelled dues and estimates household cycles', async () => {
    const f = await fixture();
    await f.membership(); await f.membership({ interval: 'annual', amountCents: 12001 });
    await f.membership({ status: 'frozen', amountCents: 70000 });
    await f.membership({ status: 'trial', amountCents: 3000 });
    await f.membership({ status: 'cancelled', amountCents: 90000 });
    const data = await read(f);
    expect(data.currency).toBe('CAD');
    expect(data.widgets.find(w => w.id === 'mrr')).toMatchObject({ money: { amountCents: 11000 } });
    expect(data.widgets.find(w => w.id === 'upcoming_charges')).toMatchObject({
      from: '2026-10-31', through: '2026-11-06', invoiceCount: 1, money: { amountCents: 25001 },
    });
  });
  it('uses issued cycle totals, suppresses paid cycles, and handles overdue and terminal dispute states', async () => {
    const f = await fixture();
    await f.membership();
    const cycle = { kind: 'cycle', periodStartsOn: '2026-11-01', periodEndsOn: '2026-12-01' };
    await f.invoice({ ...cycle, amountCents: 9500 });
    await f.membership({ nextDueOn: '2026-11-02' });
    await f.invoice({ ...cycle, dueOn: '2026-11-02', status: 'paid' });
    await f.membership({ nextDueOn: '2026-11-03', amountCents: 100 });
    await f.invoice({ ...cycle, dueOn: '2026-11-03', status: 'draft', number: null, amountCents: 100 });
    await f.invoice({ dueOn: '2026-11-06', amountCents: 600 });
    await f.invoice({ dueOn: '2026-11-07', amountCents: 99999 });
    await f.invoice({ dueOn: '2026-10-30', amountCents: 700, needsReview: true });
    await f.invoice({ status: 'past_due', dueOn: '2026-10-01', amountCents: 800 });
    await f.membership({ nextDueOn: '2026-11-04', amountCents: 1000 });
    await f.invoice({ ...cycle, status: 'past_due', dueOn: '2026-11-04', amountCents: 2000 });
    await f.invoice({ status: 'past_due', dueOn: '2026-10-01', amountCents: 0 });
    await f.invoice({ status: 'void', dueOn: '2026-10-01', amountCents: 99999 });
    await f.invoice({ status: 'paid', disputeId: 'dp_open', disputeStatus: 'needs_response', amountCents: 900 });
    for (const disputeStatus of ['won', 'lost', 'closed', 'warning_closed'])
      await f.invoice({ status: 'paid', disputeId: 'dp_' + disputeStatus, disputeStatus, amountCents: 99999 });
    const data = await read(f);
    expect(data.widgets.find(w => w.id === 'upcoming_charges')).toMatchObject({ invoiceCount: 3, money: { amountCents: 10200 } });
    expect(data.widgets.find(w => w.id === 'past_due')).toMatchObject({ invoiceCount: 3, money: { amountCents: 3500 } });
    expect(data.widgets.find(w => w.id === 'disputes')).toMatchObject({ count: 1, money: { amountCents: 900 } });
  });
  it('reads every page of invoices and memberships', async () => {
    const f = await fixture();
    for (let i = 0; i < 101; i++) { await f.membership({ amountCents: 1 }); await f.invoice({ status: 'past_due', amountCents: 1, dueOn: '2026-10-30' }); }
    const data = await read(f);
    expect(data.widgets.find(w => w.id === 'mrr')).toMatchObject({ money: { amountCents: 101 } });
    expect(data.widgets.find(w => w.id === 'past_due')).toMatchObject({ invoiceCount: 101, money: { amountCents: 101 } });
  });
  it('filters every service read and never reads unrelated paid history outside the upcoming window', async () => {
    const f = await fixture(); await f.membership();
    const history = await f.invoice({ status: 'paid', dueOn: '2020-01-01' });
    const original = services.payments.listInvoices.bind(services.payments);
    const paymentReads = vi.spyOn(services.payments, 'listInvoices').mockImplementation(async (gymId, query) => {
      expect(query).toEqual(expect.objectContaining({ limit: 100, offset: expect.any(Number) }));
      const q = query as Record<string, unknown>;
      expect(q.dispute === 'open' || q.status === 'past_due' || q.status === 'open' && q.dueThrough === '2026-10-30'
        || q.dueFrom === '2026-10-31' && q.dueThrough === '2026-11-06').toBe(true);
      const page = await original(gymId, query);
      expect(page.data.map(row => row.id)).not.toContain(history.id);
      return page;
    });
    const membershipReads = vi.spyOn(services.memberships, 'list');
    try {
      await read(f);
      expect(paymentReads.mock.calls).toHaveLength(4);
      expect(membershipReads.mock.calls.map(([, query]) => query)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'active' }), expect.objectContaining({ dueOnOrBefore: '2026-11-06' }),
      ]));
      expect(membershipReads.mock.calls).toHaveLength(2);
    } finally { paymentReads.mockRestore(); membershipReads.mockRestore(); }
  });
  it('deduplicates invoices and memberships shifted into a later page by a concurrent insert', async () => {
    const f = await fixture();
    for (let i = 0; i < 101; i++) { await f.membership({ amountCents: 1 }); await f.invoice({ status: 'past_due', amountCents: 1, dueOn: '2026-10-30' }); }
    const listInvoices = services.payments.listInvoices.bind(services.payments), listMemberships = services.memberships.list.bind(services.memberships);
    let insertedInvoice = false, insertedMembership = false;
    const paymentReads = vi.spyOn(services.payments, 'listInvoices').mockImplementation(async (gymId, input) => {
      const query = input as { status?: string; offset: number };
      if (query.status === 'past_due' && query.offset === 100 && !insertedInvoice) {
        insertedInvoice = true;
        await f.invoice({ status: 'past_due', amountCents: 1, dueOn: '2026-10-30', createdAt: new Date('2099-01-01T00:00:00Z') });
      }
      return listInvoices(gymId, input);
    });
    const membershipReads = vi.spyOn(services.memberships, 'list').mockImplementation(async (gymId, input) => {
      const query = input as { status?: string; offset: number };
      if (query.status === 'active' && query.offset === 100 && !insertedMembership) {
        insertedMembership = true; await f.membership({ amountCents: 1, nextDueOn: '2020-01-01' });
      }
      return listMemberships(gymId, input);
    });
    try {
      const data = await read(f);
      expect(insertedInvoice && insertedMembership).toBe(true);
      expect(data.widgets.find(w => w.id === 'past_due')).toMatchObject({ invoiceCount: 101, money: { amountCents: 101 } });
      expect(data.widgets.find(w => w.id === 'mrr')).toMatchObject({ money: { amountCents: 101 } });
    } finally { paymentReads.mockRestore(); membershipReads.mockRestore(); }
  });
  for (const role of staffRoles) it(`enforces billing.read for ${role}`, async () => {
    const f = await fixture();
    expect((await app(f, [role]).request('/api/dashboard/billing')).status).toBe(role === 'coach' ? 403 : 200);
  });
  it('isolates gyms and rejects another gym session, portal login, kiosk and anonymous callers', async () => {
    const a = await fixture(), b = await fixture();
    await a.membership({ amountCents: 123 }); await b.membership({ amountCents: 999999 });
    expect((await read(a)).widgets.find(w => w.id === 'mrr')).toMatchObject({ money: { amountCents: 123 } });
    expect((await app(a, [], { kind: 'staff', gymId: b.gymId, userId: b.user.id, roles: ['owner'] }).request('/api/dashboard/billing')).status).toBe(403);
    for (const principal of [{ kind: 'anonymous' }, { kind: 'kiosk', gymId: a.gymId, deviceId: uuidv7() },
      { kind: 'member', userId: a.user.id, scope: { gymId: a.gymId, householdId: uuidv7(), role: 'payer' } }] as const) {
      expect((await app(a, [], principal).request('/api/dashboard/billing')).status).not.toBe(200);
    }
  });
});
