// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import { attendances, classBookings, classSessions, forGym, householdUsers, members, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { attendanceSchema, bookingListQuerySchema, classBookingSchema, createBookingRequestSchema, paginationSchema,
  type BookingListQuery, type ClassBooking, type CreateBookingRequest, type Pagination } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { notFound, type MutationContext } from '../../core/interfaces/common.js';
import type { PortalIdentity } from '../../core/interfaces/member-household.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { activeBookings, assertBookable, assertCancellable, bookingAudit, bookingConflict, reconcileSessionBookings,
  type BookingRow } from './bookings.rules.js';

export interface BookingOptions { scope?: typeof forGym; clock?: Clock; settings?: GymSettingsAccessor; }
export type BookingActor = MutationContext & { actor: { kind: 'user'; userId: string }; portal?: PortalIdentity };

export async function bookingView(tx: Transaction, row: BookingRow): Promise<ClassBooking> {
  const queueRank = row.status === 'waitlisted' ? 1 + await tx.$count(classBookings, and(
    eq(classBookings.sessionId, row.sessionId), eq(classBookings.status, 'waitlisted'), lt(classBookings.waitlistPosition, row.waitlistPosition!))) : null;
  return classBookingSchema.parse({ id: row.id, memberId: row.memberId, sessionId: row.sessionId, status: row.status,
    waitlistPosition: row.waitlistPosition, queueRank, bookedBy: row.bookedBy, bookedByKind: row.bookedByKind,
    createdAt: row.createdAt.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null });
}
/** Rechecks the grant in the mutation transaction; the portal first reads the target through forHousehold. */
async function requireMember(tx: Transaction, context: BookingActor, memberId: string) {
  if (context.portal) {
    const identity = context.portal;
    if (identity.gymId !== context.gymId || identity.userId !== context.actor.userId) notFound();
    const [login] = await tx.select().from(householdUsers).where(and(eq(householdUsers.userId, identity.userId),
      eq(householdUsers.householdId, identity.householdId))).for('share');
    if (!login || (login.scope !== 'payer' && (login.scope !== 'member' || login.memberId !== memberId))) notFound();
  }
  const [member] = await tx.select({ id: members.id, anonymizedAt: members.anonymizedAt }).from(members).where(and(
    eq(members.id, memberId), context.portal ? eq(members.householdId, context.portal.householdId) : undefined));
  if (!member) notFound();
  if (member.anonymizedAt) { if (context.portal) notFound(); bookingConflict('erasedMember'); }
}
async function references(tx: Transaction, query: { memberId?: string | undefined; sessionId?: string | undefined }) {
  if (query.memberId && !(await tx.select({ id: members.id }).from(members).where(eq(members.id, query.memberId)))[0]) notFound();
  if (query.sessionId && !(await tx.select({ id: classSessions.id }).from(classSessions).where(eq(classSessions.id, query.sessionId)))[0]) notFound();
}

/** After-commit entry point for cancellation, jobs and member erasure; safe to call repeatedly. */
export async function promoteWaitlist(gymId: string, sessionId: string, options: BookingOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return scope(gymId, async tx => {
    const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, sessionId)).for('update');
    if (!session) notFound();
    return reconcileSessionBookings(tx, session, { gymId, actor: { kind: 'system' } }, clock.now());
  });
}

