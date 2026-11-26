// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { and, asc, eq, isNotNull, ne, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- EXPLAIN inspects the production query on the disposable database.
import { sql } from 'drizzle-orm';
import { attendances, classBookings, members, uuidv7, type Transaction } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- ANALYZE needs the table owner on the disposable database.
import { openConnection } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { readRosterPage, type RosterRead } from './bookings.roster.query.js';

const db = useTestDatabase(), factory = createFactories(db);

/**
 * A reference statement that starts from every member of the gym and keeps those with a booking or check-in at the session.
 * It exists only here: the roster must return the same page for the same data, and its buffers follow the membership.
 */
function readRosterPageFromMembers(tx: Transaction, sessionId: string, { limit, offset, checkInEligible }: RosterRead) {
  const waitlisted = sql`${classBookings.status} = 'waitlisted'`;
  const participants = tx.$with('roster_participants').as(tx.select({
    memberId: sql<string>`${members.id}`.as('roster_member_id'),
    eligible: sql<boolean>`(${members.anonymizedAt} is null and ${members.status} <> 'cancelled')`.as('roster_eligible'),
    bookingId: sql<string | null>`${classBookings.id}`.as('roster_booking_id'),
    group: sql<number>`(case when ${classBookings.status} = 'booked' then 0 when ${waitlisted} then 1 else 2 end)`.as('roster_group'),
    waitlistPosition: sql<number | null>`(case when ${waitlisted} then ${classBookings.waitlistPosition} end)`.as('roster_waitlist_position'),
    queueRank: sql<number | null>`(case when ${waitlisted} then (rank() over (partition by ${waitlisted} order by ${classBookings.waitlistPosition}))::int end)`
      .as('roster_queue_rank'),
    attendanceId: sql<string | null>`${attendances.id}`.as('roster_attendance_id'),
  }).from(members)
    .leftJoin(classBookings, and(eq(classBookings.gymId, members.gymId), eq(classBookings.memberId, members.id),
      eq(classBookings.sessionId, sessionId), ne(classBookings.status, 'cancelled')))
    .leftJoin(attendances, and(eq(attendances.gymId, members.gymId), eq(attendances.memberId, members.id), eq(attendances.sessionId, sessionId)))
    .where(or(isNotNull(classBookings.id), isNotNull(attendances.id))));
  const listed = tx.$with('roster_listed').as(tx.select().from(participants)
    .where(checkInEligible ? sql`(${participants.eligible} or ${participants.attendanceId} is not null)` : undefined));
  const totals = tx.$with('roster_totals').as(tx.select({
    total: sql<number>`count(*)::int`.as('roster_total'),
    booked: sql<number>`(count(*) filter (where ${listed.group} = 0))::int`.as('roster_booked'),
    waitlisted: sql<number>`(count(*) filter (where ${listed.group} = 1))::int`.as('roster_waitlisted'),
    checkedIn: sql<number>`count(${listed.attendanceId})::int`.as('roster_checked_in'),
  }).from(listed));
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

type Read = typeof readRosterPage;
interface PlanNode {
  'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
  Plans?: PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const user = await factory('authUser', gymId), household = await factory('households', gymId);
  const empty = await factory('classSessions', gymId), small = await factory('classSessions', gymId), other = await factory('classSessions', gymId);
  let count = 0;
  const addMembers = async (total: number, status = (_index: number) => 'active', erased = (_index: number) => false) => {
    for (let start = 0; start < total; start += 500) {
      const values = Array.from({ length: Math.min(500, total - start) }, (_, i) => {
        const index = start + i, n = count + index;
        return { id: uuidv7(), gymId, householdId: household.id, firstName: `First ${n}`, lastName: `Last ${n}`, status: status(index),
          anonymizedAt: erased(index) ? new Date('2026-01-10T12:00:00Z') : null };
      });
      await db.forGym(gymId, tx => tx.insert(members).values(values));
    }
    count += total;
  };
  // Members 0 to 14 are the small session's participants: a Cancelled booked member (3), an erased booked member (5), a
  // Cancelled waitlisted member with a check-in (12) and an erased walk-in (14) cover who the check-in roster leaves out.
  await addMembers(500, index => (index === 3 || index === 12 ? 'cancelled' : 'active'), index => index === 5 || index === 14);
  const named = new Map((await db.forGym(gymId, tx => tx.select({ id: members.id, firstName: members.firstName }).from(members)))
    .map(row => [row.firstName, row.id]));
  const member = (index: number) => named.get(`First ${index}`)!;
  const at = new Date('2026-01-15T12:00:00Z'), booking = { gymId, bookedBy: user.id, bookedByKind: 'staff' };
  await db.forGym(gymId, async tx => {
    await tx.insert(classBookings).values([
      ...Array.from({ length: 10 }, (_, i) => ({ ...booking, id: uuidv7(), sessionId: small.id, memberId: member(i), status: 'booked' })),
      // The waitlist keeps gaps in its positions, so its places in line are ranks, not positions.
      ...[[10, 7], [11, 2], [12, 4]].map(([index, position]) => ({ ...booking, id: uuidv7(), sessionId: small.id, memberId: member(index!),
        status: 'waitlisted', waitlistPosition: position })),
      // Cancelled bookings are never on the roster; member 13's check-in makes them a walk-in.
      ...[13, 15].map(index => ({ ...booking, id: uuidv7(), sessionId: small.id, memberId: member(index), status: 'cancelled', cancelledAt: at })),
      ...Array.from({ length: 10 }, (_, i) => ({ ...booking, id: uuidv7(), sessionId: other.id, memberId: member(20 + i), status: 'booked' })),
    ]);
    await tx.insert(attendances).values([
      ...[0, 1, 12, 13, 14].map(index => ({ id: uuidv7(), gymId, sessionId: small.id, memberId: member(index), occurredAt: at, source: 'coach' })),
      ...[20, 21, 22, 30].map(index => ({ id: uuidv7(), gymId, sessionId: other.id, memberId: member(index), occurredAt: at, source: 'coach' })),
    ]);
  });
  // Further sessions, each booked and attended by the first 500 members, so the tables hold far more than one session's rows.
  const addHistory = async (sessions: number) => {
    for (let index = 0; index < sessions; index++) {
      const session = await factory('classSessions', gymId);
      const rows = [...named.values()].map(memberId => ({ gymId, sessionId: session.id, memberId }));
      await db.forGym(gymId, async tx => {
        await tx.insert(classBookings).values(rows.map(row => ({ ...booking, ...row, id: uuidv7(), status: 'booked' })));
        await tx.insert(attendances).values(rows.map(row => ({ ...row, id: uuidv7(), occurredAt: at, source: 'coach' })));
      });
    }
  };
  const analyze = async () => {
    const maintenance = openConnection(db.maintenanceUrl, 1);
    try { await maintenance.sql`analyze members, class_bookings, attendances`; } finally { await maintenance.close(); }
  };
  const page = (read: Read, sessionId: string, checkInEligible: boolean, limit = 50, offset = 0) =>
    db.forGym(gymId, tx => read(tx, sessionId, { limit, offset, checkInEligible }));
  // The second of two runs, so pages touched for the first time after the inserts don't count.
  const explain = async (read: Read, sessionId: string, checkInEligible: boolean) => {
    const run = () => db.forGym(gymId, tx =>
      // eslint-disable-next-line database/system-tables -- Explain the gym-scoped production query under forced RLS.
      tx.execute(sql`explain (analyze, buffers, format json) ${read(tx, sessionId, { limit: 50, offset: 0, checkInEligible }).getSQL()}`));
    await run();
    const [row] = await run();
    const raw = row?.['QUERY PLAN'];
    const [{ Plan: plan }] = (typeof raw === 'string' ? JSON.parse(raw) : raw) as [{ Plan: PlanNode }];
    return { buffers: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
      seqScans: nodes(plan).filter(node => node['Node Type'] === 'Seq Scan').map(node => node['Relation Name']),
      indexes: nodes(plan).map(node => node['Index Name']) };
  };
  return { gymId, empty, small, addMembers, addHistory, analyze, page, explain };
}

const cases = (f: Awaited<ReturnType<typeof fixture>>) =>
  [f.empty.id, f.small.id].flatMap(sessionId => [false, true].map(checkInEligible => ({ sessionId, checkInEligible })));

/**
 * The roster's buffers don't follow the gym's membership. An empty session reads the same few buffers at 500 and 5,000
 * members. A session with participants looks each of them up in the members' primary key; at 500 members the planner reads
 * the ten-page table whole instead, and that index gains a level between 500 and 5,000 members, so its growth is measured
 * from 5,000 to 25,000 members, where the index keeps its depth.
 */
it('reads the roster from the session, so its buffers stay flat as the membership grows', async () => {
  const f = await fixture();
  const measure = async () => {
    await f.analyze();
    const plans = [];
    for (const { sessionId, checkInEligible } of cases(f)) {
      plans.push({ ...await f.explain(readRosterPage, sessionId, checkInEligible),
        fromMembers: (await f.explain(readRosterPageFromMembers, sessionId, checkInEligible)).buffers });
    }
    return plans;
  };
  const at500 = await measure();
  await f.addMembers(4500);
  const at5000 = await measure();
  await f.addMembers(20_000);
  const at25000 = await measure();
  for (const [index, { sessionId }] of cases(f).entries()) {
    expect(at5000[index]!.seqScans).not.toContain('members');
    expect(at25000[index]!.seqScans).not.toContain('members');
    expect(at25000[index]!.buffers).toBeLessThanOrEqual(at5000[index]!.buffers * 1.5);
    if (sessionId === f.empty.id) expect(at5000[index]!.buffers).toBeLessThanOrEqual(at500[index]!.buffers * 1.5);
    // The reference statement, which starts from every member, fails the same bound.
    expect(at25000[index]!.fromMembers).toBeGreaterThan(at5000[index]!.fromMembers * 1.5);
  }
});

it('reads bookings and check-ins through their session indexes, not the gym\'s whole history', async () => {
  const f = await fixture();
  await f.addHistory(20);
  await f.analyze();
  for (const { sessionId, checkInEligible } of cases(f)) {
    const plan = await f.explain(readRosterPage, sessionId, checkInEligible);
    expect(plan.indexes).toEqual(expect.arrayContaining(['class_bookings_active_key', 'attendances_session_member_key']));
    expect(plan.seqScans).not.toContain('class_bookings');
    expect(plan.seqScans).not.toContain('attendances');
  }
});

it('returns the same page, row for row, as the reference statement that starts from every member', async () => {
  const f = await fixture();
  await f.addMembers(4500);
  await f.analyze();
  for (const { sessionId, checkInEligible } of cases(f)) {
    expect(await f.page(readRosterPage, sessionId, checkInEligible))
      .toEqual(await f.page(readRosterPageFromMembers, sessionId, checkInEligible));
    expect(await f.page(readRosterPage, sessionId, checkInEligible, 4, 6))
      .toEqual(await f.page(readRosterPageFromMembers, sessionId, checkInEligible, 4, 6));
  }
  const [first] = await f.page(readRosterPage, f.small.id, false);
  expect(first).toMatchObject({ total: 15, booked: 10, waitlisted: 3, checkedIn: 5 });
  const [eligible] = await f.page(readRosterPage, f.small.id, true);
  expect(eligible).toMatchObject({ total: 13, booked: 8, waitlisted: 3, checkedIn: 5 });
});
