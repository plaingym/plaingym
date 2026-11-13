// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, invoices, memberships, uuidv7 } from '@plaingym/db';
import type { StaffRole } from '@plaingym/shared';
import { createApp } from '../../app.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMembershipService } from './memberships.js';
import { planSwitchedAction } from './memberships.plan-change.js';
import { createMembershipRoutes } from './memberships.routes.js';
import { createTransitionEffects } from './transitions/effects.js';
import { createTransitionJobs } from './transitions/transitions.jobs.js';
import { useRunnerFixture, type FixtureOptions } from './runner/runner.fixture.test-helper.js';

const { db, factory, fixture } = useRunnerFixture();
interface Reply { status: number; body: { data?: Record<string, unknown> & { invoiceId?: string | null; membership?: Record<string, unknown> }; error?: { code: string; details?: { reason?: string[] } } } }
/**
 * The runner fixture (a household billed on the 1st with a saved card and a $100 monthly membership due 1 March) behind
 * the membership routes, with the runner's collection hook. Unless `bill` is false, the daily run bills and charges the
 * March cycle; the clock then moves to `on` (16 March, Vancouver).
 */
async function setup(options: FixtureOptions & { bill?: boolean; on?: string } = {}) {
  const f = await fixture(options);
  const service = createMembershipService({ ...f.serviceOptions, onAssigned: f.runner.onAssigned });
  const user = await factory('authUser', f.gymId);
  const staff = { gymId: f.gymId, actor: { kind: 'user' as const, userId: user.id } };
  // A test can replace the collection, to stand for a process that stopped after the switch committed.
  const hooks = { collect: (gymId: string, householdId: string) => f.runner.collectAssigned(gymId, householdId) };
  function app(role: StaffRole) {
    return createApp({ clock: f.clock, skipSetup: true, authorize,
      contributions: { routes: createMembershipRoutes(service, { assigned: (gymId, householdId) => hooks.collect(gymId, householdId) }) },
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: f.gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
      session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: user.id, roles: [role] } }); await next(); },
    });
  }
  async function call(method: string, path: string, body?: unknown, role: StaffRole = 'owner'): Promise<Reply> {
    const response = await app(role).request('https://gym.invalid' + path, { method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Reply['body'] };
  }
  const row = async (id = f.membership.id) => (await f.read()).memberships.find(m => m.id === id)!;
  const path = (id = f.membership.id) => `/api/billing/memberships/${id}`;
  const newPlan = (overrides: Record<string, unknown> = {}) => factory('plans', f.gymId, { name: 'Plan ' + uuidv7(), ...overrides });
  async function switchBody(planId: string, overrides: Record<string, unknown> = {}, id = f.membership.id) {
    return { revision: (await row(id)).revision, requestId: uuidv7(), planId, timing: 'now', ...overrides };
  }
  const switchNow = async (planId: string, overrides: Record<string, unknown> = {}, id = f.membership.id, role: StaffRole = 'owner') =>
    call('POST', path(id) + '/switch', await switchBody(planId, overrides, id), role);
  const preview = (planId: string, timing = 'now', id = f.membership.id, role: StaffRole = 'owner') =>
    call('GET', `${path(id)}/switch/preview?planId=${planId}&timing=${timing}`, undefined, role);
  /** The daily build and collection at 09:00 Vancouver time on `date`. */
  async function dailyOn(date: string) { f.clock.set(date + 'T17:00:00Z'); return f.runner.daily(f.gymId); }
  /** Runs the transitions' effects (receipts, membership activation) for every invoice paid so far. */
  async function effects() {
    const jobs = new FakeJobs(f.clock), notifications = { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}), staffNotice: vi.fn(async () => {}) };
    const run = createTransitionEffects({ ...f.serviceOptions, jobs, transitions: f.transitions, memberships: service,
      payments: async () => f.provider, notifications, retry: f.runner.retry });
    for (const job of createTransitionJobs(() => run)) jobs.handle(job.id, job.handler);
    await run.publish(f.gymId); while (await jobs.runNext()) { /* every effect */ }
  }
  const switchInvoices = async () => (await f.read()).invoices.filter(invoice => invoice.kind === 'one_off');
  if (options.bill !== false) await f.runner.daily(f.gymId);
  f.clock.set(options.on ?? '2028-03-16T17:00:00Z');
  return { ...f, service, user, staff, hooks, call, row, path, newPlan, switchBody, switchNow, preview, dailyOn, effects, switchInvoices };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const refused = (reply: Reply, reason: string) => {
  expect(reply.status, JSON.stringify(reply.body)).toBe(409);
  expect(reply.body.error).toMatchObject({ code: 'conflict', details: { reason: [reason] } });
};
/** The upgrade's invoice: one, paid once with one attempt and one provider charge, for the prorated difference. */
async function expectOneCharge(f: Setup, invoiceId: string, amountCents: number, charges: ReturnType<typeof vi.spyOn>) {
  const state = await f.read();
  expect((await f.switchInvoices()).map(invoice => [invoice.id, invoice.amountCents, invoice.status])).toEqual([[invoiceId, amountCents, 'paid']]);
  expect(state.attempts.filter(attempt => attempt.invoiceId === invoiceId)).toHaveLength(1);
  expect(state.payments.filter(payment => payment.invoiceId === invoiceId).map(payment => payment.amountCents)).toEqual([amountCents]);
  expect(charges).toHaveBeenCalledTimes(1);
  expect(charges).toHaveBeenCalledWith(expect.objectContaining({ invoiceId, amount: amountCents }));
}

