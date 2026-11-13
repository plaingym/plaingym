// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles } from '@plaingym/shared';
import { cardChargeIssue, minimumChargeAmount, minorUnitStep } from '@plaingym/shared/money';
import { eligibility } from '../billing/runner/eligibility.js';
import type { StaffRole } from '@plaingym/shared';
import { billingDashboardResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createBillingDashboardService, createSkippedCollectionsProvider } from './billing.js';
import { createBillingDashboardRoutes } from './billing.routes.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T00:30:00Z'); // Still October 31 in Vancouver, across the DST change.
const settings = createGymSettingsAccessor({ scope: database.forGym, clock });
const services = { settings,
  scope: database.forGym,
};
const service = createBillingDashboardService(services);
async function fixture(currency = 'CAD') {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone: 'America/Vancouver', currency, billingEnabled: true });
  const user = await factory('authUser', gymId), household = await factory('households', gymId);
  const member = await factory('members', gymId, { householdId: household.id });
  const plan = await factory('plans', gymId);
  const membership = (extra = {}) => factory('memberships', gymId, { householdId: household.id, memberId: member.id,
    planId: plan.id, status: 'active', amountCents: 10000, nextDueOn: '2026-11-01', ...extra });
  let number = 0;
  const invoice = (extra = {}) => factory('invoices', gymId, { householdId: household.id,
    status: 'open', number: ++number, dueOn: '2026-11-01', amountCents: 500, ...extra });
  return { gymId, user, household, member, plan, membership, invoice };
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
describe('billing dashboard through production route composition and PostgreSQL', () => {
  it.each(['USD', 'GBP', 'JPY', 'KWD', 'ISK', 'UGX'])('pins the skipped shortlist to card and runner rules for %s', async currency => {
    const f = await fixture(currency), gym = await settings.get(f.gymId);
    const minimum = minimumChargeAmount(currency) ?? 0, step = minorUnitStep(currency);
    const expected: string[] = [];
    for (const amountCents of new Set([0, 1, Math.max(0, minimum - 1), minimum, minimum + 1, step, step + 1, step * 100])) {
      const household = await factory('households', f.gymId);
      const invoice = await f.invoice({ householdId: household.id, kind: 'cycle', currency, amountCents, dueOn: '2026-10-31',
        periodStartsOn: '2026-10-01', periodEndsOn: '2026-11-01' });
      const issue = cardChargeIssue(amountCents, currency);
      const decision = await database.forGym(f.gymId, tx => eligibility(tx, gym, clock, invoice.id, 'automatic'));
      if (amountCents > 0 && issue) {
        expected.push(`/admin/billing/invoices/${invoice.id}`);
        expect(decision).toEqual({ status: 'skipped', reason: issue });
      } else expect(decision).toHaveProperty('status', amountCents === 0 ? 'eligible' : 'skipped');
    }
    const widget = await createSkippedCollectionsProvider(services).read({ gymId: f.gymId, roles: ['owner'], clock });
    expect(widget?.items?.map(item => item.href).sort() ?? []).toEqual(expected.sort());
    expect(widget?.count ?? 0).toBe(expected.length);
  });
  it('includes a staff-assigned thirty-cent first invoice, excludes charges, and caps the SQL shortlist while counting every match', async () => {
    const f = await fixture('USD'), other = await fixture('USD');
    const membership = await f.membership();
    const assigned = async (home: typeof f, kinds = ['membership', 'signup_fee', 'discount', 'tax']) => {
      const invoice = await home.invoice({ kind: 'one_off', amountCents: 30, currency: 'USD', dueOn: '2026-10-30' });
      for (const kind of kinds) await factory('invoiceLineItems', home.gymId, { householdId: home.household.id,
        invoiceId: invoice.id, membershipId: home === f ? membership.id : null, kind, amountCents: 30,
        ...(kind === 'tax' ? { taxRateMillionths: 10000, taxInclusive: false } : {}) });
      return invoice;
    };
    const first = await assigned(f);
    for (let i = 0; i < 21; i++) await assigned(f, ['membership']);
    await assigned(f, ['membership', 'charge']);
    const foreign = await assigned(other, ['membership']);
    await f.invoice({ amountCents: 30, dueOn: '2026-10-30' }); // No lines is not an assignment.
    const widget = await createSkippedCollectionsProvider(services).read({ gymId: f.gymId, roles: ['owner'], clock });
    expect(widget?.count).toBe(22);
    expect(widget?.items).toHaveLength(20);
    expect(widget?.items?.[0]?.href).toBe(`/admin/billing/invoices/${first.id}`);
    expect(widget?.items?.map(item => item.href)).not.toContain(`/admin/billing/invoices/${foreign.id}`);
  });
  it.each([[32, 'CAD', 'below the card minimum'], [1255, 'KWD', 'amount is off the currency step']] as const)(
    'lists due cycle collections of %s %s, isolates gyms, and denies coaches', async (amountCents, currency, reason) => {
    const f = await fixture(currency), other = await fixture(currency);
    const cycle = { kind: 'cycle', periodStartsOn: '2026-10-01', periodEndsOn: '2026-11-01', dueOn: '2026-10-31' };
    const small = await f.invoice({ ...cycle, amountCents });
    await other.invoice({ ...cycle, amountCents });
    await f.invoice({ ...cycle, amountCents, status: 'paid', dueOn: '2026-10-30' });
    await f.invoice({ ...cycle, amountCents, needsReview: true, dueOn: '2026-10-29' });
    await f.invoice({ ...cycle, amountCents, dueOn: '2026-11-01' });
    await f.invoice({ ...cycle, amountCents: 0, dueOn: '2026-10-28' });
    await f.invoice({ amountCents });
    const provider = createSkippedCollectionsProvider(services), context = { gymId: f.gymId, roles: ['owner'] as const, clock };
    const widget = await provider.read(context);
    expect(widget).toMatchObject({ count: 1, items: [{ href: `/admin/billing/invoices/${small.id}`, label: expect.stringContaining(reason) }] });
    await expect(provider.read({ ...context, roles: ['coach'] })).rejects.toMatchObject({ code: 'forbidden' });
    const disabled = createSkippedCollectionsProvider({ ...services, settings: { async get(gymId) { return { ...await settings.get(gymId), billingEnabled: false }; } } });
    expect(await disabled.read(context)).toBeNull();
  });
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
  it('counts invoices and memberships beyond the former page size', async () => {
    const f = await fixture();
    for (let i = 0; i < 101; i++) { await f.membership({ amountCents: 1 }); await f.invoice({ status: 'past_due', amountCents: 1, dueOn: '2026-10-30' }); }
    const data = await read(f);
    expect(data.widgets.find(w => w.id === 'mrr')).toMatchObject({ money: { amountCents: 101 } });
    expect(data.widgets.find(w => w.id === 'past_due')).toMatchObject({ invoiceCount: 101, money: { amountCents: 101 } });
  });
  it('uses an aggregate instead of service pagination and ignores unrelated paid history', async () => {
    const f = await fixture(); await f.membership();
    await f.invoice({ status: 'paid', dueOn: '2020-01-01', amountCents: 99999 });
    const data = await read(f);
    expect(data.widgets.find(w => w.id === 'mrr')).toMatchObject({ money: { amountCents: 10000 } });
  });
  it('fails closed on a relevant currency mismatch but does not inspect unrelated settled history', async () => {
    const f = await fixture('CAD');
    // Model settings changing between their read and the aggregate, without bypassing the currency FK.
    const staleSettings = { async get(gymId: string) { return { ...await settings.get(gymId), currency: 'USD' }; } };
    const dashboard = createBillingDashboardService({ ...services, settings: staleSettings });
    const context = { gymId: f.gymId, clock, roles: ['owner'] as const };
    await f.invoice({ status: 'paid', dueOn: '2020-01-01' });
    expect((await dashboard.get(context)).data.widgets.find(widget => widget.id === 'mrr')).toHaveProperty('money.amountCents', 0);
    await f.membership();
    await expect(dashboard.get(context)).rejects.toMatchObject({ code: 'unavailable' });
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
