// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- SQL only reads a backend ID and that backend's lock wait.
import { sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated fixtures exercise the persisted independent member SMS switch.
import { classBookings, classSessions, gyms, households, members, smsDailyUsage, smsDeliveries, uuidv7, type Transaction } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- One extra app-role connection holds the lock in this disposable test database.
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, DeliveryError, FakeSms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { createBookingService } from './bookings.js';
import { createBookingDelivery } from './bookings.delivery.js';
import { createBookingJobs } from './bookings.jobs.js';
import { createBookingSms } from './bookings.sms.js';
import { createMembersService } from '../members/members.js';

const db = useTestDatabase(), factory = createFactories(db), phone = '+12025550123';
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', address: { country: 'US' }, timezone: 'America/New_York', memberEmailsEnabled: true, memberSmsEnabled: true });
  const user = await factory('authUser', gymId);
  const home = await factory('households', gymId, { email: ' PARENT@example.test ', phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const first = await factory('members', gymId), child = await factory('members', gymId, { householdId: home.id, firstName: 'Mia' });
  const session = await factory('classSessions', gymId, { name: 'Evening practice', capacity: 1,
    startsAt: new Date('2026-11-11T00:30:00Z'), endsAt: new Date('2026-11-11T01:30:00Z') });
  const options = { scope: db.forGym, clock }, service = createBookingService(options), actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const booked = (await service.book(actor, { memberId: first.id, sessionId: session.id, allowWaitlist: true })).booking;
  const queued = (await service.book(actor, { memberId: child.id, sessionId: session.id, allowWaitlist: true })).booking;
  await service.cancel(actor, booked.id);
  const email = new FakeEmail(), sms = new FakeSms(), jobs = new FakeJobs(clock);
  const resolver = { resolve: vi.fn(async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms }; }),
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true };
  const deliveryOptions = { ...options, jobs, mailer: vi.fn(async () => email), sms: { resolver, phoneDigest: createSmsPhoneDigest('class-notice-test') } };
  const delivery = createBookingDelivery(deliveryOptions);
  createServerRegistry({ jobs: createBookingJobs(() => delivery) }).registerJobs(jobs, new Set());
  await delivery.promote(gymId, session.id);
  return { gymId, clock, home, first, child, session, service, actor, booked, queued, email, sms, jobs, resolver,
    options: deliveryOptions, delivery, run: () => delivery.send(gymId, queued.id) };
}

it('texts and emails the promoted child parent once through the registered job, even after the email sent audit', async () => {
  const f = await fixture(); expect(await f.jobs.runNext()).toBe(true);
  await Promise.allSettled([f.run(), f.run()]); await f.run();
  expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
  expect(f.sms.messages[0]!.to).toBe(phone); expect(f.sms.messages[0]!.body).toMatch(/^Cedar Gym: /);
  expect(f.email.messages[0]!.to).toBe('parent@example.test'); expect(f.email.messages[0]!.text).toContain('Mia');
  for (const value of ['Mia', 'Evening practice', '2026-11-10', '7:30 PM EST']) expect(f.sms.messages[0]!.body).toContain(value);
  expect(await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries))).toMatchObject([{ key: `booking-promotion-sms:${f.queued.id}`, state: 'accepted' }]);
});

it.each(['none', 'announcements'] as const)('does not text with %s consent alone and still sends the email', async consent => {
  const f = await fixture();
  await db.forGym(f.gymId, async tx => {
    await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
    await tx.update(members).set({ phone, phoneE164: phone,
      ...(consent === 'announcements' ? { smsAnnouncementsConsentAt: f.clock.now(), smsAnnouncementsConsentSource: 'portal' } : {}) }).where(eq(members.id, f.child.id));
  });
  await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(1);
});

it('prefers the promoted member own consented phone and own email to the household contacts', async () => {
  const f = await fixture(), own = '+12025550199';
  await db.forGym(f.gymId, tx => tx.update(members).set({ phone: own, phoneE164: own, email: 'mia@example.test',
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id)));
  await f.run(); expect(f.sms.messages.map(message => message.to)).toEqual([own]);
  expect(f.email.messages.map(message => message.to)).toEqual(['mia@example.test']);
});

