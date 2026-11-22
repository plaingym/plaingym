// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { announcementOptOuts, auditEvents, classBookings, classSessions, emailDeliveries, emailOutbox, households, members, uuidv7, writeAudit } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Exercise the default schedule routes in the real production registrations.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { type StaffRole } from '@plaingym/shared';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createApp } from '../../app.js';
import { clock as systemClock, TestClock } from '../../core/clock.js';
import { errorHandler } from '../../core/errors.js';
import { setLogSink } from '../../core/log.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { DeliveryError, FakeEmail } from '../../infra/email/index.js';
import { OutboxEmail } from '../../infra/email/outbox.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createScheduleRoutes } from '../schedule/schedule.routes.js';
import { createGoLiveService } from '../settings/go-live.js';
import { cancellationNoticeJob, cancellationNoticeJobPayload, cancellationNoticePayload, configureCancellationNotice,
  createCancellationNotice } from './cancellation.js';
import { createAnnouncementJobs } from './jobs.js';
import * as audience from './audience.js';
import * as template from '../../emails/announcements/cancellation.js';
import { commandDigest, emailInFlightMs } from '../../infra/email/deliveries.js';
import { announcementRecoveryJob, createAnnouncementRecoveryJobs } from './recovery.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
beforeAll(async () => { await initializeDatabase(db.appUrl); });
afterAll(async () => { await closeDatabase(); });
afterEach(() => { vi.restoreAllMocks(); });
it('recovers a cancellation after twelve failures using its original roster and accepted delivery key', async () => {
  const f = await fixture(); await f.booked(); await f.booked();
  let broken = true, outcomeRecorded = false;
  const scope: typeof db.forGym = (gymId, fn) => {
    // Crash after SMTP accepts the first message, before its outcome audit commits.
    if (broken && f.email.messages.length) {
      if (outcomeRecorded) return Promise.reject(new Error('Database unavailable'));
      outcomeRecorded = true; // Let deliveries.attempt persist accepted, then lose the decision audit.
    }
    return db.forGym(gymId, fn);
  };
  const interrupted = createCancellationNotice({ ...f.options, scope });
  vi.spyOn(f.notice, 'run').mockImplementation(interrupted.run);
  createServerRegistry({ jobs: createAnnouncementRecoveryJobs({ scope: db.forGym, clock: f.clock, jobs: f.jobs }) })
    .registerJobs(f.jobs, new Set());
  await f.cancel();
  const snapshot = f.payload();
  for (let attempt = 1; attempt <= 12; attempt++) {
    expect(await f.jobs.runNext()).toBe(true);
    const job = f.jobs.jobs.find(job => job.name === cancellationNoticeJob)!;
    expect(job.attempt).toBe(attempt); f.clock.set(job.runAt);
  }
  const failed = f.jobs.jobs.find(job => job.name === cancellationNoticeJob)!;
  expect(failed.status).toBe('failed'); expect(f.email.messages).toHaveLength(1);
  const late = await f.booked(); // Recovery must not add a member outside the original snapshot.
  broken = false; f.clock.advance(15 * 60_000);
  await f.jobs.triggerSchedule(announcementRecoveryJob, [{ gymId: f.gymId, timezone: 'UTC' }], 'recover-1');
  expect(await f.jobs.runNext()).toBe(true);
  expect(f.jobs.jobs.filter(job => job.name === cancellationNoticeJob)).toMatchObject([
    { id: failed.id, attempt: 0, status: 'queued', payload: snapshot },
  ]);
  expect(await f.jobs.runNext()).toBe(true);
  expect(f.jobs.jobs.find(job => job.name === cancellationNoticeJob)!.status).toBe('completed');
  expect(f.email.messages).toHaveLength(2);
  expect(new Set(f.email.messages.map(message => message.to)).size).toBe(2);
  expect(f.email.messages.some(message => message.to === late.email)).toBe(false);
  const decisions = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.cancellation_notice_decided')));
  expect(decisions).toHaveLength(2);
  expect(decisions.every(row => (row.after as { status: string }).status === 'sent')).toBe(true);
});
async function fixture(role: StaffRole = 'owner', assigned = true) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', timezone: 'America/New_York', memberEmailsEnabled: true });
  const user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role });
  const coach = await factory('staffProfiles', gymId, { userId: assigned ? user.id : null });
  const session = await factory('classSessions', gymId, { name: 'Practice <partners>', coachId: coach.id,
    startsAt: new Date('2026-11-11T00:30:00Z'), endsAt: new Date('2026-11-11T01:30:00Z') });
  await factory('classSessionPrograms', gymId, { sessionId: session.id });
  const email = new FakeEmail(), jobs = new FakeJobs(clock);
  const options = { scope: db.forGym, clock, jobs, demoMode: false, origin: async () => origin,
    mailer: vi.fn(async () => { expect(isInTransaction()).toBe(false); return email; }) };
  const notice = createCancellationNotice(options), service = createScheduleService({ scope: db.forGym, clock, cancellation: notice });
  createServerRegistry({ jobs: createAnnouncementJobs(undefined, () => notice) }).registerJobs(jobs, new Set());
  const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const principal = { kind: 'staff' as const, gymId, userId: user.id, roles: [role] };
  async function booked(values: Partial<typeof members.$inferInsert> = {}, status = 'booked', targetId = session.id) {
    const member = await factory('members', gymId, { email: uuidv7() + '@example.test', ...values });
    await factory('classBookings', gymId, { sessionId: targetId, memberId: member.id, bookedBy: user.id, status,
      waitlistPosition: status === 'waitlisted' ? 1 : null });
    return member;
  }
  const cancel = (notify = true, revision = session.revision) => service.changeSession(actor, session.id, 'cancel', { revision, notify, note: '<b>Closed</b>\nSee you tomorrow.' });
  const payload = () => jobs.jobs.find(job => job.name === cancellationNoticeJob)!.payload;
  const run = () => notice.run(payload(), gymId);
  const goLive = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true });
  const emailSwitch = async (enabled: boolean) => goLive.update(actor, { revision: (await goLive.checklist(gymId)).revision, memberEmailsEnabled: enabled });
  function app() {
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (c, next) => { c.set('context', { requestId: 'cancel-test', gym: { gymId, timezone: 'America/New_York', enabledModules: new Set() }, principal, clock }); await next(); });
    app.onError(errorHandler);
    createServerRegistry({ routes: createScheduleRoutes(service) }).mount(app, authorize, new Set());
    return app;
  }
  const request = (id = session.id) => app().request(`/api/schedule/sessions/${id}/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, notify: true }) });
  return { gymId, user, coach, session, email, jobs, clock, options, notice, service, actor, principal, booked, cancel, payload, run, emailSwitch, request, app };
}

it.each([false, true])('refuses started and ended sessions without side effects (notify=%s)', async notify => {
  for (const offset of [0, 1, 60 * 60 * 1_000, 2 * 60 * 60 * 1_000]) {
    const f = await fixture();
    await f.booked(); await f.booked({}, 'waitlisted');
    f.clock.set(new Date(f.session.startsAt.getTime() + offset));
    const snapshot = () => db.forGym(f.gymId, async tx => ({
      sessions: await tx.select().from(classSessions),
      bookings: await tx.select().from(classBookings),
      audits: await tx.select().from(auditEvents),
    }));
    const before = await snapshot();
    await expect(f.cancel(notify)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['session_started'] } });
    expect(await snapshot()).toEqual(before);
    expect(f.jobs.jobs).toHaveLength(0); expect(f.email.messages).toHaveLength(0);
  }
});

it.each([false, true])('still cancels a session one millisecond before its start (notify=%s)', async notify => {
  const f = await fixture(); await f.booked(); await f.booked({}, 'waitlisted');
  f.clock.set(new Date(f.session.startsAt.getTime() - 1));
  expect(await f.cancel(notify)).toMatchObject({ status: 'cancelled', revision: f.session.revision + 1 });
  const bookings = await db.forGym(f.gymId, tx => tx.select().from(classBookings));
  expect(bookings).toHaveLength(2);
  for (const booking of bookings) expect(booking).toMatchObject({ status: 'cancelled', cancelledAt: f.clock.now(), waitlistPosition: null });
  expect(f.jobs.jobs).toHaveLength(notify ? 1 : 0);
});

it.each(['owner', 'admin', 'coach'] as const)('lets %s cancel with a notice through the route and under the service lock', async role => {
  const f = await fixture(role); const member = await f.booked();
  expect((await f.request()).status).toBe(200);
  expect(f.jobs.jobs).toMatchObject([{ name: cancellationNoticeJob, payload: { sessionId: f.session.id, memberIds: [member.id], note: '' },
    options: { idempotencyKey: `schedule-cancel-notice:${f.session.id}`, timezone: 'America/New_York' } }]);
  await f.jobs.runNext(); expect(f.email.messages).toHaveLength(1);
});
it('forbids another coach’s notice while retaining ordinary cancellation, and forbids front desk notices in the service too', async () => {
  for (const role of ['coach', 'front_desk'] as const) {
    const f = await fixture(role, false);
    expect((await f.request()).status).toBe(403);
    await expect(f.cancel()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await f.service.getSession(f.gymId, f.session.id)).toMatchObject({ status: 'scheduled', revision: 1 });
    expect(f.jobs.jobs).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(0);
    if (role === 'coach') expect(await f.cancel(false)).toMatchObject({ status: 'cancelled' });
  }
});
it.each([false, true])('reads time after acquiring the session lock (notify=%s)', async notify => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, tx => { entered.resolve(); return fn(tx); });
  const service = createScheduleService({ scope, clock: f.clock, cancellation: f.notice });
  const holding = db.forGym(f.gymId, async tx => {
    await tx.select().from(classSessions).where(eq(classSessions.id, f.session.id)).for('update');
    locked.resolve(); await release.promise;
  });
  try {
    await Promise.race([locked.promise, holding]);
    const cancelling = service.changeSession(f.actor, f.session.id, 'cancel', { revision: 1, notify });
    void cancelling.catch(() => undefined);
    await Promise.race([entered.promise, cancelling]);
    f.clock.set(f.session.startsAt); release.resolve(); await holding;
    await expect(cancelling).rejects.toMatchObject({ code: 'conflict', details: { reason: ['session_started'] } });
  } finally { release.resolve(); await holding; }
  expect(await f.service.getSession(f.gymId, f.session.id)).toMatchObject({ status: 'scheduled', revision: 1 });
  expect(f.jobs.jobs).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(0);
});

it('uses the assigned coach after acquiring the lock, even when the coach changed while cancellation waited', async () => {
  const f = await fixture('coach');
  const replacement = await factory('staffProfiles', f.gymId);
  const entered = Promise.withResolvers<void>(), locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, tx => { entered.resolve(); return fn(tx); });
  const service = createScheduleService({ scope, clock: f.clock, cancellation: f.notice });
  const holding = db.forGym(f.gymId, async tx => {
    await tx.select().from(classSessions).where(eq(classSessions.id, f.session.id)).for('update');
    locked.resolve();
    await release.promise;
    await tx.update(classSessions).set({ coachId: replacement.id }).where(eq(classSessions.id, f.session.id));
  });
  try {
    await Promise.race([locked.promise, holding]);
    const cancelling = service.changeSession(f.actor, f.session.id, 'cancel', { revision: 1, notify: true });
    void cancelling.catch(() => undefined);
    await Promise.race([entered.promise, cancelling]);
    release.resolve(); await holding;
    await expect(cancelling).rejects.toMatchObject({ code: 'forbidden' });
  } finally { release.resolve(); await holding; }
  expect(f.jobs.jobs).toHaveLength(0);
});
it('commits the recipient snapshot, note and job with cancellation, and rolls everything back if enqueue fails', async () => {
  const f = await fixture(); const member = await f.booked();
  const original = f.jobs.enqueue.bind(f.jobs);
  const enqueue = vi.spyOn(f.jobs, 'enqueue').mockImplementation(async (...args) => { await original(...args); throw new Error('queue unavailable'); });
  await expect(f.cancel()).rejects.toThrow('queue unavailable');
  expect(f.jobs.jobs).toHaveLength(0);
  expect(await f.service.getSession(f.gymId, f.session.id)).toMatchObject({ status: 'scheduled', revision: 1 });
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(0);
  enqueue.mockRestore(); await f.cancel();
  expect(f.payload()).toMatchObject({ memberIds: [member.id], note: '<b>Closed</b>\nSee you tomorrow.' });
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(2);
});
it('mails only the snapshot’s booked and waitlisted members, combines a household address and ignores announcement opt-outs', async () => {
  const f = await fixture();
  const first = await f.booked({ firstName: 'Mia', email: '\t SHARED@example.test\u00a0' });
  const second = await f.booked({ householdId: first.householdId, firstName: 'Noa', email: 'shared@example.test' }, 'waitlisted');
  await db.forGym(f.gymId, tx => tx.insert(announcementOptOuts).values({ gymId: f.gymId, memberId: first.id }));
  await f.booked({ firstName: 'Cancelled person' }, 'cancelled');
  const another = await factory('classSessions', f.gymId);
  await f.booked({ firstName: 'Other session' }, 'booked', another.id);
  const otherGym = await fixture(); await otherGym.booked();
  await f.cancel();
  await f.booked({ firstName: 'Too late' });
  await f.run();
  expect(f.email.messages).toHaveLength(1);
  const mail = f.email.messages[0]!;
  expect(mail.to).toBe('shared@example.test');
  for (const value of ['Mia', 'Noa', '2026-11-10', '7:30 PM EST', '<b>Closed</b>', origin + '/portal/schedule']) expect(mail.text).toContain(value);
  for (const value of ['Cancelled person', 'Other session', 'Too late']) expect(mail.text).not.toContain(value);
  expect(mail.html).toContain('&lt;b&gt;Closed&lt;/b&gt;'); expect(mail.listUnsubscribe).toBeUndefined();
  expect(mail.html.toLowerCase()).not.toContain('unsubscribe');
  expect(await db.forGym(f.gymId, tx => tx.select({ memberId: classBookings.memberId, status: classBookings.status }).from(classBookings)))
    .toContainEqual({ memberId: second.id, status: 'cancelled' });
  expect(await db.forGym(f.gymId, tx => tx.select({ status: classBookings.status, cancelledAt: classBookings.cancelledAt, position: classBookings.waitlistPosition })
    .from(classBookings).where(eq(classBookings.memberId, first.id))))
    .toEqual([{ status: 'cancelled', cancelledAt: f.clock.now(), position: null }]);
});
it('queues both channels for notify without channels, and only the chosen one otherwise', async () => {
  const f = await fixture(), member = await f.booked(); await f.cancel();
  // Both channels keep the flat payload that every release sends by both.
  expect(f.payload()).toEqual({ sessionId: f.session.id, memberIds: [member.id], note: '<b>Closed</b>\nSee you tomorrow.' });
  for (const channels of [['email'], ['sms'], ['email', 'sms']] as const) {
    const g = await fixture(), booked = await g.booked();
    await g.service.changeSession(g.actor, g.session.id, 'cancel', { revision: 1, notify: true, channels: [...channels] });
    const notice = { sessionId: g.session.id, memberIds: [booked.id], note: '' };
    // One channel nests the notice, so a previous release can't read it and send both.
    expect(g.payload()).toEqual(channels.length === 1 ? { channels, notice } : notice);
  }
});
it('refuses channels without notify before cancelling or queuing anything', async () => {
  const f = await fixture(); await f.booked();
  const response = await f.app().request(`/api/schedule/sessions/${f.session.id}/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, channels: ['email'] }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request', details: { reason: ['channels_without_notify'] } } });
  await expect(f.service.changeSession(f.actor, f.session.id, 'cancel', { revision: 1, notify: false, channels: ['sms'] }))
    .rejects.toMatchObject({ code: 'invalid_request', details: { reason: ['channels_without_notify'] } });
  expect(f.jobs.jobs).toHaveLength(0);
  expect(await f.service.getSession(f.gymId, f.session.id)).toMatchObject({ status: 'scheduled', revision: 1 });
});
it.each([[['email', 'sms']], [undefined]] as const)('sends the email for channels %j', async channels => {
  const f = await fixture(); await f.booked(); await f.cancel();
  await f.notice.run({ ...(f.payload() as object), channels }, f.gymId);
  expect(f.email.messages).toHaveLength(1);
});
it('never reserves or attempts an email when only a text was chosen', async () => {
  const f = await fixture(); await f.booked(); await f.cancel();
  await f.notice.run(cancellationNoticeJobPayload({ ...cancellationNoticePayload.parse(f.payload()), channels: ['sms'] }), f.gymId);
  expect(f.email.messages).toHaveLength(0); expect(f.options.mailer).not.toHaveBeenCalled();
  expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(0);
});
it('leaves the members line out for a member at their own address, and keeps it for a billing address', async () => {
  const f = await fixture();
  await f.booked({ firstName: 'Solo', lastName: 'Member', email: 'solo@example.test' });
  const home = await factory('households', f.gymId, { email: 'parent@example.test' });
  for (const firstName of ['Mia', 'Noa']) await f.booked({ householdId: home.id, firstName, lastName: 'Child', email: null });
  await f.cancel(); await f.run();
  expect(f.email.messages).toHaveLength(2);
  const solo = f.email.messages.find(message => message.to === 'solo@example.test')!;
  expect(solo.text).toContain('has been cancelled.');
  for (const body of [solo.text, solo.html]) { expect(body).not.toContain('Booked or waitlisted members'); expect(body).not.toContain('Solo Member'); }
  expect(f.email.messages.find(message => message.to === 'parent@example.test')!.text)
    .toMatch(/^Booked or waitlisted members: (Mia Child, Noa Child|Noa Child, Mia Child)$/m);
});
it.each(['disabled', 'opt_out', 'undeliverable', 'erased', 'missing_email'] as const)('suppresses %s at delivery time', async reason => {
  const f = await fixture(), member = await f.booked(); await f.cancel();
  if (reason === 'disabled') await f.emailSwitch(false);
  else await db.forGym(f.gymId, tx => tx.update(members).set(reason === 'opt_out' ? { emailOptOut: true }
    : reason === 'undeliverable' ? { emailDeliverable: false } : reason === 'erased' ? { anonymizedAt: f.clock.now() } : { email: null }).where(eq(members.id, member.id)));
  await f.run(); expect(f.email.messages).toHaveLength(0);
  if (reason === 'disabled') expect(f.options.mailer).not.toHaveBeenCalled();
});
it.each(['emailOptOut', 'emailDeliverable'] as const)('blocks a shared address if any member there has %s suppression', async field => {
  const f = await fixture(); await f.booked({ email: 'same@example.test' });
  await factory('members', f.gymId, { email: '\t SAME@example.test\u00a0', [field]: field === 'emailOptOut' });
  await f.cancel(); await f.run(); expect(f.email.messages).toHaveLength(0);
});
it('rechecks address groups and the go-live switch after mailer preparation', async () => {
  const f = await fixture(), member = await f.booked(); await f.cancel();
  f.options.mailer.mockImplementation(async () => { await db.forGym(f.gymId, tx => tx.update(members).set({ emailDeliverable: false }).where(eq(members.id, member.id))); return f.email; });
  await f.run(); expect(f.email.messages).toHaveLength(0);
  const g = await fixture(); await g.booked(); await g.cancel();
  g.options.mailer.mockImplementation(async () => { await g.emailSwitch(false); return g.email; });
  await g.run(); expect(g.email.messages).toHaveLength(0);
});

