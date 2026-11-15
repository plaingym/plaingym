// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, asc, eq, like } from 'drizzle-orm';
import { auditEvents, classCreditEntries, members, memberships, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { MemberStatus } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createMembersService } from '../members/members.js';
import { inactiveStanding } from '../kiosk/standing/standing.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService } from './memberships.js';
import { createMembershipJobs } from './memberships.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
const memberStatuses = ['prospect', 'trial', 'active', 'frozen', 'cancelled', 'visitor'] as const;
async function fixture(status: MemberStatus = 'prospect') {
  const gymId = uuidv7(), clock = new TestClock('2028-03-10T12:00:00Z');
  await factory('gyms', gymId, { timezone: 'America/Vancouver', currency: 'CAD' });
  const person = await factory('members', gymId, { status });
  const plan = await factory('plans', gymId);
  const context = { gymId, actor: { kind: 'system' as const } };
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const service = createMembershipService(options), people = createMembersService(options);
  const request = { id: uuidv7(), householdId: person.householdId, memberId: person.id, planId: plan.id,
    startsOn: '2028-03-01', nextDueOn: '2028-03-15', firstPeriod: 'next_billing_date' as const };
  const assign = (initialStatus: 'active' | 'trial' | 'pending') => service.assign(context, { ...request, id: uuidv7(), initialStatus,
    ...(initialStatus === 'trial' ? { trialEndsOn: '2028-03-15' } : {}) });
  const read = () => people.getMember(gymId, person.id);
  const events = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(and(
    eq(auditEvents.targetId, person.id), like(auditEvents.action, 'billing.member.%'))).orderBy(asc(auditEvents.id)));
  const standing = () => inactiveStanding(db.forGym).check({ gymId, memberId: person.id, clock });
  return { gymId, clock, person, plan, context, options, service, people, request, assign, read, events, standing };
}

