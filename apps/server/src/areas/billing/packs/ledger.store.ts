// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed SQL: parameterized advisory key and ledger balance arithmetic only.
import { and, asc, eq, gt, isNotNull, isNull, lte, notInArray, sql, sum } from 'drizzle-orm';
import { classCreditEntries, type Transaction } from '@plaingym/db';

/** Serializes one gym's command across members, before any member lock is taken. */
export async function lockAdjustment(tx: Transaction, gymId: string, adjustmentId: string) {
  // eslint-disable-next-line database/system-tables -- Transaction-scoped lock only; no table or unscoped connection access.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`class-credit-adjustment:${gymId}:${adjustmentId}`}, 0))`);
}

/** Openings use the expiry index; movements are scoped to the same gym, member and lot. */
export async function expiryCandidates(tx: Transaction, cutoff: Date, cursor?: string) {
  const movements = tx.select({ gymId: classCreditEntries.gymId, memberId: classCreditEntries.memberId,
    lotId: classCreditEntries.lotId, credits: sum(classCreditEntries.credits).as('movement_credits') }).from(classCreditEntries)
    .where(isNotNull(classCreditEntries.lotId)).groupBy(classCreditEntries.gymId, classCreditEntries.memberId, classCreditEntries.lotId).as('movements');
  const expired = tx.select({ lotId: classCreditEntries.lotId }).from(classCreditEntries)
    .where(and(eq(classCreditEntries.kind, 'expire'), isNotNull(classCreditEntries.lotId)));
  return tx.selectDistinct({ memberId: classCreditEntries.memberId }).from(classCreditEntries)
    .leftJoin(movements, and(eq(movements.gymId, classCreditEntries.gymId), eq(movements.memberId, classCreditEntries.memberId),
      eq(movements.lotId, classCreditEntries.id)))
    .where(and(isNull(classCreditEntries.lotId), lte(classCreditEntries.expiresAt, cutoff),
      cursor ? gt(classCreditEntries.memberId, cursor) : undefined, notInArray(classCreditEntries.id, expired),
      gt(sql`${classCreditEntries.credits} + coalesce(${movements.credits}, 0)`, 0)))
    .orderBy(asc(classCreditEntries.memberId)).limit(100);
}