it.each(['billing', 'direct'] as const)('drops a member whose %s address moves between the roster read and reservation', async kind => {
  const f = await fixture();
  const oldAddress = 'old@example.test', newAddress = 'new@example.test';
  const home = await factory('households', f.gymId, { email: oldAddress });
  const moving = await f.booked({ householdId: home.id, firstName: 'Moving', email: kind === 'billing' ? null : oldAddress });
  // Two stay at the old address so its notice lists names; Current is alone at their own address, so theirs lists none.
  await f.booked({ firstName: 'Staying', email: oldAddress });
  await f.booked({ firstName: 'Remaining', email: oldAddress });
  await f.booked({ firstName: 'Current', email: newAddress });
  await f.cancel();

  let changed = false;
  const scope: typeof db.forGym = async (gymId, fn) => {
    const result = await db.forGym(gymId, fn);
    if (!changed && Array.isArray(result) && result.some(row => row.id === moving.id && row.address === oldAddress)) {
      changed = true;
      await db.forGym(gymId, async tx => {
        if (kind === 'billing') await tx.update(households).set({ email: newAddress }).where(eq(households.id, home.id));
        else await tx.update(members).set({ email: newAddress }).where(eq(members.id, moving.id));
      });
    }
    return result;
  };
  await createCancellationNotice({ ...f.options, scope }).run(f.payload(), f.gymId);
  expect(changed).toBe(true);
  expect(f.email.messages).toHaveLength(2);
  expect(f.email.messages.find(message => message.to === oldAddress)?.text)
    .toMatch(/^Booked or waitlisted members: (?=.*Staying)(?=.*Remaining).+$/m);
  // A moved member joining the new address would bring the names line back.
  expect(f.email.messages.find(message => message.to === newAddress)?.text).not.toContain('Booked or waitlisted members');
  for (const message of f.email.messages) expect(message.text).not.toContain('Moving');
});

