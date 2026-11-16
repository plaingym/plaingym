// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray } from 'drizzle-orm';
import { classBookings, members, type Transaction } from '@plaingym/db';
import { householdRecipients } from '../members/household-recipient.js';

/** Class notices prefer the member's own email, then their household's billing email. */
export async function readMemberNoticeEmails(tx: Transaction, gymId: string, memberIds: readonly string[]) {
  if (!memberIds.length) return [];
  const people = await tx.select({ id: members.id, householdId: members.householdId, email: members.emailAddress,
    firstName: members.firstName, lastName: members.lastName, anonymizedAt: members.anonymizedAt,
    emailOptOut: members.emailOptOut, emailDeliverable: members.emailDeliverable }).from(members)
    .where(and(eq(members.gymId, gymId), inArray(members.id, [...memberIds]))).orderBy(asc(members.id));
  const homes = await householdRecipients(tx, gymId, people.filter(person => !person.email).map(person => person.householdId));
  return people.flatMap(person => {
    if (person.anonymizedAt || person.emailOptOut || !person.emailDeliverable) return [];
    const home = homes.get(person.householdId);
    const address = person.email || (home && !home.suppressed ? home.email.toLowerCase() : undefined);
    return address ? [{ ...person, address }] : [];
  });
}

/** Snapshot only. The caller holds the session lock shared by every booking mutation. */
export async function readCancellationRecipients(tx: Transaction, sessionId: string): Promise<string[]> {
  const rows = await tx.select({ memberId: classBookings.memberId }).from(classBookings)
    .where(and(eq(classBookings.sessionId, sessionId), inArray(classBookings.status, ['booked', 'waitlisted'])))
    .orderBy(asc(classBookings.memberId));
  return [...new Set(rows.map(row => row.memberId))];
}
