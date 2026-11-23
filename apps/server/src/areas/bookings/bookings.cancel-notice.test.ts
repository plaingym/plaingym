// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated fixtures switch the persisted member email and SMS notices.
import { auditEvents, classBookings, classSessions, emailDeliveries, gyms, households, members, smsDailyUsage, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, DeliveryError, FakeSms } from '../../infra/sms/index.js';
import { createBookingService, type BookingNoticeChannel } from './bookings.js';
import { createBookingDelivery, noticeJob, promotionJob } from './bookings.delivery.js';
import { createBookingJobs } from './bookings.jobs.js';
import { cancelNoticeJob } from './bookings.cancel-notice.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createPortalBookingService } from '../portal/bookings.js';

const db = useTestDatabase(), factory = createFactories(db), phone = '+12025550123';
const selections: BookingNoticeChannel[][] = [['email'], ['sms'], ['email', 'sms']];
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', settings: { address: { country: 'US' } }, timezone: 'America/New_York',
    memberEmailsEnabled: true, memberSmsEnabled: true });
  const user = await factory('authUser', gymId);
  const home = await factory('households', gymId, { email: 'parent@example.test', phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const child = await factory('members', gymId, { householdId: home.id, firstName: 'Mia', lastName: 'Rivera', email: null });
  const session = await factory('classSessions', gymId, { name: 'Evening practice', capacity: 1,
    startsAt: new Date('2026-11-11T00:30:00Z'), endsAt: new Date('2026-11-11T01:30:00Z') });
  const options = { scope: db.forGym, clock }, service = createBookingService(options), actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const booking = (await service.book(actor, { memberId: child.id, sessionId: session.id, allowWaitlist: true })).booking;
  const email = new FakeEmail(), sms = new FakeSms(), jobs = new FakeJobs(clock);
  const resolver = { resolve: vi.fn(async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms }; }),
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true };
  const settings = createGymSettingsAccessor({ scope: db.forGym });
  const deliveryOptions = { ...options, jobs, settings, mailer: vi.fn(async () => email), sms: { resolver, phoneDigest: createSmsPhoneDigest('cancel-notice-test') } };
  const delivery = createBookingDelivery(deliveryOptions);
  createServerRegistry({ jobs: createBookingJobs(() => delivery) }).registerJobs(jobs, new Set());
  const cancel = (channels?: BookingNoticeChannel[], note = '', id = booking.id) => service.cancel(actor, id, undefined,
    channels ? { channels, note, enqueue: delivery.enqueueCancelNotice } : undefined);
  const notices = () => jobs.jobs.filter(job => job.name === cancelNoticeJob);
  /** Runs every due job in queue order. */
  const drain = async () => { for (let n = 0; n < 20 && await jobs.runNext(); n++); };
  return { gymId, clock, home, child, session, service, actor, booking, email, sms, jobs, resolver, delivery, cancel, notices, settings, drain,
    run: () => delivery.sendCancelNotice(notices()[0]!.payload, gymId) };
}