it('does not couple the SMS switch, missing email or SMTP, or an email failure to the text send', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, f.gymId)));
  await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(1);
  await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: true, memberEmailsEnabled: false }).where(eq(gyms.id, f.gymId)));
  await f.run(); expect(f.sms.messages).toHaveLength(1);
  const g = await fixture();
  await db.forGym(g.gymId, tx => tx.update(households).set({ email: null }).where(eq(households.id, g.home.id)));
  await g.run(); expect(g.email.messages).toHaveLength(0); expect(g.sms.messages).toHaveLength(1);
  const h = await fixture();
  const noSmtp = createBookingDelivery({ ...h.options, mailer: async () => null });
  await noSmtp.send(h.gymId, h.queued.id); expect(h.sms.messages).toHaveLength(1);
  const j = await fixture(); j.email.respondNext(new DeliveryError('unknown', 'SMTP reply lost'));
  await expect(j.run()).rejects.toThrow(); expect(j.sms.messages).toHaveLength(1);
  await j.run(); expect(j.sms.messages).toHaveLength(1);
});

it.each(['accepted', 'unknown', 'sending'] as const)('never resends a stored %s promotion text', async state => {
  const f = await fixture();
  await factory('smsDeliveries', f.gymId, { key: `booking-promotion-sms:${f.queued.id}`, state,
    updatedAt: new Date(f.clock.now().getTime() - smsInFlightMs) });
  await f.run(); await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(1);
});

it('survives a crash after SMS acceptance without repeating either channel', async () => {
  const f = await fixture(); let broken = true;
  const scope: typeof db.forGym = (id, fn) => broken && f.sms.messages.length ? Promise.reject(new Error('Database unavailable')) : db.forGym(id, fn);
  const interrupted = createBookingDelivery({ ...f.options, scope });
  await expect(interrupted.send(f.gymId, f.queued.id)).rejects.toThrow();
  expect(f.sms.messages).toHaveLength(1); broken = false;
  f.clock.advance(smsInFlightMs); await interrupted.send(f.gymId, f.queued.id); await f.run();
  expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
});

it.each(['not_accepted', 'unknown'] as const)('retries only a definite non-send after SMS %s', async acceptance => {
  const f = await fixture(); f.sms.respondNext(new DeliveryError(acceptance, 'Provider reply lost'));
  await expect(f.run()).rejects.toThrow(); await f.run(); await f.run();
  expect(f.sms.messages).toHaveLength(acceptance === 'unknown' ? 0 : 1); expect(f.email.messages).toHaveLength(1);
});

