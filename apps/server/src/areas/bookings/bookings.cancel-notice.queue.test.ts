// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { classBookings, emailDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail, type Email } from '../../infra/email/index.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createPortalAuthorization } from '../portal/auth.permissions.js';
import { createBookingService } from './bookings.js';
import { createBookingRoutes } from './bookings.routes.js';
import { createBookingJobs, jobs as bookingJobs } from './bookings.jobs.js';
import { createBookingDelivery, noticeJob, promotionJob } from './bookings.delivery.js';
import { cancelNoticeJob } from './bookings.cancel-notice.js';

const db = useTestDatabase(), factory = createFactories(db);
const startsAt = new Date('2026-11-10T14:00:00Z');
/** The gym's one-hour cancellation cutoff: after it the waitlist is frozen. */
const cutoff = new Date('2026-11-10T13:00:00Z');
const afterCutoff = new Date('2026-11-10T13:30:00Z');

/**
 * Two booked members (Ana, Bea) and two eligible waitlisted members (Cy, Dee) in a full class, served by the staff
 * route and the real queue with one default-lane job at a time for the gym. Ana's first email blocks until released.
 */
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:30:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true, cancellationCutoffMinutes: 60 });
  const staff = await factory('authUser', gymId);
  const member = (firstName: string) => factory('members', gymId, { firstName, email: `${firstName.toLowerCase()}@example.test` });
  const [ana, bea, cy, dee] = [await member('Ana'), await member('Bea'), await member('Cy'), await member('Dee')];
  const session = await factory('classSessions', gymId, { name: 'Noon fundamentals', capacity: 2, startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000) });
  const service = createBookingService({ scope: db.forGym, clock }), actor = { gymId, actor: { kind: 'user' as const, userId: staff.id } };
  const book = async (memberId: string) => (await service.book(actor, { memberId, sessionId: session.id, allowWaitlist: true })).booking;
  const a = await book(ana.id), b = await book(bea.id), wa = await book(cy.id), wb = await book(dee.id);
  expect([a.status, b.status, wa.status, wb.status]).toEqual(['booked', 'booked', 'waitlisted', 'waitlisted']);

  // Leases far longer than the blocked send, so the held notice keeps its lease while the clock moves.
  const queue = new PostgresJobs({ database: db, clock, perGymConcurrency: 1, leaseMs: 86_400_000 });
  const fake = new FakeEmail();
  let reached!: () => void, release!: () => void, blocked = false;
  const blocking = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const slow: Email = { async sendEmail(message) {
    if (!blocked && message.to === 'ana@example.test') { blocked = true; reached(); await gate; }
    return fake.sendEmail(message);
  } };
  const delivery = createBookingDelivery({ scope: db.forGym, clock, jobs: queue, mailer: async () => slow });
  createServerRegistry({ jobs: createBookingJobs(() => delivery) }).registerJobs(queue, new Set());
  const server = createApp({ clock, skipSetup: true, origin: 'http://localhost',
    contributions: { routes: createBookingRoutes(service, () => delivery) },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId, userId: staff.id, roles: ['front_desk'] } }); await next(); },
    authorize: createPortalAuthorization(createMemberHouseholdContext(db.forGym)),
  });
  const cancel = (id: string, body: unknown) => server.request(`/api/bookings/${id}/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });
  const status = async (id: string) => (await db.forGym(gymId, tx => tx.select({ status: classBookings.status }).from(classBookings)
    .where(eq(classBookings.id, id))))[0]?.status;
  const sent = () => fake.messages.map(message => message.to).sort();
  const drain = async () => { for (let n = 0; n < 20; n++) if (!await queue.runNext()) return; throw new Error('Unexpected job loop'); };
  return { gymId, clock, queue, delivery, blocking, release, cancel, status, sent, drain, a, b, wa, wb };
}

it('registers the cancellation notice, and no other booking job, in the batch lane', () => {
  expect(Object.fromEntries(bookingJobs.map(job => [job.id, job.lane ?? 'default']))).toEqual({
    [promotionJob]: 'default', [noticeJob]: 'default', [cancelNoticeJob]: 'batch', 'bookings.recover': 'default' });
});

it('promotes both freed places before the cutoff while one cancellation email is held', async () => {
  const f = await fixture();
  expect((await f.cancel(f.a.id, { notify: true, channels: ['email'], note: 'The instructor is away.' })).status).toBe(200);
  // Ana's promotion was queued first in the cancelling transaction and fills her place.
  expect(await f.queue.runNext()).toBe(true);
  expect(await f.status(f.wa.id)).toBe('booked');
  // Ana's notice is claimed next, and its email blocks with the job still leased.
  const held = f.queue.runNext(); await f.blocking;

  expect((await f.cancel(f.b.id, { notify: true, channels: ['email'] })).status).toBe(200);
  // The default lane is still free: Cy's promotion notice, Bea's promotion and Dee's promotion notice all run.
  // Bea's own notice waits for the gym's batch lane, which Ana's held notice keeps.
  await f.drain();
  expect(f.clock.now() < cutoff).toBe(true);
  expect(await f.status(f.b.id)).toBe('cancelled');
  expect(await f.status(f.wb.id)).toBe('booked');
  expect(f.sent()).toEqual(['cy@example.test', 'dee@example.test']);

  // The mailer recovers after the cutoff; both cancellation notices are then delivered.
  f.clock.set(afterCutoff); f.release(); expect(await held).toBe(true);
  await f.drain();
  expect(f.sent()).toEqual(['ana@example.test', 'bea@example.test', 'cy@example.test', 'dee@example.test']);
  // Each notice keeps its own delivery key, and each job its own queue key.
  expect((await db.forGym(f.gymId, tx => tx.select({ key: emailDeliveries.key }).from(emailDeliveries))).map(row => row.key).sort())
    .toEqual([`booking-cancel-email:${f.a.id}`, `booking-cancel-email:${f.b.id}`,
      `booking-promotion:${f.wa.id}`, `booking-promotion:${f.wb.id}`].sort());
  for (const id of [f.a.id, f.b.id]) {
    expect(await f.queue.existingJobs(promotionJob, [`booking-cancelled:${id}`], { gymId: f.gymId })).toHaveLength(1);
    expect(await f.queue.existingJobs(cancelNoticeJob, [`booking-cancel-notice:${id}`], { gymId: f.gymId })).toHaveLength(1);
  }
});

it('claims a failed promotion\'s retry before the cutoff while the cancellation email is held', async () => {
  const f = await fixture();
  const promote = vi.spyOn(f.delivery, 'promote').mockRejectedValueOnce(new Error('database unavailable'));
  expect((await f.cancel(f.a.id, { notify: true, channels: ['email'] })).status).toBe(200);
  // The first attempt fails before it allocates the place, and backs off for a second.
  expect(await f.queue.runNext()).toBe(true);
  expect(promote).toHaveBeenCalledTimes(1);
  expect(await f.status(f.wa.id)).toBe('waitlisted');
  // The notice, now due first, is claimed and blocks.
  const held = f.queue.runNext(); await f.blocking;
  expect(await f.queue.runNext()).toBe(false);
  // Once the retry is due, it is claimed beside the held notice and promotes Cy.
  f.clock.advance(1_000);
  expect(await f.queue.runNext()).toBe(true);
  expect(promote).toHaveBeenCalledTimes(2);
  expect(f.clock.now() < cutoff).toBe(true);
  expect(await f.status(f.wa.id)).toBe('booked');
  await f.drain();
  expect(f.sent()).toEqual(['cy@example.test']);
  f.release(); expect(await held).toBe(true);
  expect(f.sent()).toEqual(['ana@example.test', 'cy@example.test']);
});

it('rolls back the cancellation, its promotion request and its notice together', async () => {
  const f = await fixture(), original = f.queue.enqueue.bind(f.queue);
  const enqueue = vi.spyOn(f.queue, 'enqueue').mockImplementation(async (...args) => {
    const queued = await original(...args);
    if (args[0] === cancelNoticeJob) throw new Error('queue unavailable');
    return queued;
  });
  expect((await f.cancel(f.a.id, { notify: true, channels: ['email'] })).status).toBeGreaterThanOrEqual(500);
  expect(enqueue.mock.calls.map(call => call[0])).toEqual([promotionJob, cancelNoticeJob]);
  enqueue.mockRestore();
  expect(await f.status(f.a.id)).toBe('booked'); expect(await f.status(f.wa.id)).toBe('waitlisted');
  expect(await f.queue.existingJobs(promotionJob, [`booking-cancelled:${f.a.id}`], { gymId: f.gymId })).toEqual([]);
  expect(await f.queue.existingJobs(cancelNoticeJob, [`booking-cancel-notice:${f.a.id}`], { gymId: f.gymId })).toEqual([]);
  expect(await f.queue.runNext()).toBe(false);
  expect(f.sent()).toEqual([]);
});
