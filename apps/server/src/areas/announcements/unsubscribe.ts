// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { forHousehold, HouseholdAccessError, members, signedLinks, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';

/** Mint inside the send reservation transaction; only the caller receives the plaintext token. */
export async function issueUnsubscribeLink(tx: Transaction, gymId: string, memberId: string, now: Date, token = randomBytes(32).toString('base64url')): Promise<string> {
  const [member] = await tx.select({ id: members.id, householdId: members.householdId }).from(members)
    .where(and(eq(members.gymId, gymId), eq(members.id, memberId), isNull(members.anonymizedAt))).for('update');
  if (!member) throw new AppError('not_found', 'Member not found');
  const [link] = await tx.insert(signedLinks).values({ gymId, memberId: member.id, householdId: member.householdId,
    purpose: 'unsubscribe', tokenHash: createHash('sha256').update(token).digest('hex'), createdBy: null,
    createdAt: now, expiresAt: new Date(now.getTime() + 90 * 86400_000) }).returning({ id: signedLinks.id });
  await writeAudit(tx, { gymId, actorKind: 'system', action: 'signed_link.created', targetType: 'signed_link',
    targetId: link!.id, occurredAt: now, after: { purpose: 'unsubscribe', memberId: member.id } });
  return token;
}

export function createAnnouncementUnsubscribeService(options: { scope?: typeof forHousehold } = {}) {
  const scope = options.scope ?? forHousehold;
  async function preference(gymId: string, linkId: string, clock: Clock, optedOut?: boolean) {
    try {
      return await scope({ kind: 'signed_link', gymId, linkId, now: clock.now() }, q =>
        optedOut === undefined ? q.announcementPreference() : q.setAnnouncementOptOut(optedOut, () => clock.now()));
    } catch (error) {
      if (error instanceof HouseholdAccessError) throw new AppError('not_found', 'Link not found');
      throw error;
    }
  }
  return {
    read: (gymId: string, linkId: string, clock: Clock) => preference(gymId, linkId, clock),
    set: (gymId: string, linkId: string, optedOut: boolean, clock: Clock) => preference(gymId, linkId, clock, optedOut),
  };
}
