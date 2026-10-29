// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { classBookings, classSessions, members, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import type { GymSettings } from '../../core/interfaces/gym-settings.js';
import type { MutationContext } from '../../core/interfaces/common.js';

export type BookingRow = typeof classBookings.$inferSelect;
export type SessionRow = typeof classSessions.$inferSelect;
const t = createTranslator(locales.en ?? {});
export function bookingConflict(key: string): never { throw new AppError('conflict', t('bookings/bookings:' + key)); }

/** Days are gym-local calendar days; the opening instant is local midnight. Cutoffs are elapsed minutes. */
export function bookingOpensAt(startsAt: Date, settings: Pick<GymSettings, 'bookingWindowDays' | 'timezone'>): Date {
  return zonedInstant(addDays(localDate(startsAt, settings.timezone), -settings.bookingWindowDays), '00:00', settings.timezone, { gap: 'shift' })!;
}
export function assertBookable(session: SessionRow, settings: GymSettings, now: Date) {
  if (session.status !== 'scheduled' || session.startsAt <= now) bookingConflict('sessionClosed');
  if (session.capacity === null) bookingConflict('noReservation');
  if (now < bookingOpensAt(session.startsAt, settings)) bookingConflict('windowClosed');
}
export function assertCancellable(session: SessionRow, settings: GymSettings, now: Date) {
  if (now.getTime() > session.startsAt.getTime() - settings.cancellationCutoffMinutes * 60_000) bookingConflict('cutoffPassed');
}
export function activeBookings(tx: Transaction, sessionId: string) {
  return tx.select().from(classBookings).where(and(eq(classBookings.sessionId, sessionId), ne(classBookings.status, 'cancelled')))
    .orderBy(asc(classBookings.waitlistPosition), asc(classBookings.id));
}
export async function bookingAudit(tx: Transaction, context: MutationContext, now: Date, action: string, row: BookingRow) {
  await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'booking.' + action,
    targetType: 'class_booking', targetId: row.id, after: { sessionId: row.sessionId, memberId: row.memberId, status: row.status }, occurredAt: now });
}

/** Caller holds this session's FOR UPDATE lock. Capacity edits, jobs and erasure share this rule.
 * A reduction below confirmed bookings is rejected. Removing capacity confirms the remaining queue.
 * No email or job enqueue happens in this transaction; the promotion audits are durable delivery work. */
export async function reconcileSessionBookings(tx: Transaction, session: SessionRow, context: MutationContext, now: Date) {
  const active = await activeBookings(tx, session.id);
  const booked = active.filter(row => row.status === 'booked').length;
  if (session.capacity !== null && session.capacity < booked) bookingConflict('capacityBelowBooked');
  if (session.status !== 'scheduled' || session.startsAt <= now) return [];
  const promoted: BookingRow[] = [];
  let available = session.capacity === null ? active.length : session.capacity - booked;
  for (const waiting of active.filter(row => row.status === 'waitlisted')) {
    if (available <= 0) break;
    // Erasure also locks sessions. Never confirm an already-erased member's place.
    const [member] = await tx.select({ id: members.id }).from(members).where(and(eq(members.id, waiting.memberId), isNull(members.anonymizedAt)));
    if (!member) continue;
    const [row] = await tx.update(classBookings).set({ status: 'booked', waitlistPosition: null })
      .where(eq(classBookings.id, waiting.id)).returning();
    await bookingAudit(tx, context, now, 'promoted', row!);
    promoted.push(row!); available--;
  }
  return promoted;
}
