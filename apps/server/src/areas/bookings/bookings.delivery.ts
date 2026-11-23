// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNull, notExists } from 'drizzle-orm';
import { auditEvents, classBookings, classSessions, forGym, members, writeAudit, type Transaction } from '@plaingym/db';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { createEmailDeliveries, DeliveryError, SmtpEmail, type Email } from '../../infra/email/index.js';
import { logEmailSuppression, type SuppressionReason } from '../../infra/email/member.js';
import { defaultSucceededRetentionDays, type JobTransaction, type Jobs } from '../../infra/jobs/index.js';
import { logError, logInfo } from '../../core/log.js';
import { createSmtpResolver } from '../settings/smtp.js';
import { createGymSettingsAccessor, createSettingsService } from '../settings/settings.js';
import { renderBookingPromotion } from '../../emails/bookings/bookings.js';
import { promoteWaitlist, type BookingOptions } from './bookings.js';
import { readMemberNoticeEmails } from './bookings.recipients.js';
import { createBookingSms, type ClassNoticeSmsOptions } from './bookings.sms.js';
import { createBookingCancelNotice, type CancelNotice } from './bookings.cancel-notice.js';

export const promotionJob = 'bookings.promote';
export const noticeJob = 'bookings.notice';
/**
 * A promotion notice's shelf life: the sweep and the notice job act only on promotions this recent. It matches the
 * queue's retention of succeeded jobs, so the sweep stops before a finished notice job's key could have been pruned.
 */
export const promotionNoticeDays = defaultSucceededRetentionDays;
// Read from stored jobs: a newer release may add keys, which this one ignores after a rollback.
export const promotionPayload = z.object({ sessionId: idSchema });
export const noticePayload = z.object({ bookingId: idSchema });

