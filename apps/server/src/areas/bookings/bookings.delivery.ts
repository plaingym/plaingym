// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { auditEvents, classBookings, classSessions, forGym, members, writeAudit } from '@plaingym/db';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { MemberEmail, SmtpEmail, type Email } from '../../infra/email/index.js';
import type { Jobs } from '../../infra/jobs/index.js';
import { createSmtpResolver } from '../settings/smtp.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { renderBookingPromotion } from '../../emails/bookings/bookings.js';
import { promoteWaitlist, type BookingOptions } from './bookings.js';

export const promotionJob = 'bookings.promote';
export const noticeJob = 'bookings.notice';
export const promotionPayload = z.strictObject({ sessionId: idSchema });
export const noticePayload = z.strictObject({ bookingId: idSchema });

/** The runtime can supply its demo outbox instead; ordinary mail always resolves this gym's SMTP. */
export function createBookingMailer(options: Parameters<typeof createSmtpResolver>[0]): (gymId: string) => Promise<Email | null> {
  const smtp = createSmtpResolver(options);
  return async gymId => { const config = await smtp.config(gymId); return config ? new SmtpEmail(config) : null; };
}
export interface BookingDeliveryOptions extends BookingOptions {
  jobs: Jobs;
  mailer(gymId: string): Promise<Email | null>;
}
export function createBookingDelivery(options: BookingDeliveryOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? createGymSettingsAccessor({ scope });
  async function enqueueNotice(gymId: string, bookingId: string) {
    const gym = await settings.get(gymId);
    await options.jobs.enqueue(noticeJob, { bookingId }, { gymId, timezone: gym.timezone,
      idempotencyKey: `booking-promotion:${bookingId}`, maxAttempts: 18 });
  }
  async function promote(gymId: string, sessionId: string) {
    const rows = await promoteWaitlist(gymId, sessionId, { scope, clock, settings });
    for (const row of rows) await enqueueNotice(gymId, row.id);
    return rows;
  }
  async function request(gymId: string, sessionId: string, cancellationId: string) {
    const gym = await settings.get(gymId);
    await options.jobs.enqueue(promotionJob, { sessionId }, { gymId, timezone: gym.timezone,
      idempotencyKey: `booking-cancelled:${cancellationId}` });
  }
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
          inArray(classBookings.id, tx.select({ id: auditEvents.targetId }).from(auditEvents).where(eq(auditEvents.action, 'booking.promoted')))))
        .orderBy(asc(classBookings.id)).limit(100));
      for (const booking of pending) await enqueueNotice(gymId, booking.id);
      if (pending.length < 100) break;
      cursor = pending.at(-1)!.id;
    }
  }
  async function send(gymId: string, bookingId: string) {
    const read = () => scope(gymId, async tx => {
      const [promotion] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, bookingId), eq(auditEvents.action, 'booking.promoted')));
      const [sent] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, bookingId), eq(auditEvents.action, 'booking.notice_sent')));
      if (!promotion || sent) return;
      const [row] = await tx.select({ booking: classBookings, session: classSessions, email: members.email, memberId: members.id })
        .from(classBookings).innerJoin(classSessions, eq(classSessions.id, classBookings.sessionId))
        .innerJoin(members, eq(members.id, classBookings.memberId)).where(and(eq(classBookings.id, bookingId),
          eq(classBookings.status, 'booked'), eq(classSessions.status, 'scheduled'), gt(classSessions.startsAt, clock.now()), isNull(members.anonymizedAt)));
      return row;
    });
    const gym = await settings.get(gymId);
    if (!gym.memberEmailsEnabled || !await read()) return;
    const email = await options.mailer(gymId);
    if (!email) throw new Error('Booking email is not configured');
    const row = await read();
    if (!row?.email) return;
    const message = await renderBookingPromotion({ name: row.session.name, startsAt: row.session.startsAt, timezone: gym.timezone });
    const sender = new MemberEmail({ gymId, memberId: row.memberId, email, settings, forGym: scope });
    const result = await sender.sendEmail({ to: row.email, ...message });
    if (result.status !== 'sent') return;
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'booking.notice_sent', targetType: 'class_booking', targetId: bookingId, occurredAt: clock.now() }));
  }
  return { promote, request, sweep, send };
}
export type BookingDelivery = ReturnType<typeof createBookingDelivery>;