it('logs only identifiers and the reason when the email switch is disabled after reservation', async () => {
  const f = await fixture(), member = await f.booked();
  await f.booked({ email: member.email });
  await f.cancel();
  const scope: typeof db.forGym = async (gymId, fn) => {
    const result = await db.forGym(gymId, fn);
    if (result && typeof result === 'object' && 'reserved' in result) await f.emailSwitch(false);
    return result;
  };
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try { await createCancellationNotice({ ...f.options, scope }).run(f.payload(), f.gymId); }
  finally { setLogSink(previous); }

  expect(f.email.messages).toHaveLength(0);
  expect(lines.map(line => JSON.parse(line))).toEqual([{
    time: expect.any(String), level: 'info', event: 'email.suppressed', gymId: f.gymId, memberId: member.id, reason: 'disabled',
  }]);
});

it('never adds a job on a retried cancellation or duplicates a message on replay or concurrent jobs', async () => {
  const f = await fixture(); await f.booked(); const cancelled = await f.cancel();
  await expect(f.cancel()).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.cancel(true, cancelled.revision)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['already_cancelled'] } });
  expect(await f.service.getSession(f.gymId, f.session.id)).toMatchObject({ revision: cancelled.revision });
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(2);
  expect(f.jobs.jobs).toHaveLength(1);
  await Promise.allSettled([f.run(), f.run()]); await f.run();
  expect(f.email.messages).toHaveLength(1);
  expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(1);
});
it('returns a conflict without queuing or changing a session already cancelled without notification', async () => {
  const f = await fixture(); await f.booked(); const cancelled = await f.cancel(false);
  await expect(f.cancel(true, cancelled.revision)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['already_cancelled'] } });
  expect(f.jobs.jobs).toHaveLength(0);
  expect(await f.service.getSession(f.gymId, f.session.id)).toMatchObject({ revision: cancelled.revision });
});