it.each(selections)('queues one job for %j and delivers only to the chosen channels', async (...channels) => {
  const f = await fixture();
  expect(await f.cancel(channels, 'Bring your own mat next week.')).toMatchObject({ id: f.booking.id, status: 'cancelled' });
  expect(f.notices()).toMatchObject([{ payload: { bookingId: f.booking.id, channels }, status: 'queued',
    options: { gymId: f.gymId, idempotencyKey: `booking-cancel-notice:${f.booking.id}`, timezone: 'America/New_York' } }]);
  // The promotion request for the freed place is queued first, in the same transaction.
  expect(f.jobs.jobs).toMatchObject([{ name: promotionJob, payload: { sessionId: f.session.id },
    options: { idempotencyKey: `booking-cancelled:${f.booking.id}` } }, { name: cancelNoticeJob }]);
  await f.drain();
  expect(f.jobs.jobs.map(job => job.status)).toEqual(['completed', 'completed']);
  expect(f.email.messages).toHaveLength(channels.includes('email') ? 1 : 0);
  expect(f.sms.messages).toHaveLength(channels.includes('sms') ? 1 : 0);
  const mail = f.email.messages[0], text = f.sms.messages[0];
  if (mail) {
    expect(mail.to).toBe('parent@example.test');
    for (const value of ['Evening practice', '2026-11-10', '7:30 PM EST', 'Mia Rivera', 'Bring your own mat next week.']) expect(mail.text).toContain(value);
  }
  if (text) {
    expect(text.to).toBe(phone);
    for (const value of ['Evening practice', '2026-11-10', '7:30 PM EST', 'Mia Rivera']) expect(text.body).toContain(value);
    expect(text.body).not.toContain('mat');
  }
  // Each channel has its own key, apart from the promotion keys.
  expect((await db.forGym(f.gymId, tx => tx.select({ key: emailDeliveries.key }).from(emailDeliveries))).map(row => row.key))
    .toEqual(channels.includes('email') ? [`booking-cancel-email:${f.booking.id}`] : []);
  expect((await db.forGym(f.gymId, tx => tx.select({ key: smsDeliveries.key }).from(smsDeliveries))).map(row => row.key))
    .toEqual(channels.includes('sms') ? [`booking-cancel-sms:${f.booking.id}`] : []);
});

it('queues nothing without a notice and nothing more when the booking is already cancelled', async () => {
  const f = await fixture();
  await f.cancel(); expect(f.jobs.jobs).toHaveLength(0);
  expect(await f.cancel(['email', 'sms'])).toMatchObject({ status: 'cancelled' });
  expect(f.notices()).toHaveLength(0);
  const g = await fixture();
  const first = await g.cancel(['email']), again = await g.cancel(['email', 'sms']);
  expect(again).toEqual(first); expect(g.notices()).toHaveLength(1);
  expect(await db.forGym(g.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.cancelled')))).toBe(1);
});

it('rolls the cancellation, its audit, its promotion request and its notice back together', async () => {
  const f = await fixture(), original = f.jobs.enqueue.bind(f.jobs);
  const enqueue = vi.spyOn(f.jobs, 'enqueue').mockImplementation(async (...args) => {
    const queued = await original(...args);
    if (args[0] === cancelNoticeJob) throw new Error('queue unavailable');
    return queued;
  });
  await expect(f.cancel(['email', 'sms'])).rejects.toThrow('queue unavailable');
  expect(enqueue.mock.calls.map(call => call[0])).toEqual([promotionJob, cancelNoticeJob]);
  expect(f.jobs.jobs).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.select({ status: classBookings.status }).from(classBookings))).toEqual([{ status: 'booked' }]);
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.cancelled')))).toBe(0);
  enqueue.mockRestore();
  await f.cancel(['sms']); expect(f.notices()).toHaveLength(1);
});

it('prefers the member own email and consented phone, and names the member there too', async () => {
  const f = await fixture(), own = '+12025550199';
  await db.forGym(f.gymId, tx => tx.update(members).set({ email: 'mia@example.test', phone: own, phoneE164: own,
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id)));
  await f.cancel(['email', 'sms'], 'Sorry about this.'); await f.run();
  expect(f.email.messages.map(message => message.to)).toEqual(['mia@example.test']);
  expect(f.sms.messages.map(message => message.to)).toEqual([own]);
  expect(f.email.messages[0]!.text).toContain('Booking for: Mia Rivera');
  expect(f.email.messages[0]!.text).toContain('Sorry about this.');
  expect(f.sms.messages[0]!.body).toContain('The booking for Mia Rivera in Evening practice on 2026-11-10 at 7:30 PM EST has been cancelled by the gym.');
  expect(f.sms.messages[0]!.body).not.toContain('Your booking');
});

