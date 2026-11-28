// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- PostgreSQL lock probes make the erasure race deterministic.
import { eq, sql } from 'drizzle-orm';
import { auditEvents, households, leads, members, memberships, RevisionConflictError, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { zonedInstant } from '@plaingym/shared/time';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService, type AssignmentBilling } from './memberships.js';
import { createMembershipJobs } from './memberships.jobs.js';
import { createMembersService } from '../members/members.js';
import { FakeJobs } from '../../infra/jobs/index.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(initialStatus: 'pending' | 'trial' | 'active' = 'pending') {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'CAD', timezone: 'America/Vancouver' });
  const clock = new TestClock('2028-01-15T12:00:00Z'), context = { gymId, actor: { kind: 'system' as const } };
  const home = await factory('households', gymId, { billingDay: 31 });
  const member = await factory('members', gymId, { householdId: home.id, status: initialStatus === 'pending' ? 'prospect' : initialStatus });
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
    const changed = await f.service.update(f.context, { membershipId: f.membership.id, revision: 1,
      price: { amountCents: 9000, currency: 'CAD' }, nextDueOn: '2028-03-31' });
    expect(changed).toMatchObject({ planId: f.plan.id, commitmentEndsOn: '2028-02-29', amountCents: 9000, interval: 'monthly', nextDueOn: '2028-03-31', revision: 2 });
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
  it('promotes a staff-set trial member at trial end with one revision-guarded audit', async () => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial', revision: 4 }).where(eq(members.id, f.member.id)));
    const midnight = zonedInstant('2028-02-07', '00:00', 'America/Vancouver', { gap: 'shift' })!;
    f.clock.set(new Date(midnight.getTime() - 1));
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(0);
    f.clock.advance(1);
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(0);
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'active', revision: 5 });
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.member.id)));
    expect(events).toMatchObject([{ action: 'billing.member.activated', actorKind: 'system', occurredAt: f.clock.now(),
      before: { status: 'trial', revision: 4 }, after: { status: 'active', revision: 5 } }]);
  });
  it('makes a member active when any trial ends, ignoring another member and gym', async () => {
    const f = await fixture('trial'), foreign = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    const second = await f.service.assign(f.context, { ...f.request, id: uuidv7(), trialEndsOn: '2028-02-10' });
    const sibling = await factory('members', f.gymId, { householdId: f.home.id, status: 'trial' });
    await f.service.assign(f.context, { ...f.request, id: uuidv7(), memberId: sibling.id, trialEndsOn: '2028-02-20' });
    f.clock.set('2028-02-07T08:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'active', revision: 2 });
    expect((await f.service.get(f.gymId, second.id)).status).toBe('trial');
    f.clock.set('2028-02-10T08:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'active', revision: 2 });
    expect((await foreign.service.get(foreign.gymId, foreign.membership.id)).status).toBe('trial');
  });
  it('serializes concurrent sibling trial activations and promotes the member once', async () => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    const second = await f.service.assign(f.context, { ...f.request, id: uuidv7() });
    await Promise.all([f.membership, second].map(m => f.service.activate(f.context, { membershipId: m.id, revision: m.revision })));
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'active', revision: 2 });
    expect((await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.member.id)))))
      .toMatchObject([{ action: 'billing.member.activated' }]);
  });
  it('makes a frozen member active when their trial resumes', async () => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    const frozen = await f.service.freeze(f.context, { membershipId: f.membership.id, revision: 1 });
    await f.service.activate(f.context, { membershipId: frozen.id, revision: frozen.revision });
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'active', revision: 3 });
  });
  it.each(['trial', 'frozen'] as const)('cancelling the last %s promotes a member with another active membership', async status => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    let second = await f.service.assign(f.context, { ...f.request, id: uuidv7() });
    if (status === 'frozen') second = await f.service.freeze(f.context, { membershipId: second.id, revision: second.revision });
    await f.service.activate(f.context, { membershipId: f.membership.id, revision: 1 });
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0]!.status).toBe('active');
    await f.service.cancel(f.context, { membershipId: second.id, revision: second.revision });
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'active', revision: 2 });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.member.id))))
      .toMatchObject([{ action: 'billing.member.activated' }]);
  });
  it('cancels a member when cancellation leaves only cancelled memberships', async () => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    await f.service.cancel(f.context, { membershipId: f.membership.id, revision: 1 });
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'cancelled', revision: 2 });
  });
  it('a frozen previously active trial does not hold back another activation', async () => {
    const f = await fixture('trial');
    await f.service.activate(f.context, { membershipId: f.membership.id, revision: 1 });
    await f.service.freeze(f.context, { membershipId: f.membership.id, revision: 2 });
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    const second = await f.service.assign(f.context, { ...f.request, id: uuidv7() });
    await f.service.activate(f.context, { membershipId: second.id, revision: second.revision });
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0]!.status).toBe('active');
  });
  it.each(['activation', 'erasure'] as const)('races erasure with trial activation without a deadlock, starting %s first', async first => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    const people = createMembersService(f.options), cleanup = { jobs: new FakeJobs(f.clock), timezone: 'America/Vancouver' };
    const activate = () => f.service.activate(f.context, { membershipId: f.membership.id, revision: 1 });
    const erase = () => people.eraseMember(f.context, f.member.id, { revision: 1 }, cleanup);
    const results = await Promise.allSettled(first === 'activation' ? [activate(), erase()] : [erase(), activate()]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    for (const result of results) if (result.status === 'rejected') {
      if (!(result.reason instanceof RevisionConflictError)) expect(result.reason).toMatchObject({ code: 'conflict' });
    }
    const person = await people.getMember(f.gymId, f.member.id);
    if (!person.anonymizedAt) await people.eraseMember(f.context, person.id, { revision: person.revision }, cleanup);
    expect(await f.service.get(f.gymId, f.membership.id)).toMatchObject({ status: 'cancelled' });
    expect(await people.getMember(f.gymId, f.member.id)).toMatchObject({ status: 'cancelled', anonymizedAt: f.clock.now().toISOString() });
  });
  it('erasure waits on an activating household before locking its member', async () => {
    const f = await fixture('trial'), locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    const activating = createMembershipService({ ...f.options, scope: (gymId, work) => db.forGym(gymId, async tx => {
      await tx.select().from(households).where(eq(households.id, f.home.id)).for('update');
      // eslint-disable-next-line database/system-tables -- Identify the household lock holder for the wait probe.
      locked.resolve((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await release.promise;
      // A waiting erasure must not hold this member while it waits for our household.
      await tx.select().from(members).where(eq(members.id, f.member.id)).for('update', { noWait: true });
      return work(tx);
    }) }).activate(f.context, { membershipId: f.membership.id, revision: 1 });
    const pid = await locked.promise, people = createMembersService(f.options);
    const cleanup = { jobs: new FakeJobs(f.clock), timezone: 'America/Vancouver' };
    const erasing = people.eraseMember(f.context, f.member.id, { revision: 1 }, cleanup);
    const results = Promise.allSettled([activating, erasing]);
    try {
      await expect.poll(async () => {
        // eslint-disable-next-line database/system-tables -- Both gym connections are busy; inspect their blocking from the system pool.
        const rows = await db.system.db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        ) as waiting`);
        return rows[0]!.waiting;
      }, { timeout: 10_000, interval: 10 }).toBe(true);
    } finally { release.resolve(); await results; }
    const [activation, erasure] = await results;
    expect(activation.status).toBe('fulfilled');
    expect(erasure).toMatchObject({ status: 'rejected', reason: { name: 'RevisionConflictError' } });
    const person = await people.getMember(f.gymId, f.member.id);
    await people.eraseMember(f.context, person.id, { revision: person.revision }, cleanup);
    expect(await f.service.get(f.gymId, f.membership.id)).toMatchObject({ status: 'cancelled' });
  });
  it.each(['prospect', 'active', 'frozen', 'cancelled', 'visitor'])('reconciles a staff-set member status of %s at trial end', async status => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status }).where(eq(members.id, f.member.id)));
    f.clock.set('2028-02-07T08:00:00Z');
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'active', revision: status === 'active' ? 1 : 2 });
  });
  it('rolls back the membership, member promotion and audits together', async () => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    const service = createMembershipService({ ...f.options, scope: (gymId, fn) => db.forGym(gymId, async tx => {
      await fn(tx); throw new Error('transaction interrupted');
    }) });
    await expect(service.activate(f.context, { membershipId: f.membership.id, revision: 1 })).rejects.toThrow('transaction interrupted');
    expect(await f.service.get(f.gymId, f.membership.id)).toMatchObject({ status: 'trial', revision: 1 });
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'trial', revision: 1 });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.member.id)))).toEqual([]);
  });
  it('leaves the member trial when a stale membership revision refuses activation', async () => {
    const f = await fixture('trial');
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'trial' }).where(eq(members.id, f.member.id)));
    await f.service.update(f.context, { membershipId: f.membership.id, revision: 1, price: { amountCents: 9000, currency: 'CAD' } });
    await expect(f.service.activate(f.context, { membershipId: f.membership.id, revision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0])
      .toMatchObject({ status: 'trial', revision: 1 });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.member.id)))).toEqual([]);
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
    const input = { memberId: member.id, householdId: f.home.id, planId: f.plan.id, startsOn: '2028-01-20' };
    await expect(f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-30' })).rejects.toMatchObject({
      code: 'conflict', message: 'Use the household next billing date', details: { reason: ['household_billing_date'] },
    });
    const assigned = await f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-31', firstPeriod: 'next_billing_date' });
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
    await expect(f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-31' })).rejects.toMatchObject({
      code: 'conflict', message: 'A new household starts billing on its join date', details: { reason: ['household_join_date'] },
    });
    expect(await f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-20' })).toMatchObject({ status: 'trial', nextDueOn: '2028-01-27' });
    expect((await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.home.id))))[0]?.billingDay).toBe(27);
  });
  it('reports inactive plans and billing before the start at assignment', async () => {
    const f = await fixture();
    const inactive = await factory('plans', f.gymId, { active: false });
    const input = { memberId: f.member.id, householdId: f.home.id, planId: f.plan.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31' };
    await expect(f.service.assignFromCatalog(f.context, { ...input, planId: inactive.id })).rejects.toMatchObject({
      code: 'conflict', message: 'Plan is inactive', details: { reason: ['plan_inactive'] },
    });
    await expect(f.service.assignFromCatalog(f.context, { ...input, nextDueOn: '2028-01-30' })).rejects.toMatchObject({
      code: 'conflict', message: 'Billing cannot start before membership starts', details: { reason: ['billing_before_start'] },
    });
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
    const edit = { membershipId: cancelled.id, revision: cancelled.revision };
    await expect(f.service.activate(f.context, edit)).rejects.toMatchObject({
      code: 'conflict', message: 'Membership cannot be activated', details: { reason: ['membership_status'] },
    });
    await expect(f.service.update(f.context, { ...edit, price: { amountCents: 9000, currency: 'CAD' } })).rejects.toMatchObject({
      code: 'conflict', message: 'Cancelled membership cannot be edited', details: { reason: ['membership_cancelled'] },
    });
    await expect(f.service.cancel(f.context, edit)).rejects.toMatchObject({
      code: 'conflict', message: 'Membership is already cancelled', details: { reason: ['membership_cancelled'] },
    });
    expect(await f.service.get(f.gymId, cancelled.id)).toEqual(cancelled);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, cancelled.id)))).toHaveLength(2);
  });
  it('reports a freeze refused before activation', async () => {
    const f = await fixture();
    await expect(f.service.freeze(f.context, { membershipId: f.membership.id, revision: f.membership.revision })).rejects.toMatchObject({
      code: 'conflict', message: 'Membership cannot be frozen', details: { reason: ['membership_status'] },
    });
  });
  it('reports a freeze ending today and an activation of an already active membership', async () => {
    const f = await fixture('active');
    const edit = { membershipId: f.membership.id, revision: f.membership.revision };
    await expect(f.service.freeze(f.context, { ...edit, resumesOn: '2028-01-15' })).rejects.toMatchObject({
      code: 'conflict', message: 'Resume date must be in the future', details: { reason: ['resume_not_future'] },
    });
    await expect(f.service.activate(f.context, edit)).rejects.toMatchObject({
      code: 'conflict', message: 'Membership cannot be activated', details: { reason: ['membership_status'] },
    });
  });
  it('registers a daily date processor with gym timezone and no payment calls', async () => {
    const f = await fixture('trial'); f.clock.set('2028-02-07T08:00:00Z');
    const [job] = createMembershipJobs(() => f.service);
    expect(job?.cron).toBe('0 0 * * *');
    await job!.handler({}, { jobId: uuidv7(), gymId: f.gymId, timezone: 'America/Vancouver', attempt: 1, clock: f.clock });
    expect((await f.service.get(f.gymId, f.membership.id)).status).toBe('active');
  });
});

describe('freezing an annual membership against PostgreSQL', () => {
  // Gym time is America/Vancouver: 20:00Z is noon there.
  async function annual(nextDueOn = '2027-03-01', initialStatus: 'active' | 'trial' = 'active', startsOn = '2027-02-01') {
    const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'CAD', timezone: 'America/Vancouver' });
    const clock = new TestClock(`${startsOn}T20:00:00Z`), context = { gymId, actor: { kind: 'system' as const } };
    const home = await factory('households', gymId, { billingDay: 1 });
    const member = await factory('members', gymId, { householdId: home.id, status: initialStatus });
    const plan = await factory('plans', gymId, { interval: 'annual', amountCents: 120000 });
    const service = createMembershipService({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) });
    const membership = await service.assign(context, { id: uuidv7(), memberId: member.id, householdId: home.id, planId: plan.id,
      startsOn, nextDueOn, firstPeriod: 'next_billing_date', initialStatus,
      ...(initialStatus === 'trial' ? { trialEndsOn: '2027-02-15' } : {}) });
    const read = async () => (await db.forGym(gymId, tx => tx.select().from(memberships).where(eq(memberships.id, membership.id))))[0]!;
    const frozenAt = async (now: string | Date, resumesOn?: string) => {
      clock.set(now);
      return service.freeze(context, { membershipId: membership.id, revision: (await read()).revision, ...(resumesOn ? { resumesOn } : {}) });
    };
    const resume = async (now: string | Date, nextDueOn?: string) => {
      clock.set(now);
      return service.activate(context, { membershipId: membership.id, revision: (await read()).revision, ...(nextDueOn ? { nextDueOn } : {}) });
    };
    return { gymId, clock, context, member, service, membership, read, frozenAt, resume };
  }
  it('keeps the date on freeze and moves it and the anniversary by the days frozen on resume', async () => {
    const f = await annual();
    expect((await f.read()).anniversaryOn).toBe('2027-03-01');
    const frozen = await f.frozenAt('2027-02-10T20:00:00Z');
    expect(frozen).toMatchObject({ status: 'frozen', nextDueOn: '2027-03-01', frozenAt: '2027-02-10T20:00:00.000Z' });
    expect((await f.read()).anniversaryOn).toBe('2027-03-01');
    const resumed = await f.resume('2027-02-24T20:00:00Z');
    expect(resumed).toMatchObject({ status: 'active', nextDueOn: '2027-03-15', frozenAt: null, resumesOn: null });
    expect((await f.read()).anniversaryOn).toBe('2027-03-15');
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.membership.id)));
    expect(audits.map(event => event.action).toSorted()).toEqual(['billing.membership.activated', 'billing.membership.assigned', 'billing.membership.frozen']);
  });
  it('counts local calendar days: none on the same day, one across local midnight within one UTC date', async () => {
    const local = (date: string, time: string) => zonedInstant(date, time, 'America/Vancouver', { gap: 'shift' })!;
    const same = await annual();
    await same.frozenAt(local('2027-02-10', '00:30'));
    expect(await same.resume(local('2027-02-10', '23:30'))).toMatchObject({ nextDueOn: '2027-03-01' });
    expect((await same.read()).anniversaryOn).toBe('2027-03-01');
    const midnight = await annual();
    const frozenAt = local('2027-02-10', '23:30'), resumedAt = local('2027-02-11', '00:30');
    expect(frozenAt.toISOString().slice(0, 10)).toBe(resumedAt.toISOString().slice(0, 10));
    await midnight.frozenAt(frozenAt);
    expect(await midnight.resume(resumedAt)).toMatchObject({ nextDueOn: '2027-03-02' });
  });
  it.each(['2027-04-10T08:00:00Z', '2027-04-13T20:00:00Z'])('ends the days of a timed freeze on its resume date when the date job runs at %s', async now => {
    const f = await annual();
    expect(await f.frozenAt('2027-02-10T20:00:00Z', '2027-04-10')).toMatchObject({ nextDueOn: '2027-03-01', resumesOn: '2027-04-10' });
    f.clock.set(now);
    expect(await f.service.processDates(f.gymId, 'America/Vancouver')).toBe(1);
    // 2027-02-10 to 2027-04-10 is 59 days.
    expect(await f.service.get(f.gymId, f.membership.id)).toMatchObject({ status: 'active', nextDueOn: '2027-04-29' });
  });
  it('bills a membership already past due when frozen on its resume date', async () => {
    const f = await annual('2027-02-01');
    await f.frozenAt('2027-02-10T20:00:00Z');
    expect(await f.resume('2027-02-24T20:00:00Z')).toMatchObject({ nextDueOn: '2027-02-24' });
  });
  it.each([['2027-03-14', false], ['2027-03-15', true], ['2027-04-14', true]] as const)('takes a staff resume date %s only from the shifted date on (%s)', async (nextDueOn, accepted) => {
    const f = await annual();
    await f.frozenAt('2027-02-10T20:00:00Z');
    const result = f.resume('2027-02-24T20:00:00Z', nextDueOn);
    if (accepted) {
      expect(await result).toMatchObject({ status: 'active', nextDueOn });
      expect((await f.read()).anniversaryOn).toBe(nextDueOn);
    } else {
      await expect(result).rejects.toMatchObject({ code: 'conflict', details: { reason: ['resume_skips_cycle'] } });
      expect(await f.read()).toMatchObject({ status: 'frozen', nextDueOn: '2027-03-01' });
    }
  });
  // Past due when frozen: 2026-10-01 to 2026-11-27 is 57 days, so the shifted date 2026-10-28 is before today.
  it.each([['2026-11-01', false], ['2026-11-26', false], ['2026-11-27', true], ['2026-12-01', true], [undefined, true]] as const)(
    'never takes a staff resume date %s before today, even when the shifted date is earlier (%s)', async (nextDueOn, accepted) => {
      const f = await annual('2026-09-01', 'active', '2026-08-01');
      await f.frozenAt('2026-10-01T20:00:00Z');
      const result = f.resume('2026-11-27T20:00:00Z', nextDueOn);
      if (accepted) {
        expect(await result).toMatchObject({ status: 'active', nextDueOn: nextDueOn ?? '2026-11-27' });
      } else {
        await expect(result).rejects.toMatchObject({ code: 'conflict', details: { reason: ['resume_skips_cycle'] } });
        expect(await f.read()).toMatchObject({ status: 'frozen', nextDueOn: '2026-09-01' });
      }
    });
  // A scheduled resume on 2026-11-20 run late on 2026-11-27: the 50 days frozen shift the date to 2026-10-21 only.
  it.each([['2026-11-19', false], ['2026-11-20', true]] as const)(
    'takes a late scheduled resume\'s date %s only from the scheduled resume date on (%s)', async (nextDueOn, accepted) => {
      const f = await annual('2026-09-01', 'active', '2026-08-01');
      await f.frozenAt('2026-10-01T20:00:00Z', '2026-11-20');
      const result = f.resume('2026-11-27T20:00:00Z', nextDueOn);
      if (accepted) expect(await result).toMatchObject({ status: 'active', nextDueOn });
      else await expect(result).rejects.toMatchObject({ code: 'conflict', details: { reason: ['resume_skips_cycle'] } });
    });
  it.each([['2028-03-01', '2027-03-15'], ['2029-03-01', '2027-03-15'], ['2027-06-01', '2027-06-15']])(
    'resumes a freeze made when a freeze skipped a year, with the row at %s, from the date before it', async (rowDueOn, resumedDueOn) => {
      const f = await annual();
      await f.frozenAt('2027-02-10T20:00:00Z');
      // The release before this one moved the date on by a year when freezing, and audited that move.
      await db.forGym(f.gymId, async tx => {
        await tx.update(memberships).set({ nextDueOn: rowDueOn }).where(eq(memberships.id, f.membership.id));
        await writeAudit(tx, { gymId: f.gymId, actorKind: 'system', action: 'billing.membership.frozen', targetType: 'membership',
          targetId: f.membership.id, before: { nextDueOn: '2027-03-01' }, after: { nextDueOn: '2028-03-01' }, occurredAt: f.clock.now() });
      });
      expect(await f.resume('2027-02-24T20:00:00Z')).toMatchObject({ status: 'active', nextDueOn: resumedDueOn });
    });
  it('moves a frozen trial\'s first bill by the days frozen and wins its lead on resume', async () => {
    const f = await annual('2027-02-15', 'trial');
    expect(f.membership).toMatchObject({ status: 'trial', nextDueOn: '2027-02-15' });
    await f.frozenAt('2027-02-05T20:00:00Z');
    expect(await f.resume('2027-02-15T20:00:00Z')).toMatchObject({ status: 'active', nextDueOn: '2027-02-25' });
    const rows = await db.forGym(f.gymId, tx => tx.select().from(leads).where(eq(leads.memberId, f.member.id)));
    expect(rows).toMatchObject([{ stage: 'won', wonAt: f.clock.now() }]);
  });
});