it.each(['not_accepted', 'accepted', 'unknown', 'sending'] as const)('recovers a stored %s reservation once on replay without sending it', async state => {
  const f = await fixture(), member = await f.booked(); await f.cancel();
  await factory('emailDeliveries', f.gymId, { key: `schedule-cancel-notice:${f.session.id}:${member.id}`,
    commandDigest: commandDigest([f.session.id, member.email]), state,
    updatedAt: new Date(f.clock.now().getTime() - emailInFlightMs) });
  await f.run(); await f.run();
  const decisions = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.cancellation_notice_decided')));
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.after).toEqual({ memberId: member.id, ...(state === 'accepted' ? { status: 'sent' }
    : { status: 'failed', reason: state === 'not_accepted' ? 'not_accepted' : 'unknown' }) });
  expect(f.email.messages).toHaveLength(0);
});

it('defers a live reservation and recovers it as unknown at the in-flight boundary', async () => {
  const f = await fixture(), member = await f.booked(); await f.cancel();
  await factory('emailDeliveries', f.gymId, { key: `schedule-cancel-notice:${f.session.id}:${member.id}`,
    commandDigest: commandDigest([f.session.id, member.email]), state: 'sending', updatedAt: f.clock.now() });
  f.clock.advance(emailInFlightMs - 1);
  await expect(f.run()).rejects.toMatchObject({ code: 'conflict' });
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'schedule.cancellation_notice_decided')))).toBe(0);
  f.clock.advance(1); await f.run(); await f.run();
  const decisions = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.cancellation_notice_decided')));
  expect(decisions.map(row => row.after)).toEqual([{ memberId: member.id, status: 'failed', reason: 'unknown' }]);
  expect(f.email.messages).toHaveLength(0);
});

