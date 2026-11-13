// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { classCreditEntries, classPackSales, databaseCode, forGym, invoices, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import { notFound, type MutationContext } from '../../../core/interfaces/common.js';
import type { CatalogOptions } from '../catalog.js';
import { audit } from '../transitions/store.js';
import { creditBalance, drawCredits, lockMemberCredits, remainingLots, usableCreditLots, type CreditEntry } from './ledger.js';
import { lockAdjustment } from './ledger.store.js';
import messages from '../../../../../../locales/en/billing/packs.json' with { type: 'json' };

const t = createTranslator({ 'billing/packs': messages });
const entry = (row: CreditEntry, invoice: { invoiceId: string; invoiceNumber: number | null } | null) => ({
  id: row.id, memberId: row.memberId, kind: row.kind, credits: row.credits, lotId: row.lotId,
  saleId: row.saleId, attendanceId: row.attendanceId, expiresAt: row.expiresAt?.toISOString() ?? null,
  reason: row.reason, adjustmentId: row.adjustmentId, createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(), invoiceId: invoice?.invoiceId ?? null, invoiceNumber: invoice?.invoiceNumber ?? null,
});

/** Load only the entries' sale invoices, resolving draws through their openings. */
async function saleInvoices(tx: Transaction, rows: readonly CreditEntry[], openings: readonly CreditEntry[] = []) {
  const saleByLot = new Map(openings.map(row => [row.id, row.saleId]));
  const missing = [...new Set(rows.flatMap(row => row.lotId && !saleByLot.has(row.lotId) ? [row.lotId] : []))];
  if (missing.length) for (const row of await tx.select({ id: classCreditEntries.id, saleId: classCreditEntries.saleId })
    .from(classCreditEntries).where(inArray(classCreditEntries.id, missing))) saleByLot.set(row.id, row.saleId);
  const saleFor = (row: CreditEntry) => row.saleId ?? saleByLot.get(row.lotId ?? '') ?? null;
  const ids = [...new Set(rows.flatMap(row => saleFor(row) ? [saleFor(row)!] : []))];
  const sales = ids.length ? await tx.select({ id: classPackSales.id, invoiceId: invoices.id, invoiceNumber: invoices.number }).from(classPackSales)
    .innerJoin(invoices, and(eq(invoices.gymId, classPackSales.gymId), eq(invoices.id, classPackSales.invoiceId)))
    .where(inArray(classPackSales.id, ids)) : [];
  const invoicesBySale = new Map(sales.map(row => [row.id, row]));
  return (row: CreditEntry) => invoicesBySale.get(saleFor(row) ?? '') ?? null;
}
const reused = () => new AppError('conflict', t('billing/packs:adjustmentReused'), { reason: ['adjustment_id_reused'] });
function adjustmentConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const row = error as { constraint_name?: string; cause?: unknown };
  return ['class_credit_entries_adjust_open_key', 'class_credit_entries_adjust_lot_key'].includes(row.constraint_name ?? '')
    || adjustmentConstraint(row.cause);
}

export function createCreditLedgerService(options: CatalogOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    async adjust(context: MutationContext, input: unknown) {
      const request = c.adjustClassCreditsRequestSchema.parse(input);
      return scope(context.gymId, async tx => {
        await lockAdjustment(tx, context.gymId, request.adjustmentId.toLowerCase());
        const member = await lockMemberCredits(tx, request.memberId);
        if (member.anonymizedAt) notFound();
        const now = clock.now();
        let entries = await tx.select().from(classCreditEntries).where(and(eq(classCreditEntries.kind, 'adjust'), eq(classCreditEntries.adjustmentId, request.adjustmentId)))
          .orderBy(asc(classCreditEntries.createdAt), asc(classCreditEntries.id));
        if (entries.length) {
          if (entries.some(row => row.memberId !== request.memberId || row.reason !== request.reason)
            || entries.reduce((total, row) => total + row.credits, 0) !== request.credits)
            throw reused();
        } else {
          if (request.credits > 0) entries = await tx.insert(classCreditEntries).values({
            id: uuidv7(), gymId: context.gymId, memberId: request.memberId, kind: 'adjust',
            credits: request.credits, reason: request.reason, adjustmentId: request.adjustmentId,
            createdBy: context.actor.kind === 'user' ? context.actor.userId : null, createdAt: now,
          }).returning();
          else {
            const result = await drawCredits(tx, { gymId: context.gymId, memberId: request.memberId,
              credits: -request.credits, now, kind: 'adjust', adjustmentId: request.adjustmentId, reason: request.reason,
              createdBy: context.actor.kind === 'user' ? context.actor.userId : null });
            if (result.outcome === 'insufficient_credits')
              throw new AppError('conflict', t('billing/packs:insufficientCredits'), { reason: ['insufficient_credits'] });
            entries = result.entries;
          }
          // Free text lives only on redactable ledger rows; the audit references those rows and their reason field.
          await audit(tx, context, clock, 'billing.credits.adjusted', 'member', request.memberId,
            { adjustmentId: request.adjustmentId, credits: request.credits,
              entries: entries.map(row => ({ id: row.id, lotId: row.lotId, credits: row.credits, reasonEntryId: row.id })) });
        }
        entries.sort((a, b) => a.id.localeCompare(b.id));
        const invoiceFor = await saleInvoices(tx, entries);
        return { data: { adjustmentId: request.adjustmentId, balance: creditBalance(usableCreditLots(await remainingLots(tx, request.memberId), now)),
          entries: entries.map(row => entry(row, invoiceFor(row))) } };
      }).catch(error => {
        if (databaseCode(error) === '23505' && adjustmentConstraint(error)) throw reused();
        throw error;
      });
    },
    async read(gymId: string, memberId: string, input: unknown) {
      const query = c.classCreditLedgerQuerySchema.parse(input);
      return scope(gymId, async tx => {
        // The same lock gives balance, lots and the page one consistent view of all credit writers.
        await lockMemberCredits(tx, memberId);
        const now = clock.now(), openings = await remainingLots(tx, memberId);
        const lots = openings.filter(lot => lot.remaining > 0 && !lot.expired);
        const where = eq(classCreditEntries.memberId, memberId);
        const total = await tx.$count(classCreditEntries, where);
        const rows = await tx.select().from(classCreditEntries).where(where)
          .orderBy(desc(classCreditEntries.createdAt), desc(classCreditEntries.id)).limit(query.limit).offset(query.offset);
        const invoiceFor = await saleInvoices(tx, [...rows, ...lots], openings);
        return { data: { memberId, balance: creditBalance(usableCreditLots(openings, now)),
        lots: lots.map(lot => ({ id: lot.id, remaining: lot.remaining, expiresAt: lot.expiresAt?.toISOString() ?? null,
          createdAt: lot.createdAt.toISOString(), saleId: lot.saleId, invoiceId: invoiceFor(lot)?.invoiceId ?? null, invoiceNumber: invoiceFor(lot)?.invoiceNumber ?? null })),
        entries: rows.map(row => entry(row, invoiceFor(row))) }, pagination: { ...query, total } };
      });
    },
  };
}
export type CreditLedgerService = ReturnType<typeof createCreditLedgerService>;
