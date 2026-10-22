// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { Transaction } from './client.js';
import { invoiceSequences } from './schema/billing.js';
/**
 * Allocates the gym's next invoice display number inside the issuing transaction.
 * The upsert locks the gym's sequence row, so concurrent issuers serialize and a
 * number is never reused; a rolled-back issue rolls back its allocation too.
 */
export async function allocateInvoiceNumber(tx: Transaction, gymId: string): Promise<number> {
  const [row] = await tx.insert(invoiceSequences).values({ gymId, lastNumber: 1 })
    .onConflictDoUpdate({ target: invoiceSequences.gymId, set: { lastNumber: sql`${invoiceSequences.lastNumber} + 1` } })
    .returning({ number: invoiceSequences.lastNumber });
  return row!.number;
}