it.each([false, true])('recovers the original reservation members after an address group changes, with existing decision %s', async alreadyDecided => {
  const f = await fixture(), first = await f.booked({ email: 'shared@example.test' });
  const second = await f.booked({ email: first.email }), third = await f.booked({ email: first.email });
  await f.cancel();
  for (const member of [first, third]) await factory('emailDeliveries', f.gymId, {
    key: `schedule-cancel-notice:${f.session.id}:${member.id}`,
    commandDigest: commandDigest([f.session.id, first.email]), state: 'not_accepted',
  });
  // Only the second member remains in the address group; neither failed reservation was keyed by them.
  await db.forGym(f.gymId, async tx => {
    for (const member of [first, third]) await tx.update(members).set({ email: null }).where(eq(members.id, member.id));
    if (alreadyDecided) await writeAudit(tx, { gymId: f.gymId, actorKind: 'system', action: 'schedule.cancellation_notice_decided',
      targetType: 'class_session', targetId: f.session.id, after: { memberId: first.id, status: 'failed', reason: 'not_accepted' }, occurredAt: f.clock.now() });
  });
  await f.run(); await f.run();
  const decisions = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.cancellation_notice_decided')));
  expect(decisions).toHaveLength(2);
  expect(decisions.map(row => row.after)).toEqual(expect.arrayContaining([first, third].map(member => ({
    memberId: member.id, status: 'failed', reason: 'not_accepted',
  }))));
  expect(decisions.some(row => (row.after as { memberId: string }).memberId === second.id)).toBe(false);
  expect(f.email.messages).toHaveLength(0);
});

