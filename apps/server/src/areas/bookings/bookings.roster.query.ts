// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Window and aggregate expressions over @plaingym/db tables, read under the caller's forGym scope.
import { and, asc, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
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
  const waitlisted = sql`${classBookings.status} = 'waitlisted'`;
  const participants = tx.$with('roster_participants').as(tx.select({
    // Drizzle names these columns unqualified outside their CTE, so each name is unique across the tables joined below.
    memberId: sql<string>`${members.id}`.as('roster_member_id'),
    eligible: sql<boolean>`(${members.anonymizedAt} is null and ${members.status} <> 'cancelled')`.as('roster_eligible'),
    bookingId: sql<string | null>`${classBookings.id}`.as('roster_booking_id'),
    // Booked first, then the waitlist, then walk-ins (a check-in without an active booking).
    group: sql<number>`(case when ${classBookings.status} = 'booked' then 0 when ${waitlisted} then 1 else 2 end)`.as('roster_group'),
    waitlistPosition: sql<number | null>`(case when ${waitlisted} then ${classBookings.waitlistPosition} end)`.as('roster_waitlist_position'),
    // A waitlisted booking's place in line counts every waitlisted booking ahead of it on the session, as bookingView does,
    // so it is ranked before any member is left out.
    queueRank: sql<number | null>`(case when ${waitlisted} then (rank() over (partition by ${waitlisted} order by ${classBookings.waitlistPosition}))::int end)`
      .as('roster_queue_rank'),
    attendanceId: sql<string | null>`${attendances.id}`.as('roster_attendance_id'),
  }).from(members)
    .leftJoin(classBookings, and(eq(classBookings.gymId, members.gymId), eq(classBookings.memberId, members.id),
      eq(classBookings.sessionId, sessionId), ne(classBookings.status, 'cancelled')))
    .leftJoin(attendances, and(eq(attendances.gymId, members.gymId), eq(attendances.memberId, members.id), eq(attendances.sessionId, sessionId)))
    .where(or(isNotNull(classBookings.id), isNotNull(attendances.id))));
  // Erased and Cancelled members are left out before paging, and the counts cover only who is left.
  const listed = tx.$with('roster_listed').as(tx.select().from(participants).where(checkInEligible ? sql`${participants.eligible}` : undefined));
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
  return tx.with(participants, listed, totals, rosterPage).select({
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
