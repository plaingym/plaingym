// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, members, smsDailyUsage, smsDeliveries, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- One extra app-role connection holds the row lock in this disposable test database.
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, FakeSms, SmsRecheckBusy } from '../../infra/sms/index.js';
import { createBookingService } from './bookings.js';
import { cancelNoticeJob } from './bookings.cancel-notice.js';
import { createBookingDelivery } from './bookings.delivery.js';
import { createBookingJobs } from './bookings.jobs.js';
import { shareNoticeRecipients } from './bookings.sms.js';

const db = useTestDatabase(), factory = createFactories(db), phone = '+12025550123';

it('routes the staff cancellation text last check through bookings.sms.ts instead of duplicating its locks', () => {
  const source = readFileSync(new URL('./bookings.cancel-notice.ts', import.meta.url), 'utf8');
  expect(source).toContain('lockBookingNotice(');
  expect(source).toContain('noticeCapSettings(');
  expect(source).not.toContain(".for('share'");
  expect(source).not.toContain('noWait');
  expect(source).not.toContain('holdGymSettings(');
  expect(source).not.toContain('55P03');
});

it.each(['promotion', 'cancellation'] as const)('gives way on a busy member lock (no slot taken) until released, then sends the %s text once', async kind => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', address: { country: 'US' }, timezone: 'America/New_York', memberEmailsEnabled: true, memberSmsEnabled: true });
  const user = await factory('authUser', gymId);
  const home = await factory('households', gymId, { email: 'parent@example.test', phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const child = await factory('members', gymId, { householdId: home.id, firstName: 'Mia', lastName: 'Rivera' });
  const session = await factory('classSessions', gymId, { name: 'Evening practice', capacity: 1,
    startsAt: new Date('2026-11-11T00:30:00Z'), endsAt: new Date('2026-11-11T01:30:00Z') });
  const service = createBookingService({ scope: db.forGym, clock });
  const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const email = new FakeEmail(), sms = new FakeSms(), jobs = new FakeJobs(clock);
  const resolver = { resolve: vi.fn(async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms }; }),
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true };

  let busyCalls = 0;
  const gaveWay = Promise.withResolvers<void>();
  const scope: typeof db.forGym = (id, fn) => db.forGym(id, async tx => {
    try { return await fn(tx); }
    catch (error) {
      if (error instanceof SmsRecheckBusy) { busyCalls++; gaveWay.resolve(); }
      throw error;
    }
  });
  const delivery = createBookingDelivery({ scope, clock, jobs, mailer: async () => email,
    sms: { resolver, phoneDigest: createSmsPhoneDigest('notice-lock-test') } });
  createServerRegistry({ jobs: createBookingJobs(() => delivery) }).registerJobs(jobs, new Set());

  let sendNotice: () => Promise<unknown>;
  let expectedKey: string;
  if (kind === 'promotion') {
    const first = await factory('members', gymId);
    const booked = (await service.book(actor, { memberId: first.id, sessionId: session.id, allowWaitlist: true })).booking;
    const queued = (await service.book(actor, { memberId: child.id, sessionId: session.id, allowWaitlist: true })).booking;
    await service.cancel(actor, booked.id);
    await delivery.promote(gymId, session.id);
    expectedKey = `booking-promotion-sms:${queued.id}`;
    sendNotice = () => delivery.send(gymId, queued.id);
  } else {
    const booking = (await service.book(actor, { memberId: child.id, sessionId: session.id, allowWaitlist: true })).booking;
    await service.cancel(actor, booking.id, undefined, { channels: ['sms'], note: '', enqueue: delivery.enqueueCancelNotice });
    const notice = jobs.jobs.find(job => job.name === cancelNoticeJob)!;
    expectedKey = `booking-cancel-sms:${booking.id}`;
    sendNotice = () => delivery.sendCancelNotice(notice.payload, gymId);
  }

  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const unblock = setTimeout(() => release.resolve(), 15_000);
  const holderConnection = openConnection(db.appUrl, 1);
  const holder = scopedDatabase(holderConnection.db).forGym(gymId, async tx => {
    await tx.select({ id: members.id }).from(members).where(eq(members.id, child.id)).for('update');
    held.resolve();
    await release.promise;
  });
  let sending: Promise<unknown> | undefined;
  try {
    await Promise.race([held.promise, holder]);
    sending = sendNotice();
    sending.catch(() => undefined);
    await Promise.race([gaveWay.promise, sending]);
    expect(busyCalls).toBeGreaterThanOrEqual(1);
    expect(sms.messages).toHaveLength(0);
    expect(await db.forGym(gymId, tx => tx.select().from(smsDailyUsage))).toEqual([]);
  } finally {
    clearTimeout(unblock);
    release.resolve();
    await Promise.allSettled([holder, sending]);
    await holderConnection.close();
  }
  await Promise.all([holder, sending]);
  expect(sms.messages.map(message => message.to)).toEqual([phone]);
  expect(await db.forGym(gymId, tx => tx.select().from(smsDailyUsage))).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
  expect(await db.forGym(gymId, tx => tx.select({ key: smsDeliveries.key, state: smsDeliveries.state }).from(smsDeliveries)))
    .toEqual([{ key: expectedKey, state: 'accepted' }]);
});

it('shareNoticeRecipients returns false when any member is missing and throws SmsRecheckBusy when a household is locked', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { name: 'Cedar Gym', address: { country: 'US' } });
  const home = await factory('households', gymId);
  const member = await factory('members', gymId, { householdId: home.id });

  expect(await db.forGym(gymId, tx => shareNoticeRecipients(tx, gymId, [member.id, uuidv7()]))).toBe(false);
  expect(await db.forGym(gymId, tx => shareNoticeRecipients(tx, gymId, [member.id, member.id]))).toBe(true);

  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const unblock = setTimeout(() => release.resolve(), 15_000);
  const holderConnection = openConnection(db.appUrl, 1);
  const holder = scopedDatabase(holderConnection.db).forGym(gymId, async tx => {
    await tx.select({ id: households.id }).from(households).where(eq(households.id, home.id)).for('update');
    held.resolve();
    await release.promise;
  });
  try {
    await Promise.race([held.promise, holder]);
    await expect(db.forGym(gymId, tx => shareNoticeRecipients(tx, gymId, [member.id]))).rejects.toBeInstanceOf(SmsRecheckBusy);
  } finally {
    clearTimeout(unblock);
    release.resolve();
    await Promise.allSettled([holder]);
    await holderConnection.close();
  }
  await holder;
});