it.each(['disabled', 'consent', 'phone', 'household'] as const)('rechecks %s after resolving provider credentials', async change => {
  const f = await fixture();
  const other = await factory('households', f.gymId, { phone: '+12025550199', phoneE164: '+12025550199', email: 'other@example.test',
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' });
  f.resolver.resolve.mockImplementation(async id => {
    await db.forGym(id, async tx => {
      if (change === 'disabled') await tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, id));
      else if (change === 'household') await tx.update(members).set({ householdId: other.id }).where(eq(members.id, f.child.id));
      else await tx.update(households).set(change === 'consent' ? { smsNoticesConsentAt: null, smsNoticesConsentSource: null }
        : { phone: '+12025550198', phoneE164: '+12025550198' }).where(eq(households.id, f.home.id));
    });
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(1);
});

const usage = (gymId: string) => db.forGym(gymId, tx => tx.select().from(smsDailyUsage));
const promotionTexts = (gymId: string) => db.forGym(gymId, tx => tx.select().from(smsDeliveries));
/** Runs one change while the provider credentials resolve inside the text attempt, then resolves normally. */
function changeDuringResolution(f: Awaited<ReturnType<typeof fixture>>, change: (tx: Transaction) => Promise<unknown>) {
  f.resolver.resolve.mockImplementationOnce(async id => {
    expect(isInTransaction()).toBe(false);
    await db.forGym(id, change);
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
}

it('suppresses a household text when the member gains their own consented phone during resolution, then texts that phone once', async () => {
  const f = await fixture(), own = '+12025550199', key = `booking-promotion-sms:${f.queued.id}`;
  const log = vi.fn(), previousSink = setLogSink(log);
  try {
    changeDuringResolution(f, tx => tx.update(members).set({ phone: own, phoneE164: own,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id)));
    await f.run();
    expect(f.resolver.resolve).toHaveBeenCalledTimes(1); expect(f.sms.messages).toHaveLength(0); expect(await usage(f.gymId)).toEqual([]);
    expect(await promotionTexts(f.gymId)).toMatchObject([{ key, state: 'not_accepted' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"phone_changed"'));
    await f.run(); await f.run();
    expect(f.sms.messages.map(message => message.to)).toEqual([own]);
    expect(await promotionTexts(f.gymId)).toMatchObject([{ key, state: 'accepted' }]);
    expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
  } finally { setLogSink(previousSink); }
});

it.each(['member_to_household', 'household_to_member'] as const)('accepts one text and one slot when consent switches %s at the same number during resolution', async direction => {
  const f = await fixture(), key = `booking-promotion-sms:${f.queued.id}`;
  if (direction === 'member_to_household') {
    await db.forGym(f.gymId, tx => tx.update(members).set({ phone, phoneE164: phone,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id)));
    changeDuringResolution(f, tx => tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null })
      .where(eq(members.id, f.child.id)));
  } else {
    changeDuringResolution(f, async tx => {
      await tx.update(members).set({ phone, phoneE164: phone, smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' })
        .where(eq(members.id, f.child.id));
      await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
    });
  }
  await f.run();
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(await promotionTexts(f.gymId)).toMatchObject([{ key, state: 'accepted' }]);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
});

it('builds the promotion body from the locked reschedule and timezone and loads the promotion once in the cap transaction', async () => {
  const f = await fixture();
  let resolved = false, loadsInCapTx = 0;
  f.resolver.resolve.mockImplementationOnce(async id => {
    expect(isInTransaction()).toBe(false);
    await db.forGym(id, async tx => {
      await tx.update(classSessions).set({ name: 'Late practice',
        startsAt: new Date('2026-11-11T02:00:00Z'), endsAt: new Date('2026-11-11T03:00:00Z') }).where(eq(classSessions.id, f.session.id));
      await tx.update(gyms).set({ timezone: 'America/Los_Angeles' }).where(eq(gyms.id, id));
    });
    resolved = true;
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  const load = vi.fn(async (tx: Transaction, gymId: string, bookingId: string) => {
    if (resolved) { expect(isInTransaction()).toBe(true); loadsInCapTx++; }
    const [row] = await tx.select({ memberId: classBookings.memberId, name: classSessions.name, startsAt: classSessions.startsAt })
      .from(classBookings).innerJoin(classSessions, eq(classSessions.id, classBookings.sessionId))
      .innerJoin(members, eq(members.id, classBookings.memberId))
      .where(and(eq(classBookings.gymId, gymId), eq(classBookings.id, bookingId), eq(classBookings.status, 'booked'), isNull(members.anonymizedAt)));
    return row && { memberId: row.memberId, session: { name: row.name, startsAt: row.startsAt } };
  });
  const send = createBookingSms({ scope: db.forGym, clock: f.clock, settings: createGymSettingsAccessor({ scope: db.forGym }), sms: f.options.sms, load });
  await send(f.gymId, f.queued.id);
  expect(loadsInCapTx).toBe(1);
  expect(f.sms.messages).toHaveLength(1);
  expect(f.sms.messages[0]!.to).toBe(phone);
  for (const value of ['Late practice', '2026-11-10', '6:00 PM PST']) expect(f.sms.messages[0]!.body).toContain(value);
  expect(f.sms.messages[0]!.body).not.toContain('Evening practice');
  expect(f.sms.messages[0]!.body).not.toContain('7:30 PM EST');
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ day: '2026-11-10', sent: 1, refused: 0 })]);
});

it.each(['cancelled', 'consent', 'unchanged'] as const)('rechecks the promotion and recipient after a %s change during resolution', async change => {
  const f = await fixture();
  changeDuringResolution(f, tx => change === 'cancelled'
    ? tx.update(classBookings).set({ status: 'cancelled' }).where(eq(classBookings.id, f.queued.id))
    : change === 'consent' ? tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id))
      : tx.select().from(households).where(eq(households.id, f.home.id)));
  await f.run();
  expect(f.resolver.resolve).toHaveBeenCalledTimes(1);
  if (change === 'unchanged') {
    expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
    expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
  } else {
    expect(f.sms.messages).toHaveLength(0); expect(await usage(f.gymId)).toEqual([]);
  }
});

/**
 * A sender whose settings snapshot goes stale: once credentials resolved, the change commits right after MemberSms reads
 * the gym settings, the last step before its cap transaction.
 */
function staleBeforeReservation(f: Awaited<ReturnType<typeof fixture>>, change: (tx: Transaction) => Promise<unknown>) {
  const real = createGymSettingsAccessor({ scope: db.forGym }); let pending = true;
  const settings: GymSettingsAccessor = { async get(id) {
    const value = await real.get(id);
    if (pending && f.resolver.resolve.mock.calls.length) { pending = false; await db.forGym(id, change); }
    return value;
  } };
  return () => createBookingDelivery({ ...f.options, settings }).send(f.gymId, f.queued.id);
}

it('decides the member-first recipient in the cap transaction, then texts the member own phone once on retry', async () => {
  const f = await fixture(), own = '+12025550199', key = `booking-promotion-sms:${f.queued.id}`;
  await staleBeforeReservation(f, tx => tx.update(members).set({ phone: own, phoneE164: own,
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.child.id)))();
  expect(f.sms.messages).toHaveLength(0); expect(await usage(f.gymId)).toEqual([]);
  expect(await promotionTexts(f.gymId)).toMatchObject([{ key, state: 'not_accepted' }]);
  await f.run(); await f.run();
  expect(f.sms.messages.map(message => message.to)).toEqual([own]);
  expect(await promotionTexts(f.gymId)).toMatchObject([{ key, state: 'accepted' }]);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
});

it.each(['disabled', 'cap'] as const)('uses the current %s setting at the cap reservation, not the earlier snapshot', async change => {
  const f = await fixture();
  if (change === 'cap') await db.forGym(f.gymId, tx => tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-10', sent: 1, createdAt: f.clock.now() }));
  await staleBeforeReservation(f, tx => tx.update(gyms).set(change === 'disabled' ? { memberSmsEnabled: false } : { smsDailyCap: 1 })
    .where(eq(gyms.id, f.gymId)))();
  expect(f.sms.messages).toHaveLength(0);
  expect(await usage(f.gymId)).toEqual(change === 'disabled' ? [] : [expect.objectContaining({ sent: 1, refused: 1 })]);
});

it.each(['charge', 'full'] as const)('uses the locked timezone for the usage day (%s), not the earlier snapshot', async change => {
  // 12:00 UTC is 2026-11-10 in the snapshot's New York, but already 2026-11-11 in Kiritimati.
  const f = await fixture();
  if (change === 'full') await db.forGym(f.gymId, async tx => {
    await tx.update(gyms).set({ smsDailyCap: 1 }).where(eq(gyms.id, f.gymId));
    await tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-11', sent: 1, createdAt: f.clock.now() });
  });
  await staleBeforeReservation(f, tx => tx.update(gyms).set({ timezone: 'Pacific/Kiritimati' }).where(eq(gyms.id, f.gymId)))();
  expect(f.sms.messages).toHaveLength(change === 'charge' ? 1 : 0);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ day: '2026-11-11', sent: 1, refused: change === 'charge' ? 0 : 1 })]);
});