it('names only the cancelled sibling when siblings share a parent email and phone', async () => {
  const f = await fixture(), sharedEmail = 'parent@example.test', sharedPhone = '+12025550177';
  await db.forGym(f.gymId, async tx => {
    await tx.update(classSessions).set({ capacity: 2 }).where(eq(classSessions.id, f.session.id));
    await tx.update(members).set({ email: sharedEmail, phone: sharedPhone, phoneE164: sharedPhone,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id));
  });
  const noa = await factory('members', f.gymId, { householdId: f.home.id, firstName: 'Noa', lastName: 'Rivera', email: sharedEmail,
    phone: sharedPhone, phoneE164: sharedPhone, smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' });
  const noaBooking = (await f.service.book(f.actor, { memberId: noa.id, sessionId: f.session.id, allowWaitlist: true })).booking;
  expect(noaBooking).toMatchObject({ memberId: noa.id, status: 'booked' });

  await f.cancel(['email', 'sms']); await f.drain();
  expect(f.email.messages).toHaveLength(1);
  expect(f.email.messages[0]).toMatchObject({ to: sharedEmail });
  expect(f.email.messages[0]!.text).toContain('Booking for: Mia Rivera');
  expect(f.email.messages[0]!.text).not.toContain('Noa');
  expect(f.sms.messages).toHaveLength(1);
  expect(f.sms.messages[0]).toMatchObject({ to: sharedPhone });
  expect(f.sms.messages[0]!.body).toContain('The booking for Mia Rivera in Evening practice');
  expect(f.sms.messages[0]!.body).not.toContain('Noa');

  await f.cancel(['email', 'sms'], '', noaBooking.id); await f.drain();
  expect(f.email.messages).toHaveLength(2);
  expect(f.email.messages[1]).toMatchObject({ to: sharedEmail });
  expect(f.email.messages[1]!.text).toContain('Booking for: Noa Rivera');
  expect(f.email.messages[1]!.text).not.toContain('Mia');
  expect(f.sms.messages).toHaveLength(2);
  expect(f.sms.messages[1]).toMatchObject({ to: sharedPhone });
  expect(f.sms.messages[1]!.body).toContain('The booking for Noa Rivera in Evening practice');
  expect(f.sms.messages[1]!.body).not.toContain('Mia');
  const emailKeys = (await db.forGym(f.gymId, tx => tx.select({ key: emailDeliveries.key }).from(emailDeliveries))).map(row => row.key);
  const smsKeys = (await db.forGym(f.gymId, tx => tx.select({ key: smsDeliveries.key }).from(smsDeliveries))).map(row => row.key);
  expect(emailKeys.sort()).toEqual([`booking-cancel-email:${f.booking.id}`, `booking-cancel-email:${noaBooking.id}`].sort());
  expect(smsKeys.sort()).toEqual([`booking-cancel-sms:${f.booking.id}`, `booking-cancel-sms:${noaBooking.id}`].sort());
});

it.each(['erased', 'restored', 'rebooked', 'waitlisted'] as const)('suppresses both channels when the member is %s before the job runs', async change => {
  const f = await fixture(); await f.cancel(['email', 'sms']);
  if (change === 'erased') await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.child.id)));
  else if (change === 'restored') await db.forGym(f.gymId, tx => tx.update(classBookings).set({ status: 'booked', cancelledAt: null }).where(eq(classBookings.id, f.booking.id)));
  else {
    // Booking again through the service adds a new row and leaves the cancelled one as it was.
    if (change === 'waitlisted') {
      const other = await factory('members', f.gymId);
      await f.service.book(f.actor, { memberId: other.id, sessionId: f.session.id, allowWaitlist: true });
    }
    const again = (await f.service.book(f.actor, { memberId: f.child.id, sessionId: f.session.id, allowWaitlist: true })).booking;
    expect(again).toMatchObject({ memberId: f.child.id, status: change === 'waitlisted' ? 'waitlisted' : 'booked' });
    expect(again.id).not.toBe(f.booking.id);
    expect(await db.forGym(f.gymId, tx => tx.select({ status: classBookings.status }).from(classBookings).where(eq(classBookings.id, f.booking.id))))
      .toEqual([{ status: 'cancelled' }]);
  }
  expect(f.notices()[0]!.payload).toMatchObject({ bookingId: f.booking.id, channels: ['email', 'sms'] });
  await f.run(); expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
});

