// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { auditEvents, leads, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { createAttendanceService } from '../attendance/attendance.js';
import { createKioskCheckinHelpers } from '../kiosk/checkin.js';
import { createMembershipService } from '../billing/memberships.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createTransitionEffects } from '../billing/transitions/effects.js';
import { createTransitionNotifications } from '../billing/transitions/notifications.js';
import { effectCreated, type TransitionEffect } from '../billing/transitions/store.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { advanceLeadOnCheckIn, markLeadWon } from './stages.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-11-10T12:00:00Z');
async function fixture(status = 'prospect') {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const member = await factory('members', gymId, { status });
  const user = await factory('authUser', gymId);
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const attendance = createAttendanceService(options), memberships = createMembershipService(options);
  const rows = () => db.forGym(gymId, async tx => ({ leads: await tx.select().from(leads),
    audits: await tx.select().from(auditEvents).where(eq(auditEvents.action, 'lead.stage_changed')) }));
  return { gymId, member, context, options, attendance, memberships, rows };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function assign(f: Fixture, initialStatus: 'pending' | 'trial' | 'active' = 'pending') {
  const plan = await factory('plans', f.gymId);
  const request = { id: uuidv7(), memberId: f.member.id, householdId: f.member.householdId, planId: plan.id,
    startsOn: '2026-11-10', nextDueOn: '2026-11-10', firstPeriod: 'next_billing_date' as const, initialStatus,
    ...(initialStatus === 'trial' ? { trialEndsOn: '2026-11-17' } : {}) };
  return { request, membership: await f.memberships.assign(f.context, request) };
}
const checkIn = (f: Fixture, sessionId: string | null = null) => f.attendance.record(f.context,
  { memberId: f.member.id, sessionId, programId: null });

describe('automatic lead stages in real PostgreSQL transactions', () => {
  it.each(['new', 'contacted', 'trial_booked'])('advances %s on the first staff visit, with one audit and a new revision', async stage => {
    const f = await fixture();
    const before = await factory('leads', f.gymId, { memberId: f.member.id, source: 'phone', stage, revision: 4 });
    await checkIn(f); await checkIn(f);
    const rows = await f.rows();
    expect(rows.leads[0]).toMatchObject({ id: before.id, source: 'phone', stage: 'trial_attended', trialAttendedAt: clock.now(), revision: 5 });
    expect(rows.audits).toHaveLength(1);
    expect(rows.audits[0]).toMatchObject({ actorKind: 'user', actorUserId: f.context.actor.userId,
      occurredAt: clock.now(), before: { stage, revision: 4 }, after: { stage: 'trial_attended', revision: 5 } });
  });
  it.each(['won', 'lost', 'trial_attended'])('keeps an existing %s stage and its timestamps', async stage => {
    const f = await fixture(), earlier = new Date('2026-10-01Z');
    const before = await factory('leads', f.gymId, { memberId: f.member.id, stage,
      wonAt: stage === 'won' ? earlier : null, lostAt: stage === 'lost' ? earlier : null, trialAttendedAt: earlier });
    await checkIn(f);
    expect(await f.rows()).toEqual({ leads: [before], audits: [] });
  });
  it('preserves the first attendance timestamp when a manually reset lead advances again', async () => {
    const f = await fixture(), earlier = new Date('2026-10-01Z');
    await factory('leads', f.gymId, { memberId: f.member.id, stage: 'contacted', trialAttendedAt: earlier });
    await checkIn(f);
    expect((await f.rows()).leads[0]!.trialAttendedAt).toEqual(earlier);
  });
  it.each(['prospect', 'trial'])('creates a null-source lead for a %s with no row', async status => {
    const f = await fixture(status); await checkIn(f);
    expect((await f.rows()).leads).toMatchObject([{ memberId: f.member.id, source: null, stage: 'trial_attended', revision: 2 }]);
  });
  it.each(['active', 'cancelled'])('does not create a lead or break a visit for a row-less %s member', async status => {
    const f = await fixture(status); await checkIn(f);
    expect(await f.rows()).toEqual({ leads: [], audits: [] });
  });
  it('covers session check-ins and deduplicates the replay', async () => {
    const f = await fixture(), session = await factory('classSessions', f.gymId);
    const first = await checkIn(f, session.id), second = await checkIn(f, session.id);
    expect(second.id).toBe(first.id);
    expect((await f.rows()).audits).toHaveLength(1);
  });
  it('covers the kiosk service with the device actor', async () => {
    const f = await fixture(), device = await factory('kioskDevices', f.gymId);
    const kiosk = createKioskCheckinHelpers({ scope: db.forGym, clock });
    const identity = { id: f.member.id, firstName: 'Pat', lastInitial: 'T', photoUrl: null };
    expect((await kiosk.record(f.gymId, device.id, identity, null)).status).toBe('checked_in');
    await kiosk.record(f.gymId, device.id, identity, null);
    const rows = await f.rows();
    expect(rows.leads[0]!.stage).toBe('trial_attended');
    expect(rows.audits).toHaveLength(1);
    expect(rows.audits[0]).toMatchObject({ actorKind: 'device', actorDeviceId: device.id });
  });
  it('does not advance an imported visit', async () => {
    const f = await fixture();
    await f.attendance.record(f.context, { memberId: f.member.id, sessionId: null, programId: null }, { source: 'import', sourceKey: 'visit-1' });
    expect(await f.rows()).toEqual({ leads: [], audits: [] });
  });
  it.each([advanceLeadOnCheckIn, markLeadWon])('serializes concurrent creation and rolls back with its caller: %s', async helper => {
    const f = await fixture(), input = { ...f.context, memberId: f.member.id, now: clock.now() };
    await expect(db.forGym(f.gymId, async tx => { await helper(tx, input); throw new Error('caller failed'); })).rejects.toThrow('caller failed');
    expect(await f.rows()).toEqual({ leads: [], audits: [] });
    await Promise.all([1, 2].map(() => db.forGym(f.gymId, tx => helper(tx, input))));
    expect((await f.rows()).leads).toHaveLength(1);
    expect((await f.rows()).audits).toHaveLength(1);
  });
  it('does not touch gym B or throw for a missing member', async () => {
    const a = await fixture(), b = await fixture();
    await factory('leads', b.gymId, { memberId: b.member.id });
    for (const helper of [advanceLeadOnCheckIn, markLeadWon]) for (const memberId of [b.member.id, uuidv7()])
      await db.forGym(a.gymId, tx => helper(tx, { ...a.context, memberId, now: clock.now() }));
    expect(await a.rows()).toEqual({ leads: [], audits: [] });
    expect((await b.rows()).leads[0]!.stage).toBe('new');
    expect((await b.rows()).audits).toEqual([]);
  });
  it.each(['pending', 'trial'] as const)('staff activation of a %s membership marks even a lost lead won', async initialStatus => {
    const f = await fixture(), assigned = await assign(f, initialStatus);
    await factory('leads', f.gymId, { memberId: f.member.id, stage: 'lost', lostAt: new Date('2026-10-01Z'), revision: 3 });
    await f.memberships.activate(f.context, { membershipId: assigned.membership.id, revision: 1 });
    const rows = await f.rows();
    expect(rows.leads[0]).toMatchObject({ stage: 'won', wonAt: clock.now(), revision: 4 });
    expect(rows.audits).toHaveLength(1);
    expect(rows.audits[0]).toMatchObject({ actorKind: 'user', actorUserId: f.context.actor.userId });
  });
  it('marks an active assignment won once, leaves a trial assignment alone, and wins a frozen trial on its resume', async () => {
    const active = await fixture(), assigned = await assign(active, 'active');
    await active.memberships.assign(active.context, assigned.request);
    expect((await active.rows()).leads[0]).toMatchObject({ stage: 'won', wonAt: clock.now() });
    expect((await active.rows()).audits).toHaveLength(1);
    const trial = await fixture(), subscription = await assign(trial, 'trial');
    expect(await trial.rows()).toEqual({ leads: [], audits: [] });
    // A trial frozen and then resumed was never active: the resume is its first activation.
    const frozen = await trial.memberships.freeze(trial.context, { membershipId: subscription.membership.id, revision: 1 });
    await trial.memberships.activate(trial.context, { membershipId: frozen.id, revision: frozen.revision });
    expect((await trial.rows()).leads).toMatchObject([{ memberId: trial.member.id, stage: 'won', wonAt: clock.now() }]);
    expect((await trial.rows()).audits).toHaveLength(1);
  });
  it('leaves the lead alone when a membership that was active is frozen and resumed', async () => {
    const f = await fixture(), plan = await factory('plans', f.gymId);
    const membership = await factory('memberships', f.gymId, { memberId: f.member.id, householdId: f.member.householdId, planId: plan.id,
      status: 'active', startsOn: '2026-10-10', nextDueOn: '2026-12-10' });
    const frozen = await f.memberships.freeze(f.context, { membershipId: membership.id, revision: membership.revision });
    await f.memberships.activate(f.context, { membershipId: frozen.id, revision: frozen.revision });
    expect(await f.rows()).toEqual({ leads: [], audits: [] });
  });
  it('clears a lost lead\'s reason and time when it is won', async () => {
    const f = await fixture(), assigned = await assign(f);
    await factory('leads', f.gymId, { memberId: f.member.id, stage: 'lost', lostReason: 'Too far away', lostAt: new Date('2026-10-01Z') });
    await f.memberships.activate(f.context, { membershipId: assigned.membership.id, revision: 1 });
    expect((await f.rows()).leads).toMatchObject([{ stage: 'won', wonAt: clock.now(), lostReason: null, lostAt: null }]);
  });
  it('keeps an already won lead unchanged across another membership activation', async () => {
    const f = await fixture(), assigned = await assign(f);
    const before = await factory('leads', f.gymId, { memberId: f.member.id, stage: 'won', wonAt: new Date('2026-10-01Z') });
    await f.memberships.activate(f.context, { membershipId: assigned.membership.id, revision: 1 });
    expect(await f.rows()).toEqual({ leads: [before], audits: [] });
  });
  it('serializes a first check-in racing a membership activation without a deadlock or a lost won stage', async () => {
    const f = await fixture(), assigned = await assign(f);
    await Promise.all([checkIn(f), f.memberships.activate(f.context, { membershipId: assigned.membership.id, revision: 1 })]);
    const rows = await f.rows();
    expect(rows.leads).toHaveLength(1);
    expect(rows.leads[0]!.stage).toBe('won');
    expect(rows.audits.filter(row => (row.after as { stage: string }).stage === 'won')).toHaveLength(1);
  });
  it('activates a paid invoice through its real effect; a crash and replay still write one won audit', async () => {
    const f = await fixture(), assigned = await assign(f);
    const invoice = await factory('invoices', f.gymId, { householdId: f.member.householdId, number: 1, status: 'open', amountCents: 10000 });
    await factory('invoiceLineItems', f.gymId, { householdId: f.member.householdId, invoiceId: invoice.id,
      membershipId: assigned.membership.id, kind: 'membership', amountCents: 10000 });
    const transitions = createInvoiceTransitions(f.options);
    await transitions.manualPayment(f.context, { invoiceId: invoice.id, paymentId: uuidv7(), method: 'cash',
      amountCents: invoice.amountCents, currency: invoice.currency, paidAt: clock.now().toISOString() });
    const [event] = (await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, effectCreated))))
      .filter(row => (row.after as TransitionEffect).kind === 'activate_memberships');
    expect(event).toBeDefined();
    const afterInvoicePaid = vi.fn().mockRejectedValueOnce(new Error('crash after activation')).mockResolvedValue(undefined);
    const effects = createTransitionEffects({ ...f.options, transitions, memberships: f.memberships, jobs: new FakeJobs(clock),
      async payments() { return new FakePayments(f.gymId, clock); }, async retry() {}, afterInvoicePaid,
      notifications: createTransitionNotifications({ ...f.options,
        async prepare() { return { email: new FakeEmail(), origin: 'https://gym.example.invalid' }; }, async staffRecipients() { return []; } }) });
    const context = { jobId: uuidv7(), gymId: f.gymId, timezone: 'UTC', attempt: 1, clock };
    await expect(effects.run(event!.targetId, context)).rejects.toThrow('crash after activation');
    await effects.run(event!.targetId, { ...context, attempt: 2 });
    await effects.run(event!.targetId, { ...context, attempt: 3 });
    expect((await f.memberships.get(f.gymId, assigned.membership.id)).status).toBe('active');
    const rows = await f.rows();
    expect(rows.leads[0]).toMatchObject({ stage: 'won', wonAt: clock.now() });
    expect(rows.audits).toHaveLength(1);
    expect(rows.audits[0]).toMatchObject({ actorKind: 'system', actorUserId: null });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'billing.membership.activated'), eq(auditEvents.targetId, assigned.membership.id)))))
      .toHaveLength(1);
  });
});