describe('member status derived from memberships against PostgreSQL', () => {
  it.each(memberStatuses)('derives active and trial assignments from a staff-set %s status', async status => {
    for (const initialStatus of ['active', 'trial'] as const) {
      const f = await fixture(status), membership = await f.assign(initialStatus);
      expect(await f.read()).toMatchObject({ status: initialStatus, revision: status === initialStatus ? 1 : 2 });
      const events = await f.events();
      if (status === initialStatus) expect(events).toEqual([]);
      else expect(events).toMatchObject([{ actorKind: 'system', occurredAt: f.clock.now(),
        before: { status, revision: 1 }, after: { status: initialStatus, revision: 2,
          membershipId: membership.id, cause: 'billing.membership.assigned' } }]);
    }
  });

  it.each(memberStatuses)('preserves %s with only pending and cancelled memberships', async status => {
    const f = await fixture(status);
    await factory('memberships', f.gymId, { ...f.request, id: uuidv7(), status: 'cancelled' });
    await f.assign('pending');
    expect(await f.read()).toMatchObject({ status, revision: 1 });
    expect(await f.events()).toEqual([]);
  });

  it.each(['active', 'trial', 'frozen', 'pending', 'cancelled'] as const)(
    'derives status when cancelling a trial beside a %s membership', async remaining => {
      const f = await fixture('trial'), target = await f.assign('trial');
      await factory('memberships', f.gymId, { ...f.request, id: uuidv7(), status: remaining });
      await f.people.updateMember(f.context, f.person.id, { status: 'visitor', revision: 1 });
      await f.service.cancel(f.context, { membershipId: target.id, revision: target.revision });
      const status = remaining === 'pending' ? 'visitor' : remaining;
      expect(await f.read()).toMatchObject({ status, revision: status === 'visitor' ? 2 : 3 });
      expect(await f.events()).toHaveLength(status === 'visitor' ? 0 : 1);
    });

  it('cancels the last trial and refuses kiosk access even with credits left', async () => {
    const f = await fixture('trial'), trial = await f.assign('trial');
    await factory('classCreditEntries', f.gymId, { memberId: f.person.id, credits: 5 });
    expect(await f.standing()).toEqual({ status: 'ok' });
    await f.service.cancel(f.context, { membershipId: trial.id, revision: trial.revision });
    expect(await f.read()).toMatchObject({ status: 'cancelled', revision: 2 });
    expect(await f.standing()).toEqual({ status: 'front_desk', reasonCode: 'inactive' });
    expect(await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.memberId, f.person.id))))
      .toMatchObject([{ credits: 5 }]);
    expect(await f.events()).toMatchObject([{ action: 'billing.member.cancelled', before: { status: 'trial', revision: 1 },
      after: { status: 'cancelled', revision: 2, membershipId: trial.id, cause: 'billing.membership.cancelled' } }]);
  });

  it('keeps one of two trials on trial without advancing the member revision', async () => {
    const f = await fixture('trial'), trial = await f.assign('trial');
    await f.assign('trial');
    await f.service.cancel(f.context, { membershipId: trial.id, revision: trial.revision });
    expect(await f.read()).toMatchObject({ status: 'trial', revision: 1 });
    expect(await f.events()).toEqual([]);
    expect(await f.standing()).toEqual({ status: 'ok' });
  });

  it.each(['active', 'trial'] as const)('freezes and resumes a lone %s membership with its member', async status => {
    const f = await fixture(status), membership = await f.assign(status);
    const frozen = await f.service.freeze(f.context, { membershipId: membership.id, revision: membership.revision });
    expect(await f.read()).toMatchObject({ status: 'frozen', revision: 2 });
    expect(await f.standing()).toEqual({ status: 'front_desk', reasonCode: 'inactive' });
    await f.service.activate(f.context, { membershipId: frozen.id, revision: frozen.revision });
    expect(await f.read()).toMatchObject({ status: 'active', revision: 3 });
    expect(await f.standing()).toEqual({ status: 'ok' });
    expect(await f.events()).toMatchObject([
      { action: 'billing.member.frozen', after: { cause: 'billing.membership.frozen', membershipId: membership.id } },
      { action: 'billing.member.activated', after: { cause: 'billing.membership.activated', membershipId: membership.id } },
    ]);
    await expect(f.people.updateMember(f.context, f.person.id, { revision: 1, status: 'visitor' }))
      .rejects.toMatchObject({ name: 'RevisionConflictError' });
  });

  it.each(['trial', 'active', 'frozen'] as const)('freezes one active membership beside %s using the priority rule', async remaining => {
    const f = await fixture('active'), membership = await f.assign('active');
    await factory('memberships', f.gymId, { ...f.request, id: uuidv7(), status: remaining });
    await f.service.freeze(f.context, { membershipId: membership.id, revision: membership.revision });
    expect(await f.read()).toMatchObject({ status: remaining, revision: remaining === 'active' ? 1 : 2 });
  });

  it('clears frozen timestamps on cancellation and keeps the freeze history', async () => {
    const f = await fixture('active'), membership = await f.assign('active');
    const frozen = await f.service.freeze(f.context, { membershipId: membership.id, revision: 1, resumesOn: '2028-03-15' });
    expect(frozen.frozenAt).toBe(f.clock.now().toISOString());
    const cancelled = await f.service.cancel(f.context, { membershipId: frozen.id, revision: frozen.revision });
    expect(cancelled).toMatchObject({ frozenAt: null, resumesOn: null, cancelledAt: f.clock.now().toISOString() });
    expect(await f.read()).toMatchObject({ status: 'cancelled', revision: 3 });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, membership.id),
      eq(auditEvents.action, 'billing.membership.frozen'))))).toMatchObject([{ after: { frozenAt: frozen.frozenAt } }]);
  });

  it('keeps a staff edit until a new membership edit, while assignment replay stays idempotent', async () => {
    const f = await fixture('active');
    const request = { ...f.request, initialStatus: 'active' as const };
    const membership = await f.service.assign(f.context, request);
    await f.people.updateMember(f.context, f.person.id, { status: 'visitor', revision: 1 });
    await f.service.assign(f.context, request);
    expect(await f.read()).toMatchObject({ status: 'visitor', revision: 2 });
    expect(await f.events()).toEqual([]);
    await f.service.update(f.context, { membershipId: membership.id, revision: membership.revision, nextDueOn: '2028-04-15' });
    expect(await f.read()).toMatchObject({ status: 'active', revision: 3 });
    expect(await f.events()).toMatchObject([{ after: { cause: 'billing.membership.updated' } }]);
  });

  it.each(['trial_end', 'resume_date'] as const)('reconciles the member through the %s job exactly once', async cause => {
    const f = await fixture('trial'), membership = await f.assign('trial');
    if (cause === 'resume_date') await f.service.freeze(f.context, { membershipId: membership.id, revision: 1, resumesOn: '2028-03-15' });
    const before = await f.read(), eventsBefore = (await f.events()).length;
    const [job] = createMembershipJobs(() => f.service);
    const context = { jobId: uuidv7(), gymId: f.gymId, timezone: 'America/Vancouver', clock: f.clock, attempt: 1 };
    await job!.handler({}, context);
    expect(await f.read()).toEqual(before);
    f.clock.set('2028-03-15T07:00:00Z');
    await job!.handler({}, context); await job!.handler({}, context);
    expect(await f.read()).toMatchObject({ status: 'active', revision: before.revision + 1 });
    expect(await f.events()).toHaveLength(eventsBefore + 1);
  });

  it('serializes simultaneous cancellations so the last trial cancels the member once', async () => {
    const f = await fixture('trial'), trials = [await f.assign('trial'), await f.assign('trial')];
    await Promise.all(trials.map(row => f.service.cancel(f.context, { membershipId: row.id, revision: row.revision })));
    expect(await f.read()).toMatchObject({ status: 'cancelled', revision: 2 });
    expect(await f.events()).toMatchObject([{ action: 'billing.member.cancelled' }]);
  });

  it('rolls back cancellation, the member revision and audits together', async () => {
    const f = await fixture('trial'), trial = await f.assign('trial');
    const service = createMembershipService({ ...f.options, scope: (gymId, work) => db.forGym(gymId, async tx => {
      await work(tx); throw new Error('abort cancellation');
    }) });
    await expect(service.cancel(f.context, { membershipId: trial.id, revision: trial.revision })).rejects.toThrow('abort cancellation');
    expect(await f.service.get(f.gymId, trial.id)).toEqual(trial);
    expect(await f.read()).toMatchObject({ status: 'trial', revision: 1 });
    expect(await f.events()).toEqual([]);
  });

  it('attributes a member status change to the staff caller and causing membership', async () => {
    const f = await fixture('active'), membership = await f.assign('active');
    const user = await factory('authUser', f.gymId);
    await f.service.freeze({ gymId: f.gymId, actor: { kind: 'user', userId: user.id } }, { membershipId: membership.id, revision: 1 });
    expect(await f.events()).toMatchObject([{ action: 'billing.member.frozen', actorKind: 'user', actorUserId: user.id,
      targetType: 'member', targetId: f.person.id, occurredAt: f.clock.now(),
      before: { status: 'active', revision: 1 }, after: { status: 'frozen', revision: 2,
        membershipId: membership.id, cause: 'billing.membership.frozen' } }]);
  });

  it('keeps visitor, prospect and pack-only members without memberships unchanged by another member or gym', async () => {
    const f = await fixture('active'), foreign = await fixture('visitor');
    const visitor = await factory('members', f.gymId, { householdId: f.person.householdId, status: 'visitor' });
    const packOnly = await factory('members', f.gymId, { householdId: f.person.householdId, status: 'active' });
    const prospect = await factory('members', f.gymId, { householdId: f.person.householdId, status: 'prospect' });
    await factory('classCreditEntries', f.gymId, { memberId: packOnly.id, credits: 5 });
    const membership = await f.assign('active');
    const frozen = await f.service.freeze(f.context, { membershipId: membership.id, revision: 1 });
    await f.service.cancel(f.context, { membershipId: frozen.id, revision: frozen.revision });
    for (const person of [visitor, packOnly, prospect]) expect(await f.people.getMember(f.gymId, person.id))
      .toMatchObject({ status: person.status, revision: 1 });
    expect(await foreign.read()).toMatchObject({ status: 'visitor', revision: 1 });
    await expect(f.service.cancel(foreign.context, { membershipId: membership.id, revision: 3 }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await foreign.events()).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(memberships).where(eq(memberships.memberId, packOnly.id)))).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select({ status: members.status }).from(members).where(eq(members.id, visitor.id))))
      .toEqual([{ status: 'visitor' }]);
  });
});