describe('switch a plan now through the routes', () => {
  it('charges an upgrade once for the quoted difference, retried in sequence, and the next cycle bills the new price', async () => {
    const f = await setup(), premium = await f.newPlan({ amountCents: 13_000 });
    const before = await f.row(), charges = vi.spyOn(f.provider, 'createCharge');
    // $30 more a month for 16 of March's 31 days.
    const quoted = await f.preview(premium.id);
    expect(quoted).toEqual({ status: 200, body: { data: { planId: premium.id, timing: 'now', kind: 'upgrade', currency: before.currency,
      priceStartsOn: '2028-03-16', commitmentBlocks: false, discount: 'none',
      proration: { periodStartsOn: '2028-03-01', periodEndsOn: '2028-04-01', billedDays: 16, periodDays: 31, totalCents: 1_548 } } } });
    const body = await f.switchBody(premium.id);
    const first = await f.call('POST', f.path() + '/switch', body);
    expect(first.status).toBe(200);
    const invoiceId = first.body.data!.invoiceId!;
    expect(first.body.data!.membership).toMatchObject({ planId: premium.id, amountCents: 13_000, status: 'active', nextDueOn: '2028-04-01',
      scheduledPlanId: null, revision: before.revision + 1 });
    expect(await f.call('POST', f.path() + '/switch', body)).toEqual(first);
    await expectOneCharge(f, invoiceId, 1_548, charges);
    const state = await f.read();
    expect(state.invoices.find(invoice => invoice.id === invoiceId)).toMatchObject({ dueOn: '2028-03-16', periodStartsOn: null, needsReview: false });
    // The line records the new plan, so reports keep it there.
    expect(state.lines.filter(line => line.invoiceId === invoiceId).map(line => [line.kind, line.membershipId, line.planId, line.amountCents]))
      .toEqual([['membership', f.membership.id, premium.id, 1_548]]);
    const audits = state.audits.filter(audit => audit.action === planSwitchedAction);
    expect(audits).toMatchObject([{ actorKind: 'user', actorUserId: f.user.id, targetId: f.membership.id, before: { planId: f.plan.id, amountCents: 10_000 },
      after: { request: { requestId: body.requestId, planId: premium.id, timing: 'now', override: false }, overrideUsed: false, kind: 'upgrade', invoiceId } }]);
    // The paid invoice's effect leaves the active membership as it is.
    await f.effects();
    expect(await f.row()).toMatchObject({ status: 'active', planId: premium.id, amountCents: 13_000, nextDueOn: '2028-04-01', revision: before.revision + 1 });
    await f.dailyOn('2028-04-01');
    const april = (await f.read()).invoices.find(invoice => invoice.kind === 'cycle' && invoice.dueOn === '2028-04-01')!;
    expect((await f.read()).lines.filter(line => line.invoiceId === april.id).map(line => [line.planId, line.amountCents])).toEqual([[premium.id, 13_000]]);
    expect(await f.switchInvoices()).toHaveLength(1);
  });
  it('charges once when the same upgrade is submitted twice at once', async () => {
    const f = await setup(), premium = await f.newPlan({ amountCents: 13_000 }), charges = vi.spyOn(f.provider, 'createCharge');
    const body = await f.switchBody(premium.id);
    const [one, two] = await Promise.all([f.call('POST', f.path() + '/switch', body), f.call('POST', f.path() + '/switch', body)]);
    expect(one.status).toBe(200); expect(two).toEqual(one);
    await expectOneCharge(f, one.body.data!.invoiceId!, 1_548, charges);
    expect((await f.read()).audits.filter(audit => audit.action === planSwitchedAction)).toHaveLength(1);
  });
  it('charges once when a retry follows a lost response, whether or not collection had run', async () => {
    const f = await setup(), premium = await f.newPlan({ amountCents: 13_000 }), charges = vi.spyOn(f.provider, 'createCharge');
    // The process stops after the switch commits, before collecting: the response never arrives.
    f.hooks.collect = async () => ({ attempted: 0, errors: [] });
    const body = await f.switchBody(premium.id);
    const lost = await f.call('POST', f.path() + '/switch', body);
    expect(charges).not.toHaveBeenCalled();
    f.hooks.collect = (gymId, householdId) => f.runner.collectAssigned(gymId, householdId);
    // The retry carries the old revision and replays, and its collection charges the invoice.
    const retried = await f.call('POST', f.path() + '/switch', body);
    expect(retried).toEqual(lost);
    await expectOneCharge(f, retried.body.data!.invoiceId!, 1_548, charges);
    // A response lost after the charge: another retry charges nothing more, and the daily run leaves it paid.
    expect(await f.call('POST', f.path() + '/switch', body)).toEqual(lost);
    await f.dailyOn('2028-03-17');
    await expectOneCharge(f, retried.body.data!.invoiceId!, 1_548, charges);
    // The same request ID with other parameters, or a new request on the old revision, is a conflict.
    const other = await f.newPlan({ amountCents: 14_000 });
    expect((await f.call('POST', f.path() + '/switch', { ...body, planId: other.id })).status).toBe(409);
    expect((await f.call('POST', f.path() + '/switch', { ...body, timing: 'next_billing_date' })).status).toBe(409);
    expect((await f.call('POST', f.path() + '/switch', { ...body, requestId: uuidv7(), planId: other.id })).status).toBe(409);
    expect(await f.switchInvoices()).toHaveLength(1);
  });
  it('moves no money on a downgrade now, keeping the price until the next cycle bills the new one', async () => {
    const f = await setup(), basic = await f.newPlan({ amountCents: 8_000 }), charges = vi.spyOn(f.provider, 'createCharge');
    const before = await f.read();
    expect((await f.preview(basic.id)).body.data).toEqual({ planId: basic.id, timing: 'now', kind: 'downgrade', currency: 'CAD',
      priceStartsOn: '2028-04-01', commitmentBlocks: false, discount: 'none', proration: null });
    const switched = await f.switchNow(basic.id);
    expect(switched.status).toBe(200);
    expect(switched.body.data).toMatchObject({ invoiceId: null, membership: { planId: basic.id, amountCents: 10_000,
      scheduledPlanId: basic.id, scheduledAmountCents: 8_000, scheduledInterval: 'monthly', scheduledOn: '2028-04-01' } });
    const after = await f.read();
    expect([after.invoices.length, after.attempts.length, after.payments.length, after.refunds.length])
      .toEqual([before.invoices.length, before.attempts.length, before.payments.length, 0]);
    expect(charges).not.toHaveBeenCalled();
    await f.dailyOn('2028-04-01');
    const state = await f.read(), april = state.invoices.find(invoice => invoice.dueOn === '2028-04-01')!;
    expect(state.lines.filter(line => line.invoiceId === april.id).map(line => [line.planId, line.amountCents])).toEqual([[basic.id, 8_000]]);
    expect(await f.row()).toMatchObject({ planId: basic.id, amountCents: 8_000, scheduledPlanId: null });
    expect(state.refunds).toEqual([]);
  });
  it('switches an equal plan now with nothing charged or scheduled', async () => {
    const f = await setup(), same = await f.newPlan({ amountCents: 10_000 }), charges = vi.spyOn(f.provider, 'createCharge');
    expect((await f.preview(same.id)).body.data).toMatchObject({ kind: 'equal', priceStartsOn: '2028-04-01', proration: null });
    const switched = await f.switchNow(same.id);
    expect(switched.body.data).toMatchObject({ invoiceId: null, membership: { planId: same.id, amountCents: 10_000, scheduledPlanId: null } });
    expect(await f.switchInvoices()).toEqual([]); expect(charges).not.toHaveBeenCalled();
  });
  it('switches an upgrade on its due date, before the cycle runs, with no invoice', async () => {
    const f = await setup({ bill: false, on: '2028-03-01T16:00:00Z' }), premium = await f.newPlan({ amountCents: 13_000 });
    expect((await f.preview(premium.id)).body.data).toMatchObject({ kind: 'upgrade', priceStartsOn: '2028-03-01', proration: null });
    expect((await f.switchNow(premium.id)).body.data).toMatchObject({ invoiceId: null, membership: { planId: premium.id, amountCents: 13_000 } });
    await f.dailyOn('2028-03-01');
    expect((await f.read()).invoices.map(invoice => [invoice.kind, invoice.amountCents])).toEqual([['cycle', 13_000]]);
  });
  it('issues no invoice for a proration rounded to zero or a household discounted to zero', async () => {
    const f = await setup({ on: '2028-03-31T17:00:00Z' }), cent = await f.newPlan({ amountCents: 10_001 });
    expect((await f.preview(cent.id)).body.data!.proration).toEqual({ periodStartsOn: '2028-03-01', periodEndsOn: '2028-04-01',
      billedDays: 0, periodDays: 31, totalCents: 0 });
    expect((await f.switchNow(cent.id)).body.data).toMatchObject({ invoiceId: null, membership: { planId: cent.id, amountCents: 10_001 } });
    const g = await setup({ bill: false });
    await db.forGym(g.gymId, tx => tx.update(households).set({ familyDiscountBasisPoints: 10_000 }).where(eq(households.id, g.home.id)));
    await g.dailyOn('2028-03-01'); g.clock.set('2028-03-16T17:00:00Z');
    const premium = await g.newPlan({ amountCents: 13_000 });
    expect((await g.preview(premium.id)).body.data!.proration).toEqual({ periodStartsOn: '2028-03-01', periodEndsOn: '2028-04-01',
      billedDays: 16, periodDays: 31, totalCents: 0 });
    expect((await g.switchNow(premium.id)).body.data).toMatchObject({ invoiceId: null, membership: { planId: premium.id, amountCents: 13_000 } });
    expect(await g.switchInvoices()).toEqual([]);
  });
});

