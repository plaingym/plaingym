// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated integration fixtures change the email switch and encrypted gym SMTP settings.
import { auditEvents, classBookings, classSessions, gyms, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { encryptSmtpConfig } from '../settings/smtp.js';
import { captureSmtp } from '../../infra/email/test-smtp.js';
import { createBookingService } from './bookings.js';
import { createBookingDelivery, createBookingMailer, noticeJob, promotionJob } from './bookings.delivery.js';
import { createBookingJobs } from './bookings.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-29T16:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Martial Arts', bookingWindowDays: 7, timezone: 'America/New_York', memberEmailsEnabled: true });
  const user = await factory('authUser', gymId), first = await factory('members', gymId), waiting = await factory('members', gymId, { email: 'waiting@example.invalid' });
  const session = await factory('classSessions', gymId, { name: 'Practice <with partners>', capacity: 1, startsAt: new Date('2026-10-30T18:00:00Z'), endsAt: new Date('2026-10-30T19:00:00Z') });
  const options = { scope: db.forGym, clock }, service = createBookingService(options), email = new FakeEmail(), jobs = new FakeJobs(clock);
  const delivery = createBookingDelivery({ ...options, jobs, mailer: async () => email });
  createServerRegistry({ jobs: createBookingJobs(() => delivery) }).registerJobs(jobs, new Set());
  const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const booked = await service.book(actor, { memberId: first.id, sessionId: session.id, allowWaitlist: true });
  const queued = await service.book(actor, { memberId: waiting.id, sessionId: session.id, allowWaitlist: true });
  await service.cancel(actor, booked.id);
  return { gymId, clock, first, waiting, session, options, service, email, jobs, delivery, actor, booked, queued };
}
async function drain(jobs: FakeJobs) { for (let n = 0; n < 20; n++) if (!await jobs.runNext()) return; throw new Error('Unexpected job loop'); }