it('validates a national-format household phone under the locked country, not the earlier snapshot', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.update(households).set({ phone: '(202) 555-0123' }).where(eq(households.id, f.home.id)));
  await staleBeforeReservation(f, tx => tx.update(gyms).set({ address: { country: 'GB' } }).where(eq(gyms.id, f.gymId)))();
  expect(f.sms.messages).toHaveLength(0); expect(await usage(f.gymId)).toEqual([]);
  expect(await promotionTexts(f.gymId)).toMatchObject([{ key: `booking-promotion-sms:${f.queued.id}`, state: 'not_accepted' }]);
});

/** A gym scope that reports each transaction's backend, and can hold a transaction open after its work. */
function tracked(onBackend: (pid: number) => void, hold?: () => Promise<void>): typeof db.forGym {
  return (gymId, fn) => db.forGym(gymId, async tx => {
    // eslint-disable-next-line database/system-tables -- This transaction's backend ID only; no system data changes.
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    onBackend(row!.pid);
    const result = await fn(tx);
    if (hold) await hold();
    return result;
  });
}
/** Waits until the backend `pid()` currently names is waiting on a lock. */
async function waitsOnLock(pid: () => number | undefined) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = pid();
    // eslint-disable-next-line database/system-tables -- Observe only the selected app backend; bounds this race without timing assumptions.
    if (current !== undefined && (await db.system.db.execute<{ waiting: boolean }>(sql`select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${current}`))[0]?.waiting === true) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The transaction never waited on a lock');
}
const bookingStatus = (f: Awaited<ReturnType<typeof fixture>>) => db.forGym(f.gymId, async tx =>
  (await tx.select({ status: classBookings.status }).from(classBookings).where(eq(classBookings.id, f.queued.id)))[0]!.status);