describe('a booking superseded by a later one, with equal clock timestamps', () => {
  const createdAt = (f: Awaited<ReturnType<typeof fixture>>) => db.forGym(f.gymId, tx => tx.select({ id: classBookings.id, createdAt: classBookings.createdAt })
    .from(classBookings).where(eq(classBookings.memberId, f.child.id)));

  it('sends nothing for the original once the member rebooks and the portal cancels the replacement', async () => {
    const f = await fixture(), payer = await factory('authUser', f.gymId);
    await factory('householdUsers', f.gymId, { householdId: f.home.id, userId: payer.id, memberId: f.child.id, scope: 'payer' });
    const identity = { gymId: f.gymId, householdId: f.home.id, userId: payer.id };
    const portal = createPortalBookingService({ households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold,
      bookings: f.service, delivery: () => f.delivery });
    await f.cancel(['email', 'sms'], 'Staff note for the first booking.');
    const again = await portal.book(identity, { sessionId: f.session.id, allowWaitlist: true });
    expect(again).toMatchObject({ status: 'booked' }); expect(again.id).not.toBe(f.booking.id);
    expect(await portal.cancel(identity, again.id)).toMatchObject({ id: again.id, status: 'cancelled' });
    // Both rows were created at the same clock instant; only the ID orders them.
    expect(new Set((await createdAt(f)).map(row => row.createdAt.getTime())).size).toBe(1);
    // The portal cancellation queues no notice of its own, and the original notice is now stale.
    expect(f.notices()).toHaveLength(1);
    await f.drain();
    expect(f.notices()[0]!.status).toBe('completed');
    expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
  });

  it('sends only the latest staff note when staff cancel the member again', async () => {
    const f = await fixture();
    await f.cancel(['email', 'sms'], 'Note A');
    const again = (await f.service.book(f.actor, { memberId: f.child.id, sessionId: f.session.id, allowWaitlist: true })).booking;
    await f.cancel(['email', 'sms'], 'Note B', again.id);
    expect(new Set((await createdAt(f)).map(row => row.createdAt.getTime())).size).toBe(1);
    expect(f.notices().map(job => job.payload)).toMatchObject([{ bookingId: f.booking.id, note: 'Note A' }, { bookingId: again.id, note: 'Note B' }]);
    await f.drain();
    expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
    expect(f.email.messages[0]!.text).toContain('Note B'); expect(f.email.messages[0]!.text).not.toContain('Note A');
    expect((await db.forGym(f.gymId, tx => tx.select({ key: emailDeliveries.key }).from(emailDeliveries))).map(row => row.key))
      .toEqual([`booking-cancel-email:${again.id}`]);
    expect((await db.forGym(f.gymId, tx => tx.select({ key: smsDeliveries.key }).from(smsDeliveries))).map(row => row.key))
      .toEqual([`booking-cancel-sms:${again.id}`]);
  });
});

it.each(['emailSwitch', 'emailOptOut', 'smsSwitch', 'smsConsent'] as const)('suppresses only the channel after %s, decided before handling', async change => {
  const f = await fixture(); await f.cancel(['email', 'sms']);
  await db.forGym(f.gymId, async tx => {
    if (change === 'emailSwitch') await tx.update(gyms).set({ memberEmailsEnabled: false }).where(eq(gyms.id, f.gymId));
    else if (change === 'smsSwitch') await tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, f.gymId));
    else if (change === 'emailOptOut') await tx.update(members).set({ emailOptOut: true }).where(eq(members.id, f.child.id));
    else await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
  });
  await f.run();
  const emailOff = change === 'emailSwitch' || change === 'emailOptOut';
  expect(f.email.messages).toHaveLength(emailOff ? 0 : 1); expect(f.sms.messages).toHaveLength(emailOff ? 1 : 0);
});

