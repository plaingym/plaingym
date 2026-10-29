// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { classBookings, classSessions, members, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import type { GymSettings } from '../../core/interfaces/gym-settings.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { readBookingRules } from '../settings/settings.js';

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
/** The last instant a place can be cancelled, and so the last instant the waitlist is promoted. */
export function cancellationCutoffAt(session: Pick<SessionRow, 'startsAt'>, settings: Pick<GymSettings, 'cancellationCutoffMinutes'>): Date {
  return new Date(session.startsAt.getTime() - settings.cancellationCutoffMinutes * 60_000);
}
/** Cancellation at the exact cutoff is allowed. Promotion uses the same comparison, so every promoted place can be cancelled. */
export function cutoffPassed(session: Pick<SessionRow, 'startsAt'>, settings: Pick<GymSettings, 'cancellationCutoffMinutes'>, now: Date) {
  return now.getTime() > cancellationCutoffAt(session, settings).getTime();
}
/** Places a new booking can take now. A pending waitlist holds every freed place, so a newcomer never jumps it. */
export function openPlaces(capacity: number, active: readonly Pick<BookingRow, 'status'>[]) {
  if (active.some(row => row.status === 'waitlisted')) return 0;
  return Math.max(0, capacity - active.filter(row => row.status === 'booked').length);
}
export function assertCancellable(session: SessionRow, settings: GymSettings, now: Date) {
  if (cutoffPassed(session, settings, now)) bookingConflict('cutoffPassed');
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
 * After the cancellation cutoff the waitlist is frozen; the gym's current cutoff is read under the lock.
 * No email or job enqueue happens in this transaction; the promotion audits are durable delivery work. */
export async function reconcileSessionBookings(tx: Transaction, session: SessionRow, context: MutationContext, now: Date) {
  const active = await activeBookings(tx, session.id);
  const booked = active.filter(row => row.status === 'booked').length;
  if (session.capacity !== null && session.capacity < booked) bookingConflict('capacityBelowBooked');
  if (session.status !== 'scheduled' || session.startsAt <= now) return [];
  if (cutoffPassed(session, await readBookingRules(tx, session.gymId), now)) return [];
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