it('texts once when the sender holds the session first, and the waiting staff cancellation then follows its own path', async () => {
  const f = await fixture(), held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  await db.forGym(f.gymId, tx => tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-10', createdAt: f.clock.now() }));
  const unblock = setTimeout(() => release.resolve(), 15_000);
  // An extra connection holds the usage row, so the sender stops at the cap row with its last-check locks taken. The
  // test database's two-connection pool stays free for the sender and the cancellation.
  const holderConnection = openConnection(db.appUrl, 1);
  const holder = scopedDatabase(holderConnection.db).forGym(f.gymId, async tx => {
    await tx.select().from(smsDailyUsage).for('update'); held.resolve(); await release.promise;
  });
  let sender: number | undefined, staff: number | undefined, sending: Promise<unknown> | undefined, cancelling: Promise<unknown> | undefined;
  try {
    await Promise.race([held.promise, holder]);
    sending = createBookingDelivery({ ...f.options, scope: tracked(pid => { sender = pid; }) }).send(f.gymId, f.queued.id);
    sending.catch(() => undefined);
    await waitsOnLock(() => sender);
    cancelling = createBookingService({ scope: tracked(pid => { staff = pid; }), clock: f.clock,
      settings: createGymSettingsAccessor({ scope: db.forGym }) }).cancel(f.actor, f.queued.id);
    cancelling.catch(() => undefined);
    await waitsOnLock(() => staff);
  } finally {
    clearTimeout(unblock);
    release.resolve();
    await Promise.allSettled([holder, sending, cancelling]);
    await holderConnection.close();
  }
  await Promise.all([holder, sending, cancelling]);
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ day: '2026-11-10', sent: 1, refused: 0 })]);
  expect(await promotionTexts(f.gymId)).toMatchObject([{ key: `booking-promotion-sms:${f.queued.id}`, state: 'accepted' }]);
  expect(await bookingStatus(f)).toBe('cancelled');
});

it('sends no text and takes no slot when a staff cancellation wins the session lock before the last check', async () => {
  const f = await fixture(), held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const unblock = setTimeout(() => release.resolve(), 15_000);
  let sender: number | undefined, sending: Promise<unknown> | undefined;
  // The cancellation does its work, then keeps its transaction (and the session lock) open until released.
  const cancelling = createBookingService({ scope: tracked(() => undefined, async () => { held.resolve(); await release.promise; }),
    clock: f.clock, settings: createGymSettingsAccessor({ scope: db.forGym }) }).cancel(f.actor, f.queued.id);
  cancelling.catch(() => undefined);
  try {
    await Promise.race([held.promise, cancelling]);
    sending = createBookingDelivery({ ...f.options, scope: tracked(pid => { sender = pid; }) }).send(f.gymId, f.queued.id);
    sending.catch(() => undefined);
    await waitsOnLock(() => sender);
  } finally {
    clearTimeout(unblock);
    release.resolve();
    await Promise.allSettled([cancelling, sending]);
  }
  await Promise.all([cancelling, sending]);
  expect(await bookingStatus(f)).toBe('cancelled');
  expect(f.sms.messages).toEqual([]); expect(await usage(f.gymId)).toEqual([]);
  expect(await promotionTexts(f.gymId)).toMatchObject([{ key: `booking-promotion-sms:${f.queued.id}`, state: 'not_accepted' }]);
});