export function createBookingService(options: BookingOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? createGymSettingsAccessor({ scope });
  return {
    requireSession: (gymId: string, sessionId: string) => scope(gymId, tx => references(tx, { sessionId })),
    async book(context: BookingActor, input: CreateBookingRequest) {
      const value = createBookingRequestSchema.parse(input), gym = await settings.get(context.gymId);
      return scope(context.gymId, async tx => {
        // Lock member before session, matching erasure's order, so an erasure cannot leave a new booking behind.
        await tx.select({ id: members.id }).from(members).where(eq(members.id, value.memberId)).for('share');
        const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, value.sessionId)).for('update');
        if (!session) notFound();
        await requireMember(tx, context, value.memberId);
        const active = await activeBookings(tx, session.id);
        const existing = active.find(row => row.memberId === value.memberId);
        if (existing) return bookingView(tx, existing);
        assertBookable(session, gym, clock.now());
        const booked = active.filter(row => row.status === 'booked').length;
        const waiting = active.filter(row => row.status === 'waitlisted');
        // A newcomer never jumps an existing queue while its promotion job is pending.
        const waitlisted = booked >= session.capacity! || waiting.length > 0;
        if (waitlisted && !value.allowWaitlist) bookingConflict('full');
        const position = waitlisted ? Math.max(0, ...waiting.map(row => row.waitlistPosition!)) + 1 : null;
        if (position !== null && position > 2_147_483_647) bookingConflict('full');
        const [row] = await tx.insert(classBookings).values({ gymId: context.gymId, memberId: value.memberId,
          sessionId: session.id, status: waitlisted ? 'waitlisted' : 'booked', waitlistPosition: position,
          bookedBy: context.actor.userId, bookedByKind: context.portal ? 'member' : 'staff', createdAt: clock.now() }).returning();
        await bookingAudit(tx, context, clock.now(), waitlisted ? 'waitlisted' : 'booked', row!);
        return bookingView(tx, row!);
      });
    },
    async cancel(context: BookingActor, id: string, memberId?: string) {
      const gym = await settings.get(context.gymId);
      return scope(context.gymId, async tx => {
        const [target] = await tx.select().from(classBookings).where(and(eq(classBookings.id, id), memberId ? eq(classBookings.memberId, memberId) : undefined));
        if (!target) notFound();
        const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, target.sessionId)).for('update');
        if (!session) notFound();
        await requireMember(tx, context, target.memberId);
        const active = await activeBookings(tx, session.id);
        const row = active.find(row => row.id === id);
        if (!row) return bookingView(tx, (await tx.select().from(classBookings).where(eq(classBookings.id, id)))[0]!);
        assertCancellable(session, gym, clock.now());
        const [cancelled] = await tx.update(classBookings).set({ status: 'cancelled', waitlistPosition: null, cancelledAt: clock.now() })
          .where(eq(classBookings.id, id)).returning();
        await bookingAudit(tx, context, clock.now(), 'cancelled', cancelled!);
        return bookingView(tx, cancelled!);
      });
    },
    async list(gymId: string, input: BookingListQuery) {
      const query = bookingListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        await references(tx, query);
        const where = and(query.memberId ? eq(classBookings.memberId, query.memberId) : undefined,
          query.sessionId ? eq(classBookings.sessionId, query.sessionId) : undefined, query.status ? eq(classBookings.status, query.status) : undefined);
        const rows = await tx.select().from(classBookings).where(where).orderBy(desc(classBookings.createdAt), desc(classBookings.id)).limit(query.limit).offset(query.offset);
        return { data: await Promise.all(rows.map(row => bookingView(tx, row))), pagination: { ...queryPage(query), total: await tx.$count(classBookings, where) } };
      });
    },
    /** Only queue counts escape this helper; portal-owned booking rows came from forHousehold. */
    async project(gymId: string, rows: BookingRow[]) {
      return scope(gymId, tx => Promise.all(rows.map(row => bookingView(tx, row))));
    },
    async roster(gymId: string, sessionId: string, input: Pagination) {
      const page = paginationSchema.parse(input);
      return scope(gymId, async tx => {
        await references(tx, { sessionId });
        const bookedIds = tx.select({ id: classBookings.memberId }).from(classBookings).where(and(eq(classBookings.sessionId, sessionId), ne(classBookings.status, 'cancelled')));
        const attendedIds = tx.select({ id: attendances.memberId }).from(attendances).where(eq(attendances.sessionId, sessionId));
        // A member appears once, whether booked, waitlisted or a walk-in.
        const ids = [...new Set([...(await bookedIds), ...(await attendedIds)].map(row => row.id))].sort();
        const selected = ids.slice(page.offset, page.offset + page.limit);
        const bookings = selected.length ? await tx.select().from(classBookings).where(and(eq(classBookings.sessionId, sessionId), ne(classBookings.status, 'cancelled'), inArray(classBookings.memberId, selected))) : [];
        const checked = selected.length ? await tx.select().from(attendances).where(and(eq(attendances.sessionId, sessionId), inArray(attendances.memberId, selected))) : [];
        const data = await Promise.all(selected.map(async memberId => {
          const booking = bookings.find(row => row.memberId === memberId), attendance = checked.find(row => row.memberId === memberId);
          return { booking: booking ? await bookingView(tx, booking) : null, attendance: attendance ? attendanceSchema.parse({
            id: attendance.id, memberId, sessionId, programId: attendance.programId, source: attendance.source, kind: attendance.kind,
            occurredAt: attendance.occurredAt.toISOString(), createdAt: attendance.createdAt.toISOString() }) : null };
        }));
        return { data, pagination: { ...page, total: ids.length } };
      });
    },
    promote: (gymId: string, sessionId: string) => promoteWaitlist(gymId, sessionId, { scope, clock, settings }),
  };
}
function queryPage(query: Pagination) { return { limit: query.limit, offset: query.offset }; }
export type BookingService = ReturnType<typeof createBookingService>;
