// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { members, memberships, plans, uuidv7 } from '@plaingym/db';
import { createMembershipService } from './memberships.js';
import { commitmentBlocks, planSwitchedAction, switchCancelledAction, switchKind, switchScheduledAction,
  type SwitchPlanRequest } from './memberships.plan-change.js';
import { useRunnerFixture, type FixtureOptions } from './runner/runner.fixture.test-helper.js';

const { db, factory, fixture } = useRunnerFixture();
/** The runner fixture (a household billed on the 1st, a $100 monthly membership, a saved card) plus staff and the lifecycle. */
async function setup(options: FixtureOptions = {}) {
  const f = await fixture(options);
  const service = createMembershipService(f.serviceOptions);
  const user = await factory('authUser', f.gymId);
  const staff = { gymId: f.gymId, actor: { kind: 'user' as const, userId: user.id } };
  const row = async (id = f.membership.id) => (await f.read()).memberships.find(m => m.id === id)!;
  const newPlan = (overrides: Record<string, unknown> = {}) => factory('plans', f.gymId, { name: 'Plan ' + uuidv7(), ...overrides });
  async function switchTo(planId: string, overrides: Partial<SwitchPlanRequest> = {}, id = f.membership.id) {
    return service.switchPlan(staff, { membershipId: id, revision: (await row(id)).revision, requestId: uuidv7(), planId,
      timing: 'next_billing_date', ...overrides });
  }
  /** Runs the daily build and collection at 09:00 Vancouver time on `date`. */
  async function dailyOn(date: string) { f.clock.set(date + 'T17:00:00Z'); return f.runner.daily(f.gymId); }
  async function billed() {
    const state = await f.read();
    return state.lines.filter(line => line.kind === 'membership').map(line => ({ dueOn: state.invoices.find(i => i.id === line.invoiceId)!.dueOn,
      membershipId: line.membershipId, planId: line.planId, amountCents: line.amountCents })).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  }
  const audits = async (action: string) => (await f.read()).audits.filter(a => a.action === action);
  return { ...f, service, user, staff, row, newPlan, switchTo, dailyOn, billed, audits };
}
const conflictReason = (reason: string) => ({ code: 'conflict', details: { reason: [reason] } });

describe('plan switch rules', () => {
  it('compares prices per year and blocks only a downgrade before the commitment ends', () => {
    expect(switchKind({ amountCents: 10_000, interval: 'monthly' }, { amountCents: 100_000, interval: 'annual' })).toBe('downgrade');
    expect(switchKind({ amountCents: 10_000, interval: 'monthly' }, { amountCents: 120_000, interval: 'annual' })).toBe('equal');
    expect(switchKind({ amountCents: 100_000, interval: 'annual' }, { amountCents: 9_000, interval: 'monthly' })).toBe('upgrade');
    expect(switchKind({ amountCents: 10_000, interval: 'monthly' }, { amountCents: 9_999, interval: 'monthly' })).toBe('downgrade');
    expect(commitmentBlocks('downgrade', '2028-06-01', '2028-05-31')).toBe(true);
    expect(commitmentBlocks('downgrade', '2028-06-01', '2028-06-01')).toBe(false);
    expect(commitmentBlocks('downgrade', null, '2028-05-31')).toBe(false);
    expect(commitmentBlocks('upgrade', '2028-06-01', '2028-05-31')).toBe(false);
    expect(commitmentBlocks('equal', '2028-06-01', '2028-05-31')).toBe(false);
  });
});