it.each(['erase', 'delete'] as const)('gives way to a staff %s that waits for the session the sender holds, with no text or slot', async action => {
  const f = await fixture(), paused = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const unblock = setTimeout(() => release.resolve(), 15_000);
  let resolved = false, held = false, staff: number | undefined, sending: Promise<unknown> | undefined, removing: Promise<unknown> | undefined;
  f.resolver.resolve.mockImplementation(async (id: string) => { resolved = true; return { gymId: id, name: 'Cedar Gym', sms: f.sms }; });
  // The promotion's eligibility. The first read after credentials resolve is the last check's reread, made with the
  // session lock held and before the member and household locks: it waits there until released, once.
  const load = async (tx: Transaction, gymId: string, bookingId: string) => {
    if (resolved && !held) { held = true; paused.resolve(); await release.promise; }
    const [row] = await tx.select({ memberId: classBookings.memberId, name: classSessions.name, startsAt: classSessions.startsAt })
      .from(classBookings).innerJoin(classSessions, eq(classSessions.id, classBookings.sessionId))
      .innerJoin(members, eq(members.id, classBookings.memberId))
      .where(and(eq(classBookings.gymId, gymId), eq(classBookings.id, bookingId), eq(classBookings.status, 'booked'), isNull(members.anonymizedAt)));
    return row && { memberId: row.memberId, session: { name: row.name, startsAt: row.startsAt } };
  };
  const send = createBookingSms({ scope: db.forGym, clock: f.clock, settings: createGymSettingsAccessor({ scope: db.forGym }), sms: f.options.sms, load });
  const [stored] = await db.forGym(f.gymId, tx => tx.select({ revision: members.revision }).from(members).where(eq(members.id, f.child.id)));
  const revision = stored!.revision;
  try {
    sending = send(f.gymId, f.queued.id);
    sending.catch(() => undefined);
    await Promise.race([paused.promise, sending]);
    // The staff operation locks the household and the member, then waits for the session the sender holds.
    const people = createMembersService({ scope: tracked(pid => { staff = pid; }), clock: f.clock });
    const context = { gymId: f.gymId, actor: { kind: 'system' as const } }, cleanup = { jobs: f.jobs, timezone: 'America/New_York' };
    removing = action === 'erase' ? people.eraseMember(context, f.child.id, { revision }, cleanup)
      : people.deleteMember(context, f.child.id, revision, cleanup);
    removing.catch(() => undefined);
    await waitsOnLock(() => staff);
  } finally {
    clearTimeout(unblock);
    release.resolve();
    await Promise.allSettled([sending, removing]);
  }
  await Promise.all([sending, removing]);
  const [child] = await db.forGym(f.gymId, tx => tx.select({ anonymizedAt: members.anonymizedAt }).from(members).where(eq(members.id, f.child.id)));
  if (action === 'erase') expect(child?.anonymizedAt).toBeInstanceOf(Date);
  else expect(child).toBeUndefined();
  expect(f.sms.messages).toEqual([]); expect(await usage(f.gymId)).toEqual([]);
  expect(await promotionTexts(f.gymId)).toMatchObject([{ key: `booking-promotion-sms:${f.queued.id}`, state: 'not_accepted' }]);
});

it.each(['cancelled', 'session_cancelled', 'started', 'erased'] as const)('never texts a stale %s promotion', async reason => {
  const f = await fixture();
  await db.forGym(f.gymId, async tx => {
    if (reason === 'cancelled') await tx.update(classBookings).set({ status: 'cancelled' }).where(eq(classBookings.id, f.queued.id));
    else if (reason === 'session_cancelled') await tx.update(classSessions).set({ status: 'cancelled' }).where(eq(classSessions.id, f.session.id));
    else if (reason === 'erased') await tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.child.id));
    else f.clock.set(f.session.startsAt);
  });
  await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(0);
});

it('never texts or emails another gym booking, an ordinary booking, or an unrelated household', async () => {
  const f = await fixture(), g = await fixture();
  const other = await factory('households', f.gymId, { email: 'other@example.test', phone: '+12025550198', phoneE164: '+12025550198',
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' });
  await factory('members', f.gymId, { householdId: other.id, firstName: 'Unrelated' });
  await f.delivery.send(f.gymId, g.queued.id); await f.delivery.send(f.gymId, f.booked.id);
  expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(0);
  await f.run(); expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(f.email.messages.map(message => message.to)).toEqual(['parent@example.test']);
  expect(f.sms.messages[0]!.body).not.toContain('Unrelated');
});

it('suppresses fallback email by the billing address rules without suppressing its consented SMS', async () => {
  const f = await fixture();
  await factory('members', f.gymId, { householdId: f.home.id, email: f.home.email, emailDeliverable: false });
  await f.run(); expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(1);
});
