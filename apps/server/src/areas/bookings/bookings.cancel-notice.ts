// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { classBookings, classSessions, forGym, members } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { cancellationNoticeChannelsSchema, idSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as defaultClock } from '../../core/clock.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { logInfo } from '../../core/log.js';
import { createEmailDeliveries, DeliveryError, type Email } from '../../infra/email/index.js';
import { logEmailSuppression, type SuppressionReason } from '../../infra/email/member.js';
import type { JobTransaction, Jobs } from '../../infra/jobs/index.js';
import { createSmsDeliveries, type Sms, type SmsMessage } from '../../infra/sms/index.js';
import { renderBookingCancellation } from '../../emails/bookings/bookings.js';
import { createGymSettingsAccessor, createSettingsService } from '../settings/settings.js';
import type { SmsResolver } from '../settings/sms.js';
import { readMemberNoticeEmails } from './bookings.recipients.js';
import { noticeSender, noticeWhen, readNoticePhones, type ClassNoticeSmsOptions } from './bookings.sms.js';
import messages from '../../../../../locales/en/bookings/bookings.json' with { type: 'json' };

export const cancelNoticeJob = 'bookings.cancel_notice';
/** The job key. Each channel has its own delivery key, apart from the waitlist promotion's keys. */
export const cancelNoticeKey = (bookingId: string) => `booking-cancel-notice:${bookingId}`;
export const cancelNoticeEmailKey = (bookingId: string) => `booking-cancel-email:${bookingId}`;
export const cancelNoticeSmsKey = (bookingId: string) => `booking-cancel-sms:${bookingId}`;
// Read from stored jobs: a newer release may add keys, which this one ignores after a rollback.
export const cancelNoticePayload = z.object({
  bookingId: idSchema, channels: cancellationNoticeChannelsSchema, note: z.string().max(1_000),
});
export type CancelNotice = z.infer<typeof cancelNoticePayload>;

export interface BookingCancelNoticeOptions {
  scope?: typeof forGym; clock?: Clock; settings?: GymSettingsAccessor;
  jobs: Jobs;
  /** The gym's SMTP mailer, or the demo outbox when demo mode is enabled. */
  mailer(gymId: string): Promise<Email | null>;
  sms?: ClassNoticeSmsOptions;
}

/**
 * Tells one member that staff cancelled their booking, by the channels staff chose. Each channel rechecks, right before
 * its provider call, that the booking is still cancelled, the member is not erased, the channel's switch is on and the
 * address or consented phone is still the one reserved. An accepted (or possibly accepted) channel is never sent again.
 */
