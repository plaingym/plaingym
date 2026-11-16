// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated fixtures exercise the persisted independent member SMS switch.
import { classBookings, classSessions, gyms, households, members, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, DeliveryError, FakeSms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { createBookingService } from './bookings.js';
import { createBookingDelivery } from './bookings.delivery.js';
import { createBookingJobs } from './bookings.jobs.js';

const db = useTestDatabase(), factory = createFactories(db), phone = '+12025550123';
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', settings: { address: { country: 'US' } }, timezone: 'America/New_York', memberEmailsEnabled: true, memberSmsEnabled: true });
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