describe('promotion jobs and notices', () => {
  it('registered jobs promote once and deliver one escaped, gym-local notice on replay', async () => {
    const f = await fixture();
    await f.delivery.request(f.gymId, f.session.id, f.booked.id);
    await f.delivery.request(f.gymId, f.session.id, f.booked.id);
    expect(f.jobs.jobs.filter(row => row.name === promotionJob)).toHaveLength(1);
    await drain(f.jobs); await f.delivery.promote(f.gymId, f.session.id); await f.delivery.sweep(f.gymId); await drain(f.jobs);
    await f.delivery.send(f.gymId, f.queued.id);
    expect(f.email.messages).toHaveLength(1);
    expect(f.email.messages[0]).toMatchObject({ to: 'waiting@example.invalid', subject: 'Your place in Practice <with partners> is confirmed' });
    expect(f.email.messages[0]!.html).toContain('&lt;with partners&gt;');
    expect(f.email.messages[0]!.text).toContain('2:00 PM');
    expect(f.email.messages[0]!.html).toContain('Cedar Martial Arts');
    expect(f.email.messages[0]!.text).toContain('Cedar Martial Arts');
    expect(f.jobs.jobs.filter(row => row.name === noticeJob)).toHaveLength(1);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.promoted')))).toBe(1);
  });
  it('recovers committed cancellations and promotions after a restart before enqueue', async () => {
    const f = await fixture();
    expect(createBookingJobs().find(job => job.id === 'bookings.recover')?.cron).toBe('*/5 * * * *');
    // The periodic job recovers a cancellation for which no queue request was made.
    await f.jobs.triggerSchedule('bookings.recover', [{ gymId: f.gymId, timezone: 'America/New_York' }], 'five-minute-1');
    await drain(f.jobs); expect(f.email.messages).toHaveLength(1);
    const g = await fixture(); await g.service.promote(g.gymId, g.session.id);
    const restarted = createBookingDelivery({ ...g.options, jobs: g.jobs, mailer: async () => g.email });
    await restarted.sweep(g.gymId); await drain(g.jobs);
    expect(g.email.messages).toHaveLength(1);
  });
  it('the queued promotion and the recovery job stop at the cancellation cutoff', async () => {
    const f = await fixture();
    // The default cutoff is 60 minutes before the 18:00 UTC start.
    f.clock.set('2026-10-30T17:00:00.001Z');
    await f.delivery.request(f.gymId, f.session.id, f.booked.id);
    await f.jobs.triggerSchedule('bookings.recover', [{ gymId: f.gymId, timezone: 'America/New_York' }], 'five-minute-late');
    await drain(f.jobs);
    expect(f.email.messages).toHaveLength(0);
    expect((await f.service.list(f.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === f.queued.id)?.status).toBe('waitlisted');
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.promoted')))).toBe(0);
    const g = await fixture();
    g.clock.set('2026-10-30T17:00:00Z');
    await g.jobs.triggerSchedule('bookings.recover', [{ gymId: g.gymId, timezone: 'America/New_York' }], 'five-minute-boundary');
    await drain(g.jobs);
    expect((await g.service.list(g.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === g.queued.id)?.status).toBe('booked');
  });
  it('retries failed SMTP delivery without re-promoting the booking', async () => {
    const f = await fixture(); f.email.respondNext(new Error('SMTP temporarily unavailable'));
    await f.delivery.promote(f.gymId, f.session.id); await drain(f.jobs);
    expect(f.email.messages).toHaveLength(0);
    f.clock.advance(1000); await drain(f.jobs);
    expect(f.email.messages).toHaveLength(1);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.promoted')))).toBe(1);
  });
  it.each(['disabled', 'opt_out', 'undeliverable', 'cancelled', 'erased', 'session_cancelled', 'started'] as const)('does not send a stale or suppressed %s notice', async reason => {
    const f = await fixture(); await f.delivery.promote(f.gymId, f.session.id);
    if (reason === 'disabled') {
      await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberEmailsEnabled: false }).where(eq(gyms.id, f.gymId)));
    } else if (reason === 'cancelled') await f.service.cancel(f.actor, f.queued.id);
    else if (reason === 'started') f.clock.set(f.session.startsAt);
    else if (reason === 'session_cancelled') await db.forGym(f.gymId, tx => tx.update(classSessions).set({ status: 'cancelled' }).where(eq(classSessions.id, f.session.id)));
    else await db.forGym(f.gymId, tx => tx.update(members).set(reason === 'opt_out' ? { emailOptOut: true } : reason === 'undeliverable' ? { emailDeliverable: false } : { anonymizedAt: f.clock.now() }).where(eq(members.id, f.waiting.id)));
    await drain(f.jobs); expect(f.email.messages).toHaveLength(0);
    expect((await f.service.list(f.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === f.queued.id)?.status).toBe(reason === 'cancelled' ? 'cancelled' : 'booked');
  });
  it('cannot promote or mail a different gym and cannot mail an ordinary booking', async () => {
    const f = await fixture(), g = await fixture();
    await expect(f.delivery.promote(f.gymId, g.session.id)).rejects.toMatchObject({ code: 'not_found' });
    await g.delivery.promote(g.gymId, g.session.id);
    await f.delivery.send(f.gymId, g.queued.id); await f.delivery.send(f.gymId, f.booked.id);
    expect(f.email.messages).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.$count(classBookings, and(eq(classBookings.id, f.queued.id), eq(classBookings.status, 'waitlisted'))))).toBe(1);
  });
  it('completes notices without SMTP while retaining the promoted place and no sent audit', async () => {
    const f = await fixture();
    const delivery = createBookingDelivery({ ...f.options, jobs: f.jobs, mailer: async () => null });
    await delivery.promote(f.gymId, f.session.id);
    await expect(delivery.send(f.gymId, f.queued.id)).resolves.toBeUndefined();
    expect((await f.service.list(f.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === f.queued.id)?.status).toBe('booked');
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.notice_sent')))).toBe(0);
  });
  it('resolves an unconfigured gym mailer without using a global sender', async () => {
    const f = await fixture();
    const mailer = createBookingMailer({ scope: db.forGym, key: Buffer.alloc(32, 1), env: {} });
    expect(await mailer(f.gymId)).toBeNull();
  });
  it('sends the notice through this gym\'s encrypted SMTP configuration instead of the install fallback', async () => {
    const f = await fixture(), capture = await captureSmtp({ user: 'gym', pass: 'fixture' }), key = Buffer.alloc(32, 1);
    try {
      const smtpConfig = encryptSmtpConfig(key, { host: '127.0.0.1', port: capture.port, security: 'plain',
        from: 'gym@example.invalid', username: 'gym', password: 'fixture' });
      await db.forGym(f.gymId, tx => tx.update(gyms).set({ smtpConfig }).where(eq(gyms.id, f.gymId)));
      const mailer = createBookingMailer({ scope: db.forGym, key, env: { SMTP_HOST: 'invalid.local', SMTP_FROM: 'install@example.invalid' } });
      const delivery = createBookingDelivery({ ...f.options, jobs: f.jobs, mailer });
      await delivery.promote(f.gymId, f.session.id); await delivery.send(f.gymId, f.queued.id);
      expect(capture.messages).toHaveLength(1);
      expect(capture.messages[0]).toContain('From: gym@example.invalid');
      expect(capture.messages[0]).toContain('To: waiting@example.invalid');
    } finally { await capture.close(); }
  });
});
