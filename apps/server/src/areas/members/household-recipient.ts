// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
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
  const [household] = await tx.select({ email: households.email }).from(households)
    .where(and(eq(households.gymId, gymId), eq(households.id, householdId)));
  const email = household?.email?.trim();
  if (!email) return null;
  const family = await tx.select({ id: members.id, email: members.email, optOut: members.emailOptOut, deliverable: members.emailDeliverable })
    .from(members).where(and(eq(members.gymId, gymId), eq(members.householdId, householdId)));
  const suppressed = family.some(member => (member.email?.trim().toLowerCase() === email.toLowerCase()
    || (memberId !== undefined && member.id === memberId)) && (member.optOut || !member.deliverable));
  return { email, suppressed };
}