describe('switch now refusals', () => {
  it('refuses an interval change, and pending, trial and frozen memberships, in the preview too', async () => {
    const f = await setup(), annual = await f.newPlan({ interval: 'annual', amountCents: 130_000 }), premium = await f.newPlan({ amountCents: 13_000 });
    refused(await f.switchNow(annual.id), 'interval_change');
    refused(await f.preview(annual.id), 'interval_change');
    // On the next billing date the interval change is fine.
    expect((await f.preview(annual.id, 'next_billing_date')).body.data).toMatchObject({ kind: 'upgrade', priceStartsOn: '2028-04-01', proration: null });
    for (const overrides of [{ status: 'pending' }, { status: 'trial', trialEndsOn: '2028-03-20' }, { status: 'frozen', frozenAt: f.clock.now() }]) {
      const member = await factory('members', f.gymId, { householdId: f.home.id });
      const other = await factory('memberships', f.gymId, { householdId: f.home.id, memberId: member.id, planId: f.plan.id,
        startsOn: '2028-03-01', nextDueOn: '2028-04-01', ...overrides });
      refused(await f.switchNow(premium.id, {}, other.id), 'not_active');
      refused(await f.preview(premium.id, 'now', other.id), 'not_active');
    }
    expect(await f.switchInvoices()).toEqual([]);
    expect(await f.row()).toMatchObject({ planId: f.plan.id, amountCents: 10_000 });
  });
  it('refuses an upgrade now when the current period wasn\'t billed at the membership\'s price', async () => {
    const premium = (f: Setup) => f.newPlan({ amountCents: 13_000 });
    // Overdue: the cycle due on 1 March hasn't run.
    const overdue = await setup({ bill: false, on: '2028-03-02T17:00:00Z' });
    refused(await overdue.switchNow((await premium(overdue)).id), 'period_not_billed');
    refused(await overdue.switchNow((await overdue.newPlan({ amountCents: 8_000 })).id), 'period_not_billed');
    // A freeze resumed early keeps its skipped cycle's due date: the days to it were never billed.
    const resumed = await setup({ on: '2028-03-10T17:00:00Z' });
    const frozen = await resumed.service.freeze(resumed.staff, { membershipId: resumed.membership.id, revision: (await resumed.row()).revision, resumesOn: null });
    resumed.clock.set('2028-03-15T17:00:00Z');
    await resumed.service.activate(resumed.staff, { membershipId: frozen.id, revision: frozen.revision });
    expect(await resumed.row()).toMatchObject({ status: 'active', nextDueOn: '2028-05-01' });
    const plan = await premium(resumed);
    resumed.clock.set('2028-03-20T17:00:00Z');
    refused(await resumed.preview(plan.id), 'period_not_billed');
    refused(await resumed.switchNow(plan.id), 'period_not_billed');
    resumed.clock.set('2028-04-05T17:00:00Z');
    refused(await resumed.switchNow(plan.id), 'period_not_billed');
    // A trial activated early, and a first period left to the next billing date.
    const early = await setup({ on: '2028-03-10T17:00:00Z' });
    const member = await factory('members', early.gymId, { householdId: early.home.id });
    const trial = await factory('memberships', early.gymId, { householdId: early.home.id, memberId: member.id, planId: early.plan.id,
      status: 'trial', startsOn: '2028-02-20', trialEndsOn: '2028-03-20', nextDueOn: '2028-03-20' });
    await early.service.activate(early.staff, { membershipId: trial.id, revision: trial.revision });
    const later = await early.service.assign(early.staff, { id: uuidv7(), householdId: early.home.id, memberId: (await factory('members', early.gymId,
      { householdId: early.home.id })).id, planId: early.plan.id, startsOn: '2028-03-10', nextDueOn: '2028-04-01', initialStatus: 'active', firstPeriod: 'next_billing_date' });
    early.clock.set('2028-03-12T17:00:00Z');
    const upgrade = await premium(early);
    refused(await early.switchNow(upgrade.id, {}, trial.id), 'period_not_billed');
    refused(await early.switchNow(upgrade.id, {}, later.id), 'period_not_billed');
    // The membership billed for March can still upgrade.
    expect((await early.switchNow(upgrade.id)).status).toBe(200);
    for (const f of [overdue, resumed, early]) expect((await f.switchInvoices()).length).toBe(f === early ? 1 : 0);
  });
  it('blocks a downgrade before the commitment ends unless the request carries an override reason, which no response or audit holds', async () => {
    const f = await setup(), basic = await f.newPlan({ amountCents: 8_000 });
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ commitmentEndsOn: '2028-06-01' }).where(eq(memberships.id, f.membership.id)));
    expect((await f.preview(basic.id)).body.data).toMatchObject({ kind: 'downgrade', commitmentBlocks: true });
    refused(await f.switchNow(basic.id), 'commitment');
    const reason = 'Approved hardship case';
    const switched = await f.switchNow(basic.id, { override: { reason } });
    expect(switched.status).toBe(200);
    expect(switched.body.data!.membership).toMatchObject({ planId: basic.id, amountCents: 10_000, scheduledAmountCents: 8_000 });
    expect(JSON.stringify(switched.body)).not.toContain('hardship');
    expect((await f.row()).switchOverrideReason).toBe(reason);
    expect(JSON.stringify((await f.read()).audits)).not.toContain('hardship');
    expect((await f.read()).audits.filter(audit => audit.action === planSwitchedAction)).toMatchObject([{ after: { request: { override: true }, overrideUsed: true, kind: 'downgrade' } }]);
    // The price change it leaves isn't cancelled (that would keep Basic at the old price); a price edit replaces it and
    // keeps the reason of the switch that applied.
    refused(await f.call('POST', f.path() + '/switch/cancel', { revision: (await f.row()).revision }), 'price_change');
    const repriced = await f.call('PATCH', f.path(), { revision: (await f.row()).revision, price: { amountCents: 9_000, currency: 'CAD' } });
    expect(repriced.body.data).toMatchObject({ planId: basic.id, amountCents: 9_000, scheduledPlanId: null });
    expect((await f.row()).switchOverrideReason).toBe(reason);
  });
  it('refuses an upgrade now after a mid-period price edit or a full refund of the period', async () => {
    const premium = (f: Setup) => f.newPlan({ amountCents: 13_000 });
    // Billed 100 for March, then edited to 50: the days left were paid at 100, not 50.
    const edited = await setup();
    const plan = await premium(edited);
    expect((await edited.call('PATCH', edited.path(), { revision: (await edited.row()).revision, price: { amountCents: 5_000, currency: 'CAD' } })).status).toBe(200);
    refused(await edited.preview(plan.id), 'period_not_billed');
    refused(await edited.switchNow(plan.id), 'period_not_billed');
    // On the next billing date it still works.
    expect((await edited.switchNow(plan.id, { timing: 'next_billing_date' })).status).toBe(200);
    // March's cycle refunded in full: nothing paid for the days left.
    const refunded = await setup(), refundedPlan = await premium(refunded);
    const march = (await refunded.read()).invoices.find(invoice => invoice.kind === 'cycle' && invoice.dueOn === '2028-03-01')!;
    await db.forGym(refunded.gymId, tx => tx.update(invoices).set({ status: 'refunded' }).where(eq(invoices.id, march.id)));
    refused(await refunded.switchNow(refundedPlan.id), 'period_not_billed');
    for (const f of [edited, refunded]) expect(await f.switchInvoices()).toEqual([]);
  });
  it('refuses an upgrade now between plans that carry different tax rates, and allows it on the next billing date', async () => {
    const f = await setup(), tax = await factory('taxRates', f.gymId), taxed = await f.newPlan({ amountCents: 13_000 });
    await factory('planTaxRates', f.gymId, { planId: taxed.id, taxRateId: tax.id });
    refused(await f.preview(taxed.id), 'tax_change');
    refused(await f.switchNow(taxed.id), 'tax_change');
    expect((await f.preview(taxed.id, 'next_billing_date')).status).toBe(200);
    // The same rates on both plans upgrade now as before.
    await factory('planTaxRates', f.gymId, { planId: f.plan.id, taxRateId: tax.id });
    expect((await f.switchNow(taxed.id)).status).toBe(200);
    expect(await f.switchInvoices()).toHaveLength(1);
  });
});