/** The runtime can supply its demo outbox instead; ordinary mail always resolves this gym's SMTP. */
export function createBookingMailer(options: Parameters<typeof createSmtpResolver>[0]): (gymId: string) => Promise<Email | null> {
  const smtp = createSmtpResolver(options);
  return async gymId => { const config = await smtp.config(gymId); return config ? new SmtpEmail(config) : null; };
}
export interface BookingDeliveryOptions extends BookingOptions {
  jobs: Jobs;
  mailer(gymId: string): Promise<Email | null>;
  sms?: ClassNoticeSmsOptions;
}
export function createBookingDelivery(options: BookingDeliveryOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? createGymSettingsAccessor({ scope });
  const deliveries = createEmailDeliveries({ scope, clock });
  const sendSms = createBookingSms({ scope, clock, settings, ...(options.sms ? { sms: options.sms } : {}),
    load: (tx, gymId, bookingId) => readNoticeIn(tx, gymId, bookingId, true) });
  const noticeKey = (bookingId: string) => `booking-promotion:${bookingId}`;
  async function enqueueNotice(gymId: string, bookingId: string) {
    const gym = await settings.get(gymId);
    await options.jobs.enqueue(noticeJob, { bookingId }, { gymId, timezone: gym.timezone,
      idempotencyKey: noticeKey(bookingId), maxAttempts: 18 });
  }
  async function promote(gymId: string, sessionId: string) {
    const rows = await promoteWaitlist(gymId, sessionId, { scope, clock, settings });
    for (const row of rows) await enqueueNotice(gymId, row.id);
    return rows;
  }
  const promotionKey = (cancellationId: string) => `booking-cancelled:${cancellationId}`;
  async function request(gymId: string, sessionId: string, cancellationId: string) {
    const gym = await settings.get(gymId);
    await options.jobs.enqueue(promotionJob, { sessionId }, { gymId, timezone: gym.timezone,
      idempotencyKey: promotionKey(cancellationId) });
  }
  /**
   * After-commit enqueues must not undo committed work: a failed notice or promotion request is logged with
   * identifiers only, and the five-minute recovery sweep owns it.
   */
  async function enqueueNotices(gymId: string, bookingIds: readonly string[]) {
    for (const bookingId of bookingIds) {
      try { await enqueueNotice(gymId, bookingId); }
      catch (error) { logError('bookings.notice_enqueue_failed', { gymId, bookingId }, error); }
    }
  }
  async function requestPromotion(gymId: string, sessionId: string, cancellationId: string) {
    try { await request(gymId, sessionId, cancellationId); }
    catch (error) { logError('bookings.promotion_enqueue_failed', { gymId, sessionId, cancellationId }, error); }
  }
  /** Promotions recent enough to notify: a notice that never went out is not sent weeks later. */
  const recentPromotion = () => and(eq(auditEvents.action, 'booking.promoted'),
    gt(auditEvents.occurredAt, new Date(clock.now().getTime() - promotionNoticeDays * 86_400_000)));
  /** Recovery for a crash after a booking commit, capacity edit or erasure, before enqueue. */
  async function sweep(gymId: string) {
    let cursor: string | undefined;
    for (;;) {
      const sessions = await scope(gymId, tx => tx.select({ id: classSessions.id }).from(classSessions).where(and(
        eq(classSessions.status, 'scheduled'), gt(classSessions.startsAt, clock.now()),
        cursor ? gt(classSessions.id, cursor) : undefined,
        inArray(classSessions.id, tx.select({ id: classBookings.sessionId }).from(classBookings).where(eq(classBookings.status, 'waitlisted')))))
        .orderBy(asc(classSessions.id)).limit(50));
      for (const session of sessions) await promote(gymId, session.id);
      if (sessions.length < 50) break;
      cursor = sessions.at(-1)!.id;
    }
    cursor = undefined;
    for (;;) {
      const pending = await scope(gymId, tx => tx.select({ id: classBookings.id }).from(classBookings)
        .innerJoin(classSessions, eq(classSessions.id, classBookings.sessionId)).where(and(
          eq(classBookings.status, 'booked'), eq(classSessions.status, 'scheduled'), gt(classSessions.startsAt, clock.now()),
          cursor ? gt(classBookings.id, cursor) : undefined,
          notExists(tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
            eq(auditEvents.targetId, classBookings.id), eq(auditEvents.action, 'booking.notice_sent')))),
          // Bounded, so a notice that finished without a sent audit (no SMTP, emails off, suppressed) is not
          // enqueued again once retention prunes its job key.
          inArray(classBookings.id, tx.select({ id: auditEvents.targetId }).from(auditEvents).where(recentPromotion()))))
        .orderBy(asc(classBookings.id)).limit(100));
      for (const booking of pending) await enqueueNotice(gymId, booking.id);
      if (pending.length < 100) break;
      cursor = pending.at(-1)!.id;
    }
  }
  function readNotice(gymId: string, bookingId: string, includeSent = false) {
    return scope(gymId, tx => readNoticeIn(tx, gymId, bookingId, includeSent));
  }
  /** The same read inside a caller's gym transaction, so the text sender can recheck it with its cap reservation. */
  async function readNoticeIn(tx: Transaction, gymId: string, bookingId: string, includeSent = false) {
    const [promotion] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, bookingId), recentPromotion()));
    const [sent] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, bookingId), eq(auditEvents.action, 'booking.notice_sent')));
    if (sent && !includeSent) return;
    if (!promotion) {
      if (!includeSent) logInfo('bookings.notice_skipped', { gymId, bookingId, reason: 'stale_or_missing_promotion' });
      return;
    }
    const [row] = await tx.select({ booking: classBookings, session: classSessions, memberId: members.id })
      .from(classBookings).innerJoin(classSessions, eq(classSessions.id, classBookings.sessionId))
      .innerJoin(members, eq(members.id, classBookings.memberId)).where(and(eq(classBookings.id, bookingId),
        eq(classBookings.status, 'booked'), eq(classSessions.status, 'scheduled'), gt(classSessions.startsAt, clock.now()), isNull(members.anonymizedAt)));
    return row;
  }
  async function sendEmail(gymId: string, bookingId: string) {
    const read = () => readNotice(gymId, bookingId);
    const gym = await settings.get(gymId);
    if (!gym.memberEmailsEnabled || !await read()) return;
    const email = await options.mailer(gymId);
    if (!email) return;
    const row = await read();
    if (!row) return;
    const [recipient] = await scope(gymId, tx => readMemberNoticeEmails(tx, gymId, [row.memberId]));
    if (!recipient) return;
    const details = await createSettingsService({ scope }).get(gymId);
    const suppress = (reason: SuppressionReason) => {
      logEmailSuppression({ event: 'email.suppressed', gymId, memberId: row.memberId, reason });
      return { status: 'suppressed', reason } as const;
    };
    const sender: Email = { async sendEmail() {
      let message: Awaited<ReturnType<typeof renderBookingPromotion>>;
      try {
        if (!(await settings.get(gymId)).memberEmailsEnabled) return suppress('disabled');
        const latest = await read();
        if (!latest) return suppress('opt_out');
        const [current] = await scope(gymId, tx => readMemberNoticeEmails(tx, gymId, [latest.memberId]));
        if (!current || current.address !== recipient.address) return suppress('opt_out');
        message = await renderBookingPromotion({ gymName: details.name, name: latest.session.name,
          startsAt: latest.session.startsAt, timezone: gym.timezone, memberNames: [`${current.firstName} ${current.lastName}`] });
      } catch (cause) { throw new DeliveryError('not_accepted', 'Promotion notice could not be prepared', { cause }); }
      return email.sendEmail({ to: recipient.address, ...message });
    } };
    // The job key doubles as the send-state key: an accepted or possibly accepted notice is never resent.
    const result = await deliveries.send(gymId, noticeKey(bookingId), sender, { to: recipient.address, subject: row.session.name, text: '', html: '' });
    if (result.status === 'suppressed' || (result.status === 'skipped' && result.state === 'unknown')) return;
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'booking.notice_sent', targetType: 'class_booking', targetId: bookingId, occurredAt: clock.now() }));
  }
  async function send(gymId: string, bookingId: string) {
    // An email failure never prevents the text; when both fail, the email's error is reported.
    let failure: unknown;
    try { await sendEmail(gymId, bookingId); } catch (error) { failure = error; }
    try { await sendSms(gymId, bookingId); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
  // A staff cancellation's notice: queued in the cancelling transaction, sent after commit, keyed apart from promotions.
  const cancelNotice = createBookingCancelNotice({ scope, clock, settings, jobs: options.jobs, mailer: options.mailer,
    ...(options.sms ? { sms: options.sms } : {}) });
  /**
   * Queues the promotion request for the freed place, then the notice, both in the cancelling transaction, so a
   * rollback drops both. The notice runs in the batch lane (`bookings.jobs.ts`), apart from the promotions, so a slow
   * or retrying notice never holds them up. The route's after-commit request then finds this job by its key.
   */
  async function enqueueCancelNotice(transaction: JobTransaction, notice: CancelNotice & { sessionId: string }, timezone: string) {
    await options.jobs.enqueue(promotionJob, { sessionId: notice.sessionId }, { gymId: transaction.gymId, timezone,
      idempotencyKey: promotionKey(notice.bookingId) }, transaction);
    await cancelNotice.enqueue(transaction, { bookingId: notice.bookingId, channels: notice.channels, note: notice.note }, timezone);
  }
  return { promote, request, requestPromotion, sweep, send, enqueueNotice, enqueueNotices,
    enqueueCancelNotice, sendCancelNotice: cancelNotice.run };
}
export type BookingDelivery = ReturnType<typeof createBookingDelivery>;
