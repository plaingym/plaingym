// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt } from 'drizzle-orm';
import { chargeTypes, chargeTypeTaxRates, forGym, gyms, taxRates } from '@plaingym/db';

/** A rate that adds to the price: exclusive, and above zero. The one rule behind every "+ tax" note on the public pages. */
export const addsTaxOnTop = and(eq(taxRates.inclusive, false), gt(taxRates.rateMillionths, 0));
/** `plusTax`: invoicing adds tax on top of `amountCents`, so the page says "+ tax" next to the price. */
export type DropInFee = { amountCents: number; currency: string; plusTax: boolean };
/**
 * Reads the drop-in fee from the charge type the gym chose, at its current price, on every call.
 * No choice, or an archived charge type, gives null: the page then asks visitors to contact the gym.
 * `plusTax` is true when an active rate attached to the charge type adds tax on top. A one-off invoice
 * refuses an archived rate and never applies it, so an archived rate gives no note.
 */
export function createDropInFee(options: { scope?: typeof forGym } = {}) {
  const scope = options.scope ?? forGym;
  return async function dropInFeeFor(gymId: string): Promise<DropInFee | null> {
    return scope(gymId, async tx => {
      const [row] = await tx.select({ id: chargeTypes.id, amountCents: chargeTypes.amountCents, currency: chargeTypes.currency, active: chargeTypes.active })
        .from(gyms).innerJoin(chargeTypes, and(eq(chargeTypes.gymId, gyms.id), eq(chargeTypes.id, gyms.dropInChargeTypeId)))
        .where(eq(gyms.id, gymId));
      if (!row?.active) return null;
      const [added] = await tx.select({ id: chargeTypeTaxRates.id }).from(chargeTypeTaxRates)
        .innerJoin(taxRates, eq(taxRates.id, chargeTypeTaxRates.taxRateId))
        .where(and(eq(chargeTypeTaxRates.chargeTypeId, row.id), eq(taxRates.active, true), addsTaxOnTop)).limit(1);
      return { amountCents: row.amountCents, currency: row.currency, plusTax: added !== undefined };
    });
  };
}