it.each(['reload', 'render'] as const)('records a guard %s failure as not accepted, continues and renders at most once per address', async failure => {
  const f = await fixture(); await f.booked(); await f.booked(); await f.cancel();
  const render = vi.spyOn(template, 'renderCancellationNotice');
  if (failure === 'render') render.mockRejectedValueOnce(new Error('render failed'));
  else {
    const read = audience.readAddressGroup; let calls = 0;
    vi.spyOn(audience, 'readAddressGroup').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('database unavailable');
      return read(...args);
    });
  }
  await f.run(); await f.run();
  expect(f.email.messages).toHaveLength(1);
  expect(render).toHaveBeenCalledTimes(failure === 'render' ? 2 : 1);
  const rows = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
  expect(rows.map(row => row.state).sort()).toEqual(['accepted', 'not_accepted']);
  const decisions = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.cancellation_notice_decided')));
  expect(decisions).toHaveLength(2);
  expect(decisions.some(row => (row.after as { reason?: string }).reason === 'not_accepted')).toBe(true);
});
it('deduplicates destinations when addresses converge after a prior delivery', async () => {
  const f = await fixture(), first = await f.booked({ email: 'first@example.test' }), second = await f.booked({ email: 'second@example.test' });
  await f.cancel(); await f.run();
  await db.forGym(f.gymId, tx => tx.update(members).set({ email: first.email }).where(eq(members.id, second.id)));
  await f.run(); expect(f.email.messages).toHaveLength(2);
});
it('never retries an unknown transport outcome and still delivers the remaining addresses', async () => {
  const f = await fixture(); await f.booked(); await f.booked(); await f.cancel();
  f.email.respondNext(new DeliveryError('unknown', 'reply lost'));
  await f.run(); await f.run();
  expect(f.email.messages).toHaveLength(1);
  expect(await db.forGym(f.gymId, tx => tx.select({ state: emailDeliveries.state }).from(emailDeliveries)))
    .toEqual(expect.arrayContaining([{ state: 'unknown' }, { state: 'accepted' }]));
});
it('retries a setup failure before reserving any recipient', async () => {
  const f = await fixture(); await f.booked(); await f.cancel();
  f.options.mailer.mockRejectedValueOnce(new Error('SMTP not configured'));
  await expect(f.run()).rejects.toThrow('SMTP not configured');
  expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(0);
  await f.run(); await f.run(); expect(f.email.messages).toHaveLength(1);
});
it('returns cross-gym 404 on cancel and cannot deliver a foreign session or member snapshot', async () => {
  const f = await fixture(), g = await fixture(); await g.booked(); await g.cancel();
  expect((await f.request(g.session.id)).status).toBe(404);
  await f.notice.run(g.payload(), f.gymId); expect(f.email.messages).toHaveLength(0);
  expect(f.jobs.jobs).toHaveLength(0);
});
it('uses only the demo outbox and fails closed when its outbox is absent', async () => {
  const f = await fixture(); await f.booked(); await f.cancel();
  const unwired = createCancellationNotice({ ...f.options, demoMode: true });
  await expect(unwired.run(f.payload(), f.gymId)).rejects.toMatchObject({ code: 'unavailable' });
  const demo = createCancellationNotice({ ...f.options, demoMode: true, demoEmailFor: gymId => new OutboxEmail(gymId, f.clock, db.forGym) });
  await demo.run(f.payload(), f.gymId); await demo.run(f.payload(), f.gymId);
  expect(f.options.mailer).not.toHaveBeenCalled(); expect(f.email.messages).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.$count(emailOutbox))).toBe(1);
});
it('runs a cancellation request and its job through the production area registrations', async () => {
  const f = await fixture(); await f.booked(); configureCancellationNotice(f.notice);
  vi.spyOn(systemClock, 'now').mockImplementation(() => f.clock.now());
  const app = createApp({ clock: f.clock, skipSetup: true, authorize, origin, contributions: areaContributions,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'America/New_York', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: f.principal }); await next(); } });
  const response = await app.request(origin + `/api/schedule/sessions/${f.session.id}/cancel`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, notify: true, note: 'Closed today.' }) });
  expect(response.status).toBe(200);
  const registration = areaContributions.jobs.find(job => job.id === cancellationNoticeJob)!;
  await registration.handler(f.payload(), { gymId: f.gymId, jobId: 'test', timezone: 'America/New_York', attempt: 1, clock: f.clock });
  expect(f.email.messages).toHaveLength(1); expect(f.email.messages[0]!.text).toContain('Closed today.');
});