it.each(['disabled', 'consent', 'phone'] as const)('rechecks the text %s after resolving provider credentials', async change => {
  const f = await fixture(); await f.cancel(['sms']);
  f.resolver.resolve.mockImplementation(async id => {
    await db.forGym(id, tx => change === 'disabled' ? tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, id))
      : tx.update(households).set(change === 'consent' ? { smsNoticesConsentAt: null, smsNoticesConsentSource: null }
        : { phone: '+12025550198', phoneE164: '+12025550198' }).where(eq(households.id, f.home.id)));
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.run(); expect(f.sms.messages).toHaveLength(0);
});

it.each(['ownPhone', 'rebooked'] as const)('sends nothing to the household phone when the %s change lands while credentials resolve', async change => {
  const f = await fixture(), own = '+12025550199'; await f.cancel(['sms']);
  f.resolver.resolve.mockImplementationOnce(async id => {
    // The household phone keeps its consent and number, so only a recheck of the member's own route catches this.
    if (change === 'ownPhone') await db.forGym(id, tx => tx.update(members).set({ phone: own, phoneE164: own,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id)));
    else await f.service.book(f.actor, { memberId: f.child.id, sessionId: f.session.id, allowWaitlist: true });
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.run();
  expect(f.resolver.resolve).toHaveBeenCalledOnce();
  expect(f.sms.messages).toHaveLength(0);
  // The suppression is recorded as a proven non-send.
  expect(await db.forGym(f.gymId, tx => tx.select({ state: smsDeliveries.state }).from(smsDeliveries))).toEqual([{ state: 'not_accepted' }]);
  // Run again, the notice follows the current route: the member's own phone, or nobody once they are booked again.
  await f.run();
  expect(f.sms.messages.map(message => message.to)).toEqual(change === 'ownPhone' ? [own] : []);
});

it.each(['ownPhone', 'rebooked', 'unchanged'] as const)('decides the text recipient in the cap transaction after a %s change during the settings read', async change => {
  const f = await fixture(), own = '+12025550199'; await f.cancel(['sms']);
  // The change lands in MemberSms's own settings read, after the resolver returned and the last earlier recipient read.
  const real = createGymSettingsAccessor({ scope: db.forGym }); let pending = change !== 'unchanged';
  const settings: GymSettingsAccessor = { async get(id) {
    const value = await real.get(id);
    if (pending && f.resolver.resolve.mock.calls.length) {
      pending = false;
      // The household phone keeps its consent and number, so only the last check of the member's own route catches this.
      if (change === 'ownPhone') await db.forGym(id, tx => tx.update(members).set({ phone: own, phoneE164: own,
        smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id)));
      else await f.service.book(f.actor, { memberId: f.child.id, sessionId: f.session.id, allowWaitlist: true });
    }
    return value;
  } };
  const delivery = createBookingDelivery({ scope: db.forGym, clock: f.clock, jobs: new FakeJobs(f.clock), settings, mailer: async () => f.email,
    sms: { resolver: f.resolver, phoneDigest: createSmsPhoneDigest('cancel-notice-test') } });
  await delivery.sendCancelNotice(f.notices()[0]!.payload, f.gymId);
  expect(pending).toBe(false);
  const usage = await db.forGym(f.gymId, tx => tx.select().from(smsDailyUsage));
  const texts = await db.forGym(f.gymId, tx => tx.select({ state: smsDeliveries.state }).from(smsDeliveries));
  if (change === 'unchanged') {
    expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
    expect(usage).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
    expect(texts).toEqual([{ state: 'accepted' }]);
  } else {
    expect(f.sms.messages).toHaveLength(0);
    expect(usage).toEqual([]);
    expect(texts).toEqual([{ state: 'not_accepted' }]);
  }
});

it('rechecks the email address at the last boundary', async () => {
  const f = await fixture(); await f.cancel(['email']);
  const moving = createBookingDelivery({ scope: db.forGym, clock: f.clock, jobs: f.jobs, mailer: async () => {
    await db.forGym(f.gymId, tx => tx.update(households).set({ email: 'moved@example.test' }).where(eq(households.id, f.home.id)));
    return f.email;
  } });
  await moving.sendCancelNotice(f.notices()[0]!.payload, f.gymId);
  expect(f.email.messages).toHaveLength(0);
});

it.each(['email', 'sms'] as const)('retries after the %s channel fails without resending the accepted one', async failing => {
  const f = await fixture(); await f.cancel(['email', 'sms']);
  if (failing === 'email') f.email.respondNext(new DeliveryError('not_accepted', 'SMTP refused'));
  else f.sms.respondNext(new DeliveryError('not_accepted', 'Provider refused'));
  await f.drain();
  expect(f.notices()[0]!.status).toBe('queued');
  // The failing channel was attempted; the other went out.
  expect(f.email.messages).toHaveLength(failing === 'email' ? 0 : 1); expect(f.sms.messages).toHaveLength(failing === 'sms' ? 0 : 1);
  await f.run(); await f.run();
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
});

it('retries a failed settings read after reserving the text without repeating the email', async () => {
  const f = await fixture();
  await f.cancel(['email', 'sms']);
  const get = f.settings.get.bind(f.settings);
  const failure = vi.spyOn(f.settings, 'get').mockImplementation(async gymId => {
    if (await db.forGym(gymId, tx => tx.$count(smsDeliveries, eq(smsDeliveries.state, 'sending'))))
      throw new Error('Settings unavailable');
    return get(gymId);
  });
  await expect(f.run()).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(f.resolver.resolve).not.toHaveBeenCalled();
  expect(f.sms.messages).toHaveLength(0);
  expect(f.email.messages).toHaveLength(1);
  failure.mockRestore();
  await f.run();
  expect(f.sms.messages).toHaveLength(1);
  expect(f.email.messages).toHaveLength(1);
});

it('never resends a notice whose acceptance is unknown', async () => {
  const f = await fixture(); await f.cancel(['email', 'sms']);
  f.email.respondNext(new DeliveryError('unknown', 'SMTP reply lost')); f.sms.respondNext(new DeliveryError('unknown', 'Provider reply lost'));
  await expect(f.run()).rejects.toThrow();
  await f.run(); expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
});

it('keeps a promotion its own notice when a staff cancellation opens the place', async () => {
  const f = await fixture();
  const waiting = await factory('members', f.gymId, { firstName: 'Noa', email: 'noa@example.test' });
  const queued = (await f.service.book(f.actor, { memberId: waiting.id, sessionId: f.session.id, allowWaitlist: true })).booking;
  expect(queued.status).toBe('waitlisted');
  await f.cancel(['email']);
  // The promotion runs first and queues its own notice behind the cancellation notice.
  expect(await f.jobs.runNext()).toBe(true);
  expect(f.jobs.jobs.map(job => [job.name, job.status])).toEqual([[promotionJob, 'completed'], [cancelNoticeJob, 'queued'], [noticeJob, 'queued']]);
  await f.drain();
  expect(f.email.messages.map(message => message.to).sort()).toEqual(['noa@example.test', 'parent@example.test']);
  expect(f.email.messages.find(message => message.to === 'noa@example.test')!.subject).toContain('confirmed');
});

it('reads only its own gym booking', async () => {
  const f = await fixture(), g = await fixture();
  await g.cancel(['email', 'sms']);
  await f.delivery.sendCancelNotice(g.notices()[0]!.payload, f.gymId);
  expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
  expect(g.email.messages).toHaveLength(0); expect(g.sms.messages).toHaveLength(0);
});
