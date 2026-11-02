// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, exists } from 'drizzle-orm';
import { chargeTypes, chargeTypeTaxRates, forGym, gyms, taxRates, type Transaction } from '@plaingym/db';
import { addsTaxOnTop } from '../billing/invoicing/adds-tax-on-top.js';

/** `plusTax`: invoicing adds tax on top of `amountCents`, so the page says "+ tax" next to the price. */
export type DropInFee = { amountCents: number; currency: string; plusTax: boolean };
/**
 * Reads the drop-in fee from the charge type the gym chose, at its current price, on every call, in one query.
 * No choice, or an archived charge type, gives null: the page then asks visitors to contact the gym. An archived
 * charge type is left out of the join, so its tax rates are never read. A caller already inside a gym scope passes
 * its transaction to share its connection.
 * `plusTax` is true when an active rate attached to the charge type adds tax on top. A one-off invoice
 * refuses an archived rate and never applies it, so an archived rate gives no note.
 */
export function createDropInFee(options: { scope?: typeof forGym } = {}) {
  const scope = options.scope ?? forGym;
  return async function dropInFeeFor(gymId: string, existing?: Transaction): Promise<DropInFee | null> {
    const read = async (tx: Transaction): Promise<DropInFee | null> => {
      const [row] = await tx.select({ amountCents: chargeTypes.amountCents, currency: chargeTypes.currency,
        plusTax: exists(tx.select({ id: chargeTypeTaxRates.id }).from(chargeTypeTaxRates)
          .innerJoin(taxRates, eq(taxRates.id, chargeTypeTaxRates.taxRateId))
          .where(and(eq(chargeTypeTaxRates.chargeTypeId, chargeTypes.id), eq(taxRates.active, true), addsTaxOnTop))).mapWith(Boolean) })
        .from(gyms).innerJoin(chargeTypes, and(eq(chargeTypes.gymId, gyms.id), eq(chargeTypes.id, gyms.dropInChargeTypeId), eq(chargeTypes.active, true)))
        .where(eq(gyms.id, gymId));
      return row ? { amountCents: row.amountCents, currency: row.currency, plusTax: row.plusTax } : null;
    };
    return existing ? read(existing) : scope(gymId, read);
  };
}
