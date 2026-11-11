// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNotNull, isNull, sum } from 'drizzle-orm';
import { classCreditEntries, members, memberships, uuidv7, type Transaction } from '@plaingym/db';
import { notFound } from '../../../core/interfaces/common.js';

export type CreditEntry = typeof classCreditEntries.$inferSelect;
export type CreditLot = CreditEntry & { remaining: number };

/** Call inside the caller's gym transaction, before reading or changing its member's credits. */
export async function lockMemberCredits(tx: Transaction, memberId: string) {
  return (await tx.select().from(members).where(eq(members.id, memberId)).for('update'))[0] ?? notFound();
}

/** Includes expired remainders for history/expiry; the ledger is never rewritten. */
export async function remainingLots(tx: Transaction, memberId: string): Promise<CreditLot[]> {
  const lots = await tx.select().from(classCreditEntries).where(and(
    eq(classCreditEntries.memberId, memberId), isNull(classCreditEntries.lotId)));
  const movements = await tx.select({ lotId: classCreditEntries.lotId, credits: sum(classCreditEntries.credits) })
    .from(classCreditEntries).where(and(eq(classCreditEntries.memberId, memberId), isNotNull(classCreditEntries.lotId)))
    .groupBy(classCreditEntries.lotId);
  const totals = new Map(movements.map(row => [row.lotId, Number(row.credits)]));
  return lots.map(lot => ({ ...lot, remaining: lot.credits + (totals.get(lot.id) ?? 0) }))
    .filter(lot => lot.remaining > 0).sort((a, b) =>
      (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity)
      || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** Expiry is exclusive: at expiresAt a lot is already unusable, regardless of job progress. */
export async function usableLots(tx: Transaction, memberId: string, now: Date): Promise<CreditLot[]> {
  return (await remainingLots(tx, memberId)).filter(lot => lot.expiresAt === null || lot.expiresAt > now);
}

export type CreditDraw = { gymId: string; memberId: string; credits: number; now: Date } & (
  { kind: 'use'; attendanceId: string } |
  { kind: 'adjust'; adjustmentId: string; reason: string; createdBy: string | null }
);
export type CreditDrawResult = { outcome: 'drawn'; entries: CreditEntry[] } |
  { outcome: 'insufficient_credits'; balance: number };

/** Requires lockMemberCredits. Preflights the whole draw, so insufficiency writes nothing. */
export async function drawCredits(tx: Transaction, input: CreditDraw): Promise<CreditDrawResult> {
  if (!Number.isSafeInteger(input.credits) || input.credits < 1 || input.kind === 'use' && input.credits !== 1)
    throw new Error('Invalid credit draw');
  const lots = await usableLots(tx, input.memberId, input.now);
  const balance = lots.reduce((total, lot) => total + lot.remaining, 0);
  if (balance < input.credits) return { outcome: 'insufficient_credits', balance };
  let needed = input.credits;
  const rows: (typeof classCreditEntries.$inferInsert)[] = [];
  for (const lot of lots) {
    const taken = Math.min(needed, lot.remaining);
    rows.push({ id: uuidv7(), gymId: input.gymId, memberId: input.memberId, kind: input.kind,
      credits: -taken, lotId: lot.id, createdAt: input.now,
      ...(input.kind === 'use' ? { attendanceId: input.attendanceId }
        : { adjustmentId: input.adjustmentId, reason: input.reason, createdBy: input.createdBy }) });
    needed -= taken;
    if (needed === 0) break;
  }
  return { outcome: 'drawn', entries: await tx.insert(classCreditEntries).values(rows).returning() };
}

export async function hasActiveMembership(tx: Transaction, memberId: string): Promise<boolean> {
  return (await tx.select({ id: memberships.id }).from(memberships).where(and(
    eq(memberships.memberId, memberId), inArray(memberships.status, ['active', 'trial']))).limit(1)).length > 0;
}

/** An exhausted or expired pack still makes a member a pack holder. */
export async function isPackHolder(tx: Transaction, memberId: string): Promise<boolean> {
  return (await tx.select({ id: classCreditEntries.id }).from(classCreditEntries)
    .where(eq(classCreditEntries.memberId, memberId)).limit(1)).length > 0;
}