describe('switch routes', () => {
  it('schedules and cancels a switch for the next billing date', async () => {
    const f = await setup(), premium = await f.newPlan({ amountCents: 13_000 });
    const scheduled = await f.switchNow(premium.id, { timing: undefined });
    expect(scheduled.body.data).toMatchObject({ invoiceId: null, membership: { planId: f.plan.id, scheduledPlanId: premium.id, scheduledOn: '2028-04-01' } });
    expect((await f.preview(premium.id, 'next_billing_date')).body.data).toEqual({ planId: premium.id, timing: 'next_billing_date', kind: 'upgrade',
      currency: 'CAD', priceStartsOn: '2028-04-01', commitmentBlocks: false, discount: 'none', proration: null });
    const revision = (await f.row()).revision;
    expect((await f.call('POST', f.path() + '/switch/cancel', { revision: revision - 1 })).status).toBe(409);
    const cancelled = await f.call('POST', f.path() + '/switch/cancel', { revision });
    expect(cancelled).toMatchObject({ status: 200, body: { data: { scheduledPlanId: null, revision: revision + 1 } } });
    refused(await f.call('POST', f.path() + '/switch/cancel', { revision: revision + 1 }), 'none_scheduled');
    expect(await f.switchInvoices()).toEqual([]);
  });
  it('refuses a PATCH with a plan or interval and still saves a custom price', async () => {
    const f = await setup(), premium = await f.newPlan({ amountCents: 13_000 }), revision = (await f.row()).revision;
    for (const change of [{ planId: premium.id }, { interval: 'annual' }, { planId: premium.id, price: { amountCents: 9_000, currency: 'CAD' } }])
      expect((await f.call('PATCH', f.path(), { revision, ...change })).status).toBe(400);
    const saved = await f.call('PATCH', f.path(), { revision, price: { amountCents: 9_000, currency: 'CAD' } });
    expect(saved).toMatchObject({ status: 200, body: { data: { planId: f.plan.id, amountCents: 9_000, revision: revision + 1 } } });
  });
  it('allows owners and admins and refuses coaches and front desk', async () => {
    const f = await setup(), premium = await f.newPlan({ amountCents: 13_000 });
    for (const role of ['coach', 'front_desk'] as const) {
      expect((await f.call('POST', f.path() + '/switch', await f.switchBody(premium.id), role)).status).toBe(403);
      expect((await f.preview(premium.id, 'now', f.membership.id, role)).status).toBe(403);
      expect((await f.call('POST', f.path() + '/switch/cancel', { revision: (await f.row()).revision }, role)).status).toBe(403);
    }
    expect(await f.switchInvoices()).toEqual([]);
    for (const role of ['owner', 'admin'] as const) {
      expect((await f.preview(premium.id, 'next_billing_date', f.membership.id, role)).status).toBe(200);
      expect((await f.switchNow(premium.id, { timing: 'next_billing_date' }, f.membership.id, role)).status).toBe(200);
      expect((await f.call('POST', f.path() + '/switch/cancel', { revision: (await f.row()).revision }, role)).status).toBe(200);
    }
  });
  it('keeps gyms apart: gym A can\'t switch, preview or cancel gym B\'s membership, or use gym B\'s plan', async () => {
    const a = await setup(), b = await setup(), planA = await a.newPlan({ amountCents: 13_000 }), planB = await b.newPlan({ amountCents: 13_000 });
    const foreign = a.path(b.membership.id);
    expect((await a.call('POST', foreign + '/switch', { revision: 1, requestId: uuidv7(), planId: planA.id, timing: 'now' })).status).toBe(404);
    expect((await a.call('GET', `${foreign}/switch/preview?planId=${planA.id}&timing=now`)).status).toBe(404);
    expect((await a.call('POST', foreign + '/switch/cancel', { revision: 1 })).status).toBe(404);
    expect((await a.switchNow(planB.id)).status).toBe(404);
    expect((await a.preview(planB.id)).status).toBe(404);
    for (const f of [a, b]) {
      expect(await f.row()).toMatchObject({ planId: f.plan.id, scheduledPlanId: null });
      expect(await f.switchInvoices()).toEqual([]);
    }
  });
});
