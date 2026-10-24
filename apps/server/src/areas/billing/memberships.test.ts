// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, memberships, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService, type AssignmentBilling } from './memberships.js';
import { createMembershipJobs } from './memberships.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(initialStatus: 'pending' | 'trial' | 'active' = 'pending') {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'CAD', timezone: 'America/Vancouver' });
  const clock = new TestClock('2028-01-15T12:00:00Z'), context = { gymId, actor: { kind: 'system' as const } };
  const home = await factory('households', gymId, { billingDay: 31 });
  const member = await factory('members', gymId, { householdId: home.id });
  const plan = await factory('plans', gymId, { commitmentMonths: 1, signupFeeCents: 2500 });
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const service = createMembershipService(options);
  const request = { id: uuidv7(), memberId: member.id, householdId: home.id, planId: plan.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31', firstPeriod: 'prorate_now' as const,
    initialStatus, ...(initialStatus === 'trial' ? { trialEndsOn: '2028-02-07' } : {}) };
  const membership = await service.assign(context, request);
  return { gymId, clock, context, home, member, plan, options, service, request, membership };
}
describe('membership lifecycle against PostgreSQL', () => {
  it('anchors a new household to its join date without changing imported dates', async () => {
    const f = await fixture();
    const home = await factory('households', f.gymId, { billingDay: 1 });
    const member = await factory('members', f.gymId, { householdId: home.id });
    await f.service.assignFromCatalog(f.context, { memberId: member.id, householdId: home.id, planId: f.plan.id, startsOn: '2028-01-23', nextDueOn: '2028-01-23' });
    expect((await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, home.id))))[0]).toMatchObject({ billingDay: 23, revision: 2 });
    const imported = await f.service.assign(f.context, { ...f.request, id: uuidv7(), nextDueOn: '2028-11-15' });
    expect(imported.nextDueOn).toBe('2028-11-15');
  });
  it('snapshots price, interval, and clamped original commitment', async () => {
    const f = await fixture();
    expect(f.membership).toMatchObject({ amountCents: 10000, interval: 'monthly', commitmentEndsOn: '2028-02-29', status: 'pending', revision: 1 });
    const nextPlan = await factory('plans', f.gymId, { interval: 'annual', amountCents: 120000, commitmentMonths: 12 });
    const changed = await f.service.update(f.context, { membershipId: f.membership.id, revision: 1, planId: nextPlan.id,
      price: { amountCents: 9000, currency: 'CAD' }, interval: 'monthly', nextDueOn: '2028-03-31' });
    expect(changed).toMatchObject({ planId: nextPlan.id, commitmentEndsOn: '2028-02-29', amountCents: 9000, interval: 'monthly', nextDueOn: '2028-03-31', revision: 2 });
  });
  it('serializes repeated assignment IDs and rejects changed requests', async () => {
    const f = await fixture();
    const results = await Promise.all([f.service.assign(f.context, f.request), f.service.assign(f.context, f.request)]);
    expect(results).toEqual([f.membership, f.membership]);
    await expect(f.service.assign(f.context, { ...f.request, firstPeriod: 'next_billing_date' })).rejects.toMatchObject({ code: 'conflict' });
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.membership.id)));
    expect(events).toHaveLength(1);
  });
  it('writes proration/fee instructions and calls invoice work once in the assigning transaction', async () => {
    const f = await fixture(); let calls = 0, billing: AssignmentBilling | undefined;
    const service = createMembershipService({ ...f.options, async onAssigned(_tx, _ctx, _membership, instructions) {
      expect(() => assertNoTransaction('test')).toThrow(); calls++; billing = instructions;
    } });
    const request = { ...f.request, id: uuidv7(), firstPeriod: 'next_billing_date' as const };
    await service.assign(f.context, request); await service.assign(f.context, request);
    expect(calls).toBe(1);
    expect(billing).toMatchObject({ firstPeriod: 'next_billing_date', signupFeeCents: 2500, currency: 'CAD' });
  });
  it('rolls back membership and audit if first-period invoice work fails', async () => {
    const f = await fixture();
    const service = createMembershipService({ ...f.options, async onAssigned() { throw new Error('Invoice failed'); } });
    const request = { ...f.request, id: uuidv7() };
    await expect(service.assign(f.context, request)).rejects.toThrow('Invoice failed');
    expect(await db.forGym(f.gymId, tx => tx.select().from(memberships).where(eq(memberships.id, request.id)))).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, request.id)))).toEqual([]);
  });
  it('freezing skips the next cycle and resuming retains a 31st household anchor', async () => {
    const f = await fixture('active');
    const frozen = await f.service.freeze(f.context, { membershipId: f.membership.id, revision: 1 });
    expect(frozen).toMatchObject({ status: 'frozen', nextDueOn: '2028-02-29', frozenAt: f.clock.now().toISOString() });
    await expect(f.service.activate(f.context, { membershipId: frozen.id, revision: 2, nextDueOn: '2028-01-31' })).rejects.toMatchObject({ code: 'conflict' });
    f.clock.set('2028-03-15T12:00:00Z');
    const resumed = await f.service.activate(f.context, { membershipId: frozen.id, revision: 2 });
    expect(resumed).toMatchObject({ status: 'active', nextDueOn: '2028-03-31', frozenAt: null, resumesOn: null });
  });
  it('skips every cycle before a timed resume and audits automatic activation', async () => {
    const f = await fixture('active');
    const frozen = await f.service.freeze(f.context, { membershipId: f.membership.id, revision: 1, resumesOn: '2028-03-15' });
    expect(frozen.nextDueOn).toBe('2028-03-31');
    f.clock.set('2028-03-15T06:59:59Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(0);
    f.clock.set('2028-03-15T07:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(0);
    expect(await f.service.get(f.gymId, frozen.id)).toMatchObject({ status: 'active', nextDueOn: '2028-03-31', revision: 3 });
  });
  it('keeps cycles owed after a timed resume when the date job runs late', async () => {
    const f = await fixture('active');
    const frozen = await f.service.freeze(f.context, { membershipId: f.membership.id, revision: 1, resumesOn: '2028-03-15' });
    expect(frozen.nextDueOn).toBe('2028-03-31');
    f.clock.set('2028-05-01T12:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    expect(await f.service.get(f.gymId, frozen.id)).toMatchObject({ status: 'active', nextDueOn: '2028-03-31' });
  });
  it('freezes an off-day date to the next billing day, like the invoice engine', async () => {
    const f = await fixture('trial');
    expect(f.membership.nextDueOn).toBe('2028-02-07');
    const frozen = await f.service.freeze(f.context, { membershipId: f.membership.id, revision: 1, resumesOn: '2028-02-08' });
    expect(frozen.nextDueOn).toBe('2028-02-29');
  });
  it('keeps indefinite freezes out of the date processor', async () => {
    const f = await fixture('active');
    await f.service.freeze(f.context, { membershipId: f.membership.id, revision: 1 });
    f.clock.set('2030-01-01T12:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(0);
    expect((await f.service.get(f.gymId, f.membership.id)).status).toBe('frozen');
  });
  it('expires trials on the gym date, leaves pending alone, and drains bounded pages', async () => {
    const f = await fixture('trial');
    await f.service.assign(f.context, { ...f.request, id: uuidv7() });
    const pending = await f.service.assign(f.context, { ...f.request, id: uuidv7(), initialStatus: 'pending' });
    f.clock.set('2028-02-07T08:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver', 1)).toBe(2);
    expect((await f.service.get(f.gymId, pending.id)).status).toBe('pending');
  });
  it('uses plan trial defaults and never bills before the trial ends', async () => {
    const f = await fixture();
    const trialPlan = await factory('plans', f.gymId, { trialDays: 7 });
    const trial = await f.service.assignFromCatalog(f.context, { memberId: f.member.id, householdId: f.home.id, planId: trialPlan.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31' });
    expect(trial).toMatchObject({ status: 'trial', trialEndsOn: '2028-02-07', nextDueOn: '2028-02-07' });
  });
  it('makes a trial in an existing household due when it ends, before the household date', async () => {
    const f = await fixture('active');
    const trialPlan = await factory('plans', f.gymId, { trialDays: 7 }), member = await factory('members', f.gymId, { householdId: f.home.id });
    const trial = await f.service.assignFromCatalog(f.context, { memberId: member.id, householdId: f.home.id, planId: trialPlan.id, startsOn: '2028-01-10', nextDueOn: '2028-01-31' });
    expect(trial).toMatchObject({ status: 'trial', trialEndsOn: '2028-01-17', nextDueOn: '2028-01-17' });
  });
  it('requires household alignment for a newly added member and preserves the first-period choice', async () => {
    const f = await fixture('active'), member = await factory('members', f.gymId, { householdId: f.home.id });
    await expect(f.service.assignFromCatalog(f.context, { memberId: member.id, householdId: f.home.id, planId: f.plan.id, startsOn: '2028-01-20', nextDueOn: '2028-02-01' })).rejects.toMatchObject({ code: 'conflict' });
    const assigned = await f.service.assignFromCatalog(f.context, { memberId: member.id, householdId: f.home.id, planId: f.plan.id, startsOn: '2028-01-20', nextDueOn: '2028-01-31', firstPeriod: 'next_billing_date' });
    expect(assigned.nextDueOn).toBe('2028-01-31');
  });
  it('takes the household date from billable monthly memberships, not trial or frozen dates', async () => {
    const f = await fixture('trial'), member = await factory('members', f.gymId, { householdId: f.home.id });
    expect(f.membership.nextDueOn).toBe('2028-02-07');
    const input = { memberId: member.id, householdId: f.home.id, planId: f.plan.id, startsOn: '2028-01-20' };
    await expect(f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-02-07' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-31' })).nextDueOn).toBe('2028-01-31');
  });
  it('treats a household with only cancelled memberships as new and anchors billing after a trial', async () => {
    const f = await fixture();
    await f.service.cancel(f.context, { membershipId: f.membership.id, revision: f.membership.revision });
    const trialPlan = await factory('plans', f.gymId, { trialDays: 7 });
    const input = { memberId: f.member.id, householdId: f.home.id, planId: trialPlan.id, startsOn: '2028-01-20' };
    await expect(f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-31' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-20' })).toMatchObject({ status: 'trial', nextDueOn: '2028-01-27' });
    expect((await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.home.id))))[0]?.billingDay).toBe(27);
  });
  it('rejects foreign plans and mismatched member/household pairs', async () => {
    const f = await fixture(), other = await fixture();
    for (const changes of [{ memberId: other.member.id }, { planId: other.plan.id }, { householdId: other.home.id }])
      await expect(f.service.assign(f.context, { ...f.request, id: uuidv7(), ...changes })).rejects.toMatchObject({ code: 'not_found' });
    const anotherHome = await factory('households', f.gymId);
    await expect(f.service.assign(f.context, { ...f.request, id: uuidv7(), householdId: anotherHome.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('prevents lost edits with concurrent revisions and audits only the winning transition', async () => {
    const f = await fixture('active');
    const results = await Promise.allSettled([f.service.freeze(f.context, { membershipId: f.membership.id, revision: 1 }),
      f.service.cancel(f.context, { membershipId: f.membership.id, revision: 1 })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.service.get(f.gymId, f.membership.id)).revision).toBe(2);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.membership.id)))).toHaveLength(2);
  });
  it('keeps cancellation terminal and records commitment without enforcing it', async () => {
    const f = await fixture('active');
    const cancelled = await f.service.cancel(f.context, { membershipId: f.membership.id, revision: 1 });
    expect(cancelled).toMatchObject({ commitmentEndsOn: '2028-02-29', cancelledAt: f.clock.now().toISOString() });
    await expect(f.service.activate(f.context, { membershipId: cancelled.id, revision: 2 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.update(f.context, { membershipId: cancelled.id, revision: 2, interval: 'annual' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('registers a daily date processor with gym timezone and no payment calls', async () => {
    const f = await fixture('trial'); f.clock.set('2028-02-07T08:00:00Z');
    const [job] = createMembershipJobs(() => f.service);
    expect(job?.cron).toBe('0 0 * * *');
    await job!.handler({}, { jobId: uuidv7(), gymId: f.gymId, timezone: 'America/Vancouver', attempt: 1, clock: f.clock });
    expect((await f.service.get(f.gymId, f.membership.id)).status).toBe('active');
  });
});
