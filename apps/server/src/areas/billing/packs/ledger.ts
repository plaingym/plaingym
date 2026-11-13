// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNotNull, isNull, sum } from 'drizzle-orm';
import { classCreditEntries, classPackSales, invoices, members, memberships, uuidv7, type Transaction } from '@plaingym/db';
import { notFound } from '../../../core/interfaces/common.js';

export type CreditEntry = typeof classCreditEntries.$inferSelect;
export type CreditLot = CreditEntry & { remaining: number; expired: boolean };

/** Call inside the caller's gym transaction, before reading or changing its member's credits. */
export async function lockMemberCredits(tx: Transaction, memberId: string) {
  return (await tx.select().from(members).where(eq(members.id, memberId)).for('no key update'))[0] ?? notFound();
}

/** Includes expired remainders for history/expiry; the ledger is never rewritten. */
export async function remainingLots(tx: Transaction, memberId: string): Promise<CreditLot[]> {
  const lots = await tx.select().from(classCreditEntries).where(and(
    eq(classCreditEntries.memberId, memberId), isNull(classCreditEntries.lotId)));
  const movements = await tx.select({ lotId: classCreditEntries.lotId, kind: classCreditEntries.kind, credits: sum(classCreditEntries.credits) })
    .from(classCreditEntries).where(and(eq(classCreditEntries.memberId, memberId), isNotNull(classCreditEntries.lotId)))
    .groupBy(classCreditEntries.lotId, classCreditEntries.kind);
  const totals = new Map<string, number>(), expired = new Set<string>();
  for (const row of movements) {
    totals.set(row.lotId!, (totals.get(row.lotId!) ?? 0) + Number(row.credits));
    if (row.kind === 'expire') expired.add(row.lotId!);
  }
  return lots.map(lot => ({ ...lot, remaining: lot.credits + (totals.get(lot.id) ?? 0), expired: expired.has(lot.id) }))
    .sort((a, b) =>
      (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity)
      || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** Expiry is exclusive: at expiresAt a lot is already unusable, regardless of job progress. */
export function usableCreditLots(lots: readonly CreditLot[], now: Date): CreditLot[] {
  return lots.filter(lot => lot.remaining > 0 && (lot.expiresAt === null || lot.expiresAt > now));
}
export const creditBalance = (lots: readonly CreditLot[]) => lots.reduce((total, lot) => total + lot.remaining, 0);
export async function usableLots(tx: Transaction, memberId: string, now: Date): Promise<CreditLot[]> {
  return usableCreditLots(await remainingLots(tx, memberId), now);
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
  const balance = creditBalance(lots);
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

/** Shared by booking and kiosk standing; refunded packs alone do not impose a credit requirement. */
export async function lacksClassEligibility(tx: Transaction, memberId: string, now: Date): Promise<boolean> {
  if (!await isPackHolder(tx, memberId) || await hasActiveMembership(tx, memberId)) return false;
  return (await usableLots(tx, memberId, now)).length === 0;
}

/** The sales whose credits a full refund reversed: a `reverse` row on the sale, or its invoice refunded in full. */
async function refundedSales(tx: Transaction, memberId: string): Promise<Set<string>> {
  const reversed = await tx.select({ saleId: classCreditEntries.saleId }).from(classCreditEntries).where(and(
    eq(classCreditEntries.memberId, memberId), eq(classCreditEntries.kind, 'reverse'), isNotNull(classCreditEntries.saleId)));
  const refunded = await tx.select({ saleId: classPackSales.id }).from(classPackSales)
    .innerJoin(invoices, and(eq(invoices.gymId, classPackSales.gymId), eq(invoices.id, classPackSales.invoiceId)))
    .where(and(eq(classPackSales.memberId, memberId), eq(invoices.status, 'refunded')));
  return new Set([...reversed, ...refunded].map(row => row.saleId!));
}

/**
 * An exhausted or expired pack still makes a member a pack holder, and so do credits staff added. A pack refunded in
 * full doesn't: a sale undone that way leaves the member as they were before it.
 */
export async function isPackHolder(tx: Transaction, memberId: string): Promise<boolean> {
  const lots = await tx.select({ kind: classCreditEntries.kind, saleId: classCreditEntries.saleId }).from(classCreditEntries)
    .where(and(eq(classCreditEntries.memberId, memberId), isNull(classCreditEntries.lotId)));
  if (!lots.length) return false;
  if (lots.some(lot => lot.kind !== 'grant')) return true;
  const refunded = await refundedSales(tx, memberId);
  return lots.some(lot => !refunded.has(lot.saleId!));
}

/**
 * Requires lockMemberCredits. Returns the credit an undone visit spent to its lot, unless that lot's pack was refunded
 * in full (the refund took the money back, so the credit stays spent). Returns whether a credit came back, or null
 * when the visit spent none.
 */
export async function returnCredit(tx: Transaction, input: { gymId: string; memberId: string; attendanceId: string; now: Date }) {
  const [use] = await tx.select().from(classCreditEntries).where(and(eq(classCreditEntries.memberId, input.memberId),
    eq(classCreditEntries.attendanceId, input.attendanceId), eq(classCreditEntries.kind, 'use')));
  if (!use) return null;
  const [lot] = await tx.select({ saleId: classCreditEntries.saleId }).from(classCreditEntries).where(eq(classCreditEntries.id, use.lotId!));
  if (lot?.saleId && (await refundedSales(tx, input.memberId)).has(lot.saleId)) return false;
  await tx.insert(classCreditEntries).values({ id: uuidv7(input.now.getTime()), gymId: input.gymId, memberId: input.memberId,
    kind: 'reverse', credits: 1, lotId: use.lotId, attendanceId: input.attendanceId, createdAt: input.now });
  return true;
}