describe('scheduled plan switch against PostgreSQL and the charge runner', () => {
  it('schedules on the next billing date and applies once at that cycle, with two runs the same day', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' }), next = await f.newPlan({ amountCents: 12_000 });
    const before = await f.row();
    const scheduled = await f.switchTo(next.id);
    expect(scheduled).toMatchObject({ planId: f.plan.id, amountCents: 10_000, scheduledPlanId: next.id, scheduledAmountCents: 12_000,
      scheduledInterval: 'monthly', scheduledOn: '2028-03-01', revision: before.revision + 1 });
    expect(scheduled).not.toHaveProperty('switchOverrideReason');
    const [event] = await f.audits(switchScheduledAction);
    expect(event).toMatchObject({ actorKind: 'user', actorUserId: f.user.id, targetId: f.membership.id,
      after: { request: { planId: next.id, timing: 'next_billing_date', override: false }, overrideUsed: false, membership: scheduled } });
    // Later price changes on the plan don't alter the quoted price.
    await db.forGym(f.gymId, tx => tx.update(plans).set({ amountCents: 15_000 }).where(eq(plans.id, next.id)));
    await f.dailyOn('2028-02-29');
    expect(await f.billed()).toEqual([]);
    await f.dailyOn('2028-03-01'); await f.dailyOn('2028-03-01');
    expect(await f.billed()).toEqual([{ dueOn: '2028-03-01', membershipId: f.membership.id, planId: next.id, amountCents: 12_000 }]);
    expect(await f.row()).toMatchObject({ planId: next.id, amountCents: 12_000, interval: 'monthly', nextDueOn: '2028-04-01',
      scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null, revision: before.revision + 3 });
    const switched = await f.audits(planSwitchedAction);
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ actorKind: 'system', actorUserId: null,
      before: { planId: f.plan.id, amountCents: 10_000, interval: 'monthly', revision: before.revision + 1 },
      after: { planId: next.id, amountCents: 12_000, interval: 'monthly', dueOn: '2028-03-01', scheduledOn: '2028-03-01', revision: before.revision + 2 } });
    await f.dailyOn('2028-04-01');
    expect((await f.billed()).map(line => [line.dueOn, line.planId, line.amountCents])).toEqual([
      ['2028-03-01', next.id, 12_000], ['2028-04-01', next.id, 12_000]]);
    expect(await f.audits(planSwitchedAction)).toHaveLength(1);
  });
  it('applies once when two daily runs build the same cycle at once', async () => {
    const f = await setup(), next = await f.newPlan({ amountCents: 12_000 });
    await f.switchTo(next.id);
    await Promise.all([f.runner.daily(f.gymId), f.runner.daily(f.gymId)]);
    expect(await f.billed()).toEqual([{ dueOn: '2028-03-01', membershipId: f.membership.id, planId: next.id, amountCents: 12_000 }]);
    expect((await f.read()).invoices.filter(i => i.kind === 'cycle')).toHaveLength(1);
    expect(await f.audits(planSwitchedAction)).toHaveLength(1);
    expect(await f.row()).toMatchObject({ planId: next.id, scheduledPlanId: null, nextDueOn: '2028-04-01' });
  });
  it('after missed days, bills the cycle before the switch date on the old plan and every cycle from it on the new one', async () => {
    const f = await setup({ now: '2028-03-15T17:00:00Z', dueOn: '2028-04-01' }), next = await f.newPlan({ amountCents: 12_000 });
    await f.switchTo(next.id);
    // Staff move the due date back a cycle; the switch keeps its date.
    const moved = await f.service.update(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision, nextDueOn: '2028-03-01' });
    expect(moved).toMatchObject({ nextDueOn: '2028-03-01', scheduledPlanId: next.id, scheduledOn: '2028-04-01' });
    await f.dailyOn('2028-05-03');
    expect((await f.billed()).map(line => [line.dueOn, line.planId, line.amountCents])).toEqual([
      ['2028-03-01', f.plan.id, 10_000], ['2028-04-01', next.id, 12_000], ['2028-05-01', next.id, 12_000]]);
    expect(await f.audits(planSwitchedAction)).toMatchObject([{ after: { dueOn: '2028-04-01' } }]);
  });
  it('leaves a frozen membership\'s skipped cycle on the old plan and applies at the first cycle after the resume', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' }), next = await f.newPlan({ amountCents: 12_000 });
    const frozen = await f.service.freeze(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision, resumesOn: null });
    expect(frozen.nextDueOn).toBe('2028-04-01');
    expect(await f.switchTo(next.id)).toMatchObject({ status: 'frozen', scheduledOn: '2028-04-01' });
    await f.dailyOn('2028-04-01');
    expect(await f.billed()).toEqual([]);
    expect(await f.row()).toMatchObject({ status: 'frozen', planId: f.plan.id, nextDueOn: '2028-05-01', scheduledPlanId: next.id });
    expect(await f.audits(planSwitchedAction)).toEqual([]);
    f.clock.set('2028-04-10T17:00:00Z');
    expect(await f.service.activate(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision }))
      .toMatchObject({ status: 'active', planId: f.plan.id, nextDueOn: '2028-05-01', scheduledPlanId: next.id });
    await f.dailyOn('2028-05-01');
    expect(await f.billed()).toEqual([{ dueOn: '2028-05-01', membershipId: f.membership.id, planId: next.id, amountCents: 12_000 }]);
    expect(await f.audits(planSwitchedAction)).toHaveLength(1);
  });
  it('keeps a trial\'s or pending membership\'s switch until it is billed as active, then applies it at that first cycle', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' }), next = await f.newPlan({ amountCents: 12_000 });
    const add = async (overrides: Record<string, unknown>) => {
      const member = await factory('members', f.gymId, { householdId: f.home.id });
      return factory('memberships', f.gymId, { householdId: f.home.id, memberId: member.id, planId: f.plan.id,
        startsOn: '2028-02-15', nextDueOn: '2028-03-01', ...overrides });
    };
    const trial = await add({ status: 'trial', trialEndsOn: '2028-03-01' }), pending = await add({ status: 'pending' });
    expect(await f.switchTo(next.id, {}, trial.id)).toMatchObject({ status: 'trial', scheduledOn: '2028-03-01' });
    expect(await f.switchTo(next.id, {}, pending.id)).toMatchObject({ status: 'pending', scheduledOn: '2028-03-01' });
    f.clock.set('2028-03-01T16:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    await f.service.activate(f.staff, { membershipId: pending.id, revision: (await f.row(pending.id)).revision });
    for (const id of [trial.id, pending.id]) expect(await f.row(id)).toMatchObject({ status: 'active', planId: f.plan.id, scheduledPlanId: next.id });
    await f.dailyOn('2028-03-01');
    const lines = await f.billed();
    expect(lines.find(line => line.membershipId === f.membership.id)).toMatchObject({ planId: f.plan.id, amountCents: 10_000 });
    for (const id of [trial.id, pending.id]) {
      expect(lines.find(line => line.membershipId === id)).toMatchObject({ dueOn: '2028-03-01', planId: next.id, amountCents: 12_000 });
      expect(await f.row(id)).toMatchObject({ planId: next.id, scheduledPlanId: null, nextDueOn: '2028-04-01' });
    }
    expect(await f.audits(planSwitchedAction)).toHaveLength(2);
  });
  it('switches monthly to annual on February 29, keeping the leap-day anniversary', async () => {
    const f = await setup({ now: '2028-02-25T17:00:00Z', dueOn: '2028-02-29' });
    const annual = await f.newPlan({ interval: 'annual', amountCents: 130_000 });
    expect(await f.switchTo(annual.id)).toMatchObject({ scheduledInterval: 'annual', scheduledOn: '2028-02-29' });
    await f.dailyOn('2028-02-29');
    expect(await f.row()).toMatchObject({ planId: annual.id, interval: 'annual', amountCents: 130_000, anniversaryOn: '2028-02-29',
      nextDueOn: '2029-02-28' });
    const [cycle] = (await f.read()).invoices;
    expect(cycle).toMatchObject({ dueOn: '2028-02-29', periodStartsOn: '2028-02-29', periodEndsOn: '2029-02-28' });
    const dues: string[] = [];
    for (const date of ['2029-02-28', '2030-02-28', '2031-02-28']) { await f.dailyOn(date); dues.push((await f.row()).nextDueOn); }
    expect(dues).toEqual(['2030-02-28', '2031-02-28', '2032-02-29']);
    expect((await f.billed()).every(line => line.planId === annual.id && line.amountCents === 130_000)).toBe(true);
  });
  it('switches annual to monthly from a February 29 anniversary, joining the household\'s billing day', async () => {
    const f = await setup({ now: '2029-02-20T17:00:00Z', interval: 'annual', amount: 100_000, anniversaryOn: '2028-02-29',
      startsOn: '2028-02-29', dueOn: '2029-02-28' });
    const monthly = await f.newPlan({ amountCents: 9_000 });
    expect(await f.switchTo(monthly.id)).toMatchObject({ scheduledInterval: 'monthly', scheduledOn: '2029-02-28' });
    await f.dailyOn('2029-02-28');
    expect(await f.row()).toMatchObject({ planId: monthly.id, interval: 'monthly', amountCents: 9_000, anniversaryOn: null, nextDueOn: '2029-03-01' });
    await f.dailyOn('2029-03-01');
    // One day of February up to the household's billing day, then whole months.
    expect((await f.billed()).map(line => [line.dueOn, line.planId, line.amountCents])).toEqual([
      ['2029-02-28', monthly.id, 321], ['2029-03-01', monthly.id, 9_000]]);
  });
  it('refuses a downgrade before the commitment ends without an override, and keeps the override reason out of the audit', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' });
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ commitmentEndsOn: '2028-06-01' }).where(eq(memberships.id, f.membership.id)));
    const cheaper = await f.newPlan({ amountCents: 8_000 }), dearer = await f.newPlan({ amountCents: 12_000 });
    await expect(f.switchTo(cheaper.id)).rejects.toMatchObject(conflictReason('commitment'));
    await expect(f.switchTo(cheaper.id, { override: { reason: '' } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.switchTo(cheaper.id, { override: { reason: 'x'.repeat(501) } })).rejects.toMatchObject({ code: 'invalid_request' });
    // An upgrade is never blocked; a reason it didn't need isn't kept.
    expect(await f.switchTo(dearer.id, { override: { reason: 'Not needed' } })).toMatchObject({ scheduledPlanId: dearer.id });
    expect((await f.row()).switchOverrideReason).toBeNull();
    expect((await f.audits(switchScheduledAction)).at(-1)).toMatchObject({ after: { request: { override: true }, overrideUsed: false } });
    const reason = 'Moving across town; approved by the owner';
    const overridden = await f.switchTo(cheaper.id, { override: { reason } });
    expect(overridden).toMatchObject({ scheduledPlanId: cheaper.id, scheduledAmountCents: 8_000 });
    expect(overridden).not.toHaveProperty('switchOverrideReason');
    expect((await f.row()).switchOverrideReason).toBe(reason);
    const events = await f.audits(switchScheduledAction);
    expect(events.at(-1)).toMatchObject({ actorKind: 'user', actorUserId: f.user.id, after: { request: { planId: cheaper.id, override: true }, overrideUsed: true } });
    expect(JSON.stringify((await f.read()).audits)).not.toContain('approved by the owner');
    // On the commitment's last day (and after) a downgrade needs no override; a switch without one drops the earlier reason.
    f.clock.set('2028-06-01T17:00:00Z');
    const lower = await f.newPlan({ amountCents: 7_000 });
    expect(await f.switchTo(lower.id)).toMatchObject({ scheduledPlanId: lower.id });
    expect((await f.row()).switchOverrideReason).toBeNull();
  });
  it('keeps an applied override\'s reason on the membership and clears a scheduled one\'s when it is cancelled', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' });
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ commitmentEndsOn: '2028-12-01' }).where(eq(memberships.id, f.membership.id)));
    const cheaper = await f.newPlan({ amountCents: 8_000 }), cheapest = await f.newPlan({ amountCents: 7_000 });
    await f.switchTo(cheaper.id, { override: { reason: 'Hardship' } });
    await f.dailyOn('2028-03-01');
    expect(await f.row()).toMatchObject({ planId: cheaper.id, scheduledPlanId: null, switchOverrideReason: 'Hardship' });
    await f.switchTo(cheapest.id, { override: { reason: 'Further hardship' } });
    await f.service.cancelScheduledSwitch(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision });
    expect(await f.row()).toMatchObject({ planId: cheaper.id, scheduledPlanId: null, switchOverrideReason: null });
  });
  it('replays a request ID, and conflicts on a reused ID with other parameters or a stale revision', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' }), next = await f.newPlan({ amountCents: 12_000 }), other = await f.newPlan({ amountCents: 13_000 });
    const revision = (await f.row()).revision, requestId = uuidv7();
    const request = { membershipId: f.membership.id, revision, requestId, planId: next.id, timing: 'next_billing_date' as const };
    const [first, second] = await Promise.all([f.service.switchPlan(f.staff, request), f.service.switchPlan(f.staff, request)]);
    expect(second).toEqual(first);
    // A retry after a lost response carries the old revision and still replays without writing.
    expect(await f.service.switchPlan(f.staff, request)).toEqual(first);
    expect(await f.audits(switchScheduledAction)).toHaveLength(1);
    expect((await f.row()).revision).toBe(revision + 1);
    await expect(f.service.switchPlan(f.staff, { ...request, planId: other.id })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.switchPlan(f.staff, { ...request, override: { reason: 'Different' } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.switchPlan(f.staff, { ...request, requestId: uuidv7(), planId: other.id })).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.audits(switchScheduledAction)).toHaveLength(1);
    // A new switch replaces the scheduled one.
    expect(await f.switchTo(other.id)).toMatchObject({ scheduledPlanId: other.id, scheduledAmountCents: 13_000 });
    await f.dailyOn('2028-03-01');
    expect(await f.billed()).toMatchObject([{ planId: other.id, amountCents: 13_000 }]);
  });
  it('cancels a scheduled switch, and cancelling or changing the membership\'s plan drops it', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' }), next = await f.newPlan({ amountCents: 12_000 }), other = await f.newPlan({ amountCents: 9_000 });
    await expect(f.service.cancelScheduledSwitch(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision }))
      .rejects.toMatchObject(conflictReason('none_scheduled'));
    const scheduled = await f.switchTo(next.id);
    await expect(f.service.cancelScheduledSwitch(f.staff, { membershipId: f.membership.id, revision: scheduled.revision - 1 }))
      .rejects.toMatchObject({ code: 'conflict' });
    const cancelled = await f.service.cancelScheduledSwitch(f.staff, { membershipId: f.membership.id, revision: scheduled.revision });
    expect(cancelled).toMatchObject({ planId: f.plan.id, scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null,
      scheduledOn: null, revision: scheduled.revision + 1 });
    expect(await f.audits(switchCancelledAction)).toMatchObject([{ actorKind: 'user', before: { scheduledPlanId: next.id }, after: { scheduledPlanId: null } }]);
    await f.switchTo(next.id);
    const changed = await f.service.update(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision, planId: other.id });
    expect(changed).toMatchObject({ planId: other.id, scheduledPlanId: null });
    await f.switchTo(next.id);
    const repriced = await f.service.update(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision,
      price: { amountCents: 8_500, currency: 'CAD' } });
    expect(repriced).toMatchObject({ amountCents: 8_500, scheduledPlanId: next.id });
    await f.dailyOn('2028-03-01');
    expect(await f.billed()).toMatchObject([{ planId: next.id, amountCents: 12_000 }]);
    await f.switchTo(other.id);
    const ended = await f.service.cancel(f.staff, { membershipId: f.membership.id, revision: (await f.row()).revision });
    expect(ended).toMatchObject({ status: 'cancelled', scheduledPlanId: null, scheduledOn: null });
    await expect(f.switchTo(next.id)).rejects.toMatchObject(conflictReason('cancelled'));
  });
  it('refuses an inactive plan, the current plan and an erased member', async () => {
    const f = await setup({ now: '2028-02-20T17:00:00Z' });
    await expect(f.switchTo((await f.newPlan({ active: false })).id)).rejects.toMatchObject(conflictReason('plan_inactive'));
    await expect(f.switchTo(f.plan.id)).rejects.toMatchObject(conflictReason('same_plan'));
    await expect(f.switchTo(uuidv7())).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.switchPlan(f.staff, { membershipId: f.membership.id, revision: 1, requestId: uuidv7(),
      planId: f.plan.id, timing: 'now' as 'next_billing_date' })).rejects.toMatchObject({ code: 'invalid_request' });
    await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.member.id)));
    await expect(f.switchTo((await f.newPlan({ amountCents: 12_000 })).id)).rejects.toMatchObject(conflictReason('erased'));
    expect(await f.audits(switchScheduledAction)).toEqual([]);
  });
  it('keeps gyms apart: gym A can\'t switch gym B\'s membership or use gym B\'s plan', async () => {
    const a = await setup({ now: '2028-02-20T17:00:00Z' }), b = await setup({ now: '2028-02-20T17:00:00Z' });
    const planB = await b.newPlan({ amountCents: 12_000 }), planA = await a.newPlan({ amountCents: 12_000 });
    await expect(a.service.switchPlan(a.staff, { membershipId: b.membership.id, revision: 1, requestId: uuidv7(), planId: planA.id,
      timing: 'next_billing_date' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.switchTo(planB.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.service.cancelScheduledSwitch(a.staff, { membershipId: b.membership.id, revision: 1 })).rejects.toMatchObject({ code: 'not_found' });
    expect(await b.row()).toMatchObject({ scheduledPlanId: null, revision: b.membership.revision });
    expect(await a.row()).toMatchObject({ scheduledPlanId: null, revision: a.membership.revision });
  });
  it('applies a scheduled change to the current plan as a price change only', async () => {
    const f = await setup();
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ scheduledPlanId: f.plan.id, scheduledAmountCents: 8_000,
      scheduledInterval: 'monthly', scheduledOn: '2028-03-01' }).where(eq(memberships.id, f.membership.id)));
    await f.runner.daily(f.gymId);
    expect(await f.billed()).toEqual([{ dueOn: '2028-03-01', membershipId: f.membership.id, planId: f.plan.id, amountCents: 8_000 }]);
    expect(await f.row()).toMatchObject({ planId: f.plan.id, amountCents: 8_000, interval: 'monthly', scheduledPlanId: null });
  });
});
