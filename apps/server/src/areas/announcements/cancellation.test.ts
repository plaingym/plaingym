// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { announcementOptOuts, auditEvents, classBookings, classSessions, emailDeliveries, emailOutbox, members, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Exercise the default schedule routes in the real production registrations.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { type StaffRole } from '@plaingym/shared';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createApp } from '../../app.js';
import { TestClock } from '../../core/clock.js';
import { errorHandler } from '../../core/errors.js';
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
import { cancellationNoticeJob, configureCancellationNotice, createCancellationNotice } from './cancellation.js';
import { createAnnouncementJobs } from './jobs.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
beforeAll(async () => { await initializeDatabase(db.appUrl); });
afterAll(async () => { await closeDatabase(); });
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
  return { gymId, user, coach, session, email, jobs, clock, options, notice, service, actor, principal, booked, cancel, payload, run, emailSwitch, request };
}

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
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(1);
});
it('mails only the snapshot’s booked and waitlisted members, combines a household address and ignores announcement opt-outs', async () => {
  const f = await fixture();
  const first = await f.booked({ firstName: 'Mia', email: ' SHARED@example.test ' });
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
    .toContainEqual({ memberId: second.id, status: 'waitlisted' });
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
  await factory('members', f.gymId, { email: ' SAME@example.test ', [field]: field === 'emailOptOut' });
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
it('never adds a job on a retried cancellation or duplicates a message on replay or concurrent jobs', async () => {
  const f = await fixture(); await f.booked(); const cancelled = await f.cancel();
  await expect(f.cancel()).rejects.toMatchObject({ name: 'RevisionConflictError' });
  await f.cancel(true, cancelled.revision); expect(f.jobs.jobs).toHaveLength(1);
  await Promise.allSettled([f.run(), f.run()]); await f.run();
  expect(f.email.messages).toHaveLength(1);
  expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(1);
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