export function createBookingCancelNotice(options: BookingCancelNoticeOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? createGymSettingsAccessor({ scope });
  const emails = createEmailDeliveries({ scope, clock }), texts = createSmsDeliveries({ scope, clock });
  const t = createTranslator({ 'bookings/bookings': messages });

  /** The cancelled booking and its class, unless the member has been erased or booked that class again since. */
  function load(gymId: string, bookingId: string) {
    return scope(gymId, async tx => {
      const [row] = await tx.select({ memberId: classBookings.memberId, sessionId: classBookings.sessionId, createdAt: classBookings.createdAt,
        name: classSessions.name, startsAt: classSessions.startsAt })
        .from(classBookings).innerJoin(classSessions, eq(classSessions.id, classBookings.sessionId))
        .innerJoin(members, eq(members.id, classBookings.memberId))
        .where(and(eq(classBookings.gymId, gymId), eq(classBookings.id, bookingId), eq(classBookings.status, 'cancelled'), isNull(members.anonymizedAt)));
      if (!row) return undefined;
      // Booking the class again adds a new row and leaves this one cancelled. Only the member's latest booking for the
      // class speaks for it, whatever that booking's status is now: a later booking (even one cancelled since, with or
      // without its own notice) supersedes this one. Creation time orders them; the time-ordered ID breaks a tie. The
      // row itself is excluded by ID, since a stored time finer than the millisecond read back could sort after itself.
      const [later] = await tx.select({ id: classBookings.id }).from(classBookings)
        .where(and(eq(classBookings.gymId, gymId), eq(classBookings.sessionId, row.sessionId), eq(classBookings.memberId, row.memberId),
          ne(classBookings.id, bookingId),
          or(gt(classBookings.createdAt, row.createdAt), and(eq(classBookings.createdAt, row.createdAt), gt(classBookings.id, bookingId))))).limit(1);
      return later ? undefined : row;
    });
  }
  /** Whether the text still goes to the same phone, under the same consent, as the group it was prepared for. */
  const sameGroup = (a: { phoneE164: string; memberIds: readonly string[]; consentMemberIds: readonly string[]; consentHouseholdIds: readonly string[] } | undefined,
    b: typeof a) => !!a && !!b && a.phoneE164 === b.phoneE164
    && (['memberIds', 'consentMemberIds', 'consentHouseholdIds'] as const).every(key => [...a[key]].sort().join() === [...b[key]].sort().join());

  async function sendEmail(gymId: string, notice: CancelNotice) {
    const gym = await settings.get(gymId);
    if (!gym.memberEmailsEnabled) return;
    const row = await load(gymId, notice.bookingId);
    if (!row) return;
    const [recipient] = await scope(gymId, tx => readMemberNoticeEmails(tx, gymId, [row.memberId]));
    if (!recipient) return;
    const email = await options.mailer(gymId);
    if (!email) { logInfo('bookings.cancel_notice_skipped', { gymId, bookingId: notice.bookingId, reason: 'no_mailer' }); return; }
    const gymName = (await createSettingsService({ scope }).get(gymId)).name;
    const suppress = (reason: SuppressionReason) => {
      logEmailSuppression({ event: 'email.suppressed', gymId, memberId: row.memberId, reason });
      return { status: 'suppressed', reason } as const;
    };
    const guarded: Email = { async sendEmail() {
      let message: Awaited<ReturnType<typeof renderBookingCancellation>>;
      try {
        if (!(await settings.get(gymId)).memberEmailsEnabled) return suppress('disabled');
        const latest = await load(gymId, notice.bookingId);
        if (!latest || latest.memberId !== row.memberId) return suppress('opt_out');
        const [current] = await scope(gymId, tx => readMemberNoticeEmails(tx, gymId, [latest.memberId]));
        if (!current || current.address !== recipient.address) return suppress('opt_out');
        // A member at their own address isn't told their own name; a household address says whose booking it was.
        message = await renderBookingCancellation({ gymName, name: latest.name, startsAt: latest.startsAt, timezone: gym.timezone,
          memberNames: [`${current.firstName} ${current.lastName}`], showMembers: !current.email, note: notice.note });
      } catch (cause) { throw new DeliveryError('not_accepted', 'Booking cancellation notice could not be prepared', { cause }); }
      return email.sendEmail({ to: recipient.address, ...message });
    } };
    // The guard builds the final content once, after its last recipient read.
    await emails.send(gymId, cancelNoticeEmailKey(notice.bookingId), guarded, { to: recipient.address, subject: row.name, text: '', html: '' });
  }

  async function sendSms(gymId: string, notice: CancelNotice) {
    const sms = options.sms;
    if (!sms || !(await settings.get(gymId)).memberSmsEnabled) return;
    const row = await load(gymId, notice.bookingId);
    if (!row) return;
    const [group] = await scope(gymId, tx => readNoticePhones(tx, gymId, [row.memberId]));
    if (!group) return;
    const delivery = { scope, clock, settings, sms };
    // Reserve before resolving credentials or calling the provider; an accepted or unknown key returns nothing.
    const reserved = await scope(gymId, tx => texts.reserve(tx, gymId, cancelNoticeSmsKey(notice.bookingId)));
    if (!reserved) return;
    const guarded: Sms = {
      verifyAccount: () => noticeSender(delivery, gymId, group).verifyAccount(),
      async sendSms() {
        let sender: Sms, message: SmsMessage;
        const recheck: { changed?: 'no_consent' | 'phone_changed' } = {};
        try {
          const latest = await load(gymId, notice.bookingId);
          if (!latest || latest.memberId !== row.memberId) return { status: 'suppressed', reason: 'no_consent' };
          const [current] = await scope(gymId, tx => readNoticePhones(tx, gymId, [latest.memberId]));
          if (!current || current.phoneE164 !== group.phoneE164) return { status: 'suppressed', reason: 'phone_changed' };
          const self = !current.consentHouseholdIds.length && current.consentMemberIds.length === 1 && current.consentMemberIds[0] === latest.memberId;
          const { timezone } = await settings.get(gymId);
          // MemberSms resolves the provider before its final consent read, and that read accepts the household phone for
          // any member of the household. So once credentials are resolved, check again that the booking still warrants a
          // text and that this member's notices would still go to this phone under the same consent.
          const resolver: SmsResolver = { status: id => sms.resolver.status(id), configured: id => sms.resolver.configured(id),
            async resolve(id) {
              const resolved = await sms.resolver.resolve(id);
              const again = await load(gymId, notice.bookingId);
              if (!again || again.memberId !== row.memberId) recheck.changed = 'no_consent';
              else if (!sameGroup((await scope(gymId, tx => readNoticePhones(tx, gymId, [again.memberId])))[0], current)) recheck.changed = 'phone_changed';
              if (recheck.changed) throw new Error('Booking cancellation text recipient changed');
              return resolved;
            } };
          sender = noticeSender({ ...delivery, sms: { ...sms, resolver } }, gymId, current);
          message = { to: current.phoneE164,
            body: t(self ? 'bookings/bookings:cancelNoticeSmsSelf' : 'bookings/bookings:cancelNoticeSms', { name: latest.name,
              ...noticeWhen(latest.startsAt, timezone), names: current.memberNames.join(', ') }) };
        } catch (cause) { throw new DeliveryError('not_accepted', 'Booking cancellation text could not be prepared', { cause }); }
        // MemberSms rechecks the text switch, notices consent and caps. A recipient change found after credentials were
        // resolved stops it before any of those, so nothing reaches the earlier phone.
        try { return await sender.sendSms(message); }
        catch (error) { if (recheck.changed) return { status: 'suppressed', reason: recheck.changed }; throw error; }
      },
    };
    await texts.attempt(reserved, guarded, { to: group.phoneE164, body: '' });
  }

  return {
    /** Must run in the transaction that cancels the booking, so a rollback leaves no notice. */
    async enqueue(transaction: JobTransaction, payload: CancelNotice, timezone: string) {
      const notice = cancelNoticePayload.parse(payload);
      await options.jobs.enqueue(cancelNoticeJob, notice, { gymId: transaction.gymId, timezone,
        idempotencyKey: cancelNoticeKey(notice.bookingId), maxAttempts: 12 }, transaction);
    },
    async run(payload: unknown, gymId: string) {
      const notice = cancelNoticePayload.parse(payload);
      // One channel's failure, suppression or earlier acceptance never stops the other; when both fail, the email's
      // error is reported. A channel staff didn't choose is never reserved or attempted.
      let failure: unknown;
      if (notice.channels.includes('email')) try { await sendEmail(gymId, notice); } catch (error) { failure = error; }
      if (notice.channels.includes('sms')) try { await sendSms(gymId, notice); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    },
  };
}
export type BookingCancelNotice = ReturnType<typeof createBookingCancelNotice>;
