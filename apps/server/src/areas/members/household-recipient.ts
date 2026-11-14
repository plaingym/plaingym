// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { households, members, type Transaction } from '@plaingym/db';

export interface HouseholdRecipient {
  /** The household's trimmed billing address. */
  readonly email: string;
  /** A member at that address (or the named member) opted out of email or is undeliverable. */
  readonly suppressed: boolean;
}

/** Called inside forGym. Null when the household has no address. `memberId` names a member who must also be
 * reachable, such as a waiver's signer. Callers decide what a missing or suppressed recipient means. */
export async function householdRecipient(tx: Transaction, gymId: string, householdId: string,
  memberId?: string): Promise<HouseholdRecipient | null> {
  return (await householdRecipients(tx, gymId, [householdId], memberId)).get(householdId) ?? null;
}

/** The same recipient rules for many households, with two queries regardless of the number of households. */
export async function householdRecipients(tx: Transaction, gymId: string, householdIds: readonly string[],
  memberId?: string): Promise<Map<string, HouseholdRecipient | null>> {
  const recipients = new Map<string, HouseholdRecipient | null>();
  const ids = [...new Set(householdIds)];
  if (!ids.length) return recipients;
  const homes = await tx.select({ id: households.id, email: households.email }).from(households)
    .where(and(eq(households.gymId, gymId), inArray(households.id, ids)));
  const family = await tx.select({ id: members.id, householdId: members.householdId, email: members.email, optOut: members.emailOptOut, deliverable: members.emailDeliverable })
    .from(members).where(and(eq(members.gymId, gymId), inArray(members.householdId, ids)));
  // Address suppression is household-local, even when several households share an address.
  for (const home of homes) {
    const email = home.email?.trim();
    recipients.set(home.id, email ? { email, suppressed: false } : null);
  }
  for (const member of family) {
    const recipient = recipients.get(member.householdId);
    if (recipient && (member.optOut || !member.deliverable)
      && (member.email?.trim().toLowerCase() === recipient.email.toLowerCase() || member.id === memberId)) {
      recipients.set(member.householdId, { ...recipient, suppressed: true });
    }
  }
  return recipients;
}
