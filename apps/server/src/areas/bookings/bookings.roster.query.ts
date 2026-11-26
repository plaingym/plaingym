// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Window and aggregate expressions over @plaingym/db tables, read under the caller's forGym scope.
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { attendances, classBookings, members, type Transaction } from '@plaingym/db';

export interface RosterRead { limit: number; offset: number; checkInEligible: boolean; }

/**
 * Reads one page of a session's roster in a single statement, so the page, each place in line, the total and the counts
 * describe the same snapshot even while check-ins and booking changes commit. Only identifiers, flags and positions are
 * computed for the whole session; names and full booking and attendance records are read for the requested page alone.
 *
 * The statement always returns at least one row: the totals, joined to each page row (all page fields null when the page is
 * empty). Unique indexes give each member one active booking and one check-in per session, so each member appears once.
 */
export function readRosterPage(tx: Transaction, sessionId: string, { limit, offset, checkInEligible }: RosterRead) {
  // The participants start from the session's own active bookings and check-ins (read through the session-led unique
  // indexes) and only then read those members, so the work follows the session's size, not the gym's membership. Drizzle
  // names CTE columns unqualified outside their CTE, so each name is unique across every table and CTE joined below.
  const sessionBookings = tx.$with('roster_bookings').as(tx.select({
    id: sql<string>`${classBookings.id}`.as('roster_session_booking_id'),
    memberId: sql<string>`${classBookings.memberId}`.as('roster_booking_member_id'),
    status: sql<string>`${classBookings.status}`.as('roster_booking_status'),
    waitlistPosition: sql<number | null>`${classBookings.waitlistPosition}`.as('roster_booking_waitlist_position'),
  }).from(classBookings).where(and(eq(classBookings.sessionId, sessionId), ne(classBookings.status, 'cancelled'))));
  const sessionCheckIns = tx.$with('roster_attendances').as(tx.select({
    id: sql<string>`${attendances.id}`.as('roster_session_attendance_id'),
    memberId: sql<string>`${attendances.memberId}`.as('roster_attendance_member_id'),
  }).from(attendances).where(eq(attendances.sessionId, sessionId)));
  const waitlisted = sql`${sessionBookings.status} = 'waitlisted'`;
  const participants = tx.$with('roster_participants').as(tx.select({
    memberId: sql<string>`${members.id}`.as('roster_member_id'),
    eligible: sql<boolean>`(${members.anonymizedAt} is null and ${members.status} <> 'cancelled')`.as('roster_eligible'),
    bookingId: sql<string | null>`${sessionBookings.id}`.as('roster_booking_id'),
    // Booked first, then the waitlist, then walk-ins (a check-in without an active booking).
    group: sql<number>`(case when ${sessionBookings.status} = 'booked' then 0 when ${waitlisted} then 1 else 2 end)`.as('roster_group'),
    waitlistPosition: sql<number | null>`(case when ${waitlisted} then ${sessionBookings.waitlistPosition} end)`.as('roster_waitlist_position'),
    // A waitlisted booking's place in line counts every waitlisted booking ahead of it on the session, as bookingView does,
    // so it is ranked before any member is left out.
    queueRank: sql<number | null>`(case when ${waitlisted} then (rank() over (partition by ${waitlisted} order by ${sessionBookings.waitlistPosition}))::int end)`
      .as('roster_queue_rank'),
    attendanceId: sql<string | null>`${sessionCheckIns.id}`.as('roster_attendance_id'),
  }).from(sessionBookings)
    // Unique indexes give each member at most one active booking and one check-in per session, so each member joins once.
    .fullJoin(sessionCheckIns, sql`${sessionCheckIns.memberId} = ${sessionBookings.memberId}`)
    // A case expression, not coalesce: PostgreSQL treats coalesce as possibly leaky, so under forced row-level security it
    // would not look members up through their primary key and would scan the whole membership instead.
    .innerJoin(members, sql`${members.id} = (case when ${sessionBookings.memberId} is not null then ${sessionBookings.memberId} else ${sessionCheckIns.memberId} end)`));
  // Erased and Cancelled members are left out before paging unless they have a check-in at this session, so a coach can
  // still see and undo it; the counts cover who is listed.
  const listed = tx.$with('roster_listed').as(tx.select().from(participants)
    .where(checkInEligible ? sql`(${participants.eligible} or ${participants.attendanceId} is not null)` : undefined));
  const totals = tx.$with('roster_totals').as(tx.select({
    total: sql<number>`count(*)::int`.as('roster_total'),
    booked: sql<number>`(count(*) filter (where ${listed.group} = 0))::int`.as('roster_booked'),
    waitlisted: sql<number>`(count(*) filter (where ${listed.group} = 1))::int`.as('roster_waitlisted'),
    checkedIn: sql<number>`count(${listed.attendanceId})::int`.as('roster_checked_in'),
  }).from(listed));
  // Eligible: booked, then the waitlist in queue order, then walk-ins, member ID breaking ties. Otherwise by member ID.
  const order = <T extends { group: unknown; waitlistPosition: unknown; memberId: unknown }>(fields: T) =>
    (checkInEligible ? [fields.group, fields.waitlistPosition, fields.memberId] : [fields.memberId]).map(field => asc(sql`${field}`));
  const rosterPage = tx.$with('roster_page').as(tx.select().from(listed).orderBy(...order(listed)).limit(limit).offset(offset));
  return tx.with(sessionBookings, sessionCheckIns, participants, listed, totals, rosterPage).select({
    total: totals.total, booked: totals.booked, waitlisted: totals.waitlisted, checkedIn: totals.checkedIn,
    memberId: rosterPage.memberId, queueRank: rosterPage.queueRank, firstName: members.firstName, lastName: members.lastName,
    booking: classBookings, attendance: attendances,
  }).from(totals)
    .leftJoin(rosterPage, sql`true`)
    .leftJoin(members, sql`${members.id} = ${rosterPage.memberId}`)
    .leftJoin(classBookings, sql`${classBookings.id} = ${rosterPage.bookingId}`)
    .leftJoin(attendances, sql`${attendances.id} = ${rosterPage.attendanceId}`)
    .orderBy(...order(rosterPage));
}
