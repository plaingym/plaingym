// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { chargeTypes, forGym, gyms } from '@plaingym/db';

export type DropInFee = { amountCents: number; currency: string };
/**
 * Reads the drop-in fee from the charge type the gym chose, at its current price, on every call.
 * No choice, or an archived charge type, gives null: the page then asks visitors to contact the gym.
 */
export function createDropInFee(options: { scope?: typeof forGym } = {}) {
  const scope = options.scope ?? forGym;
  return async function dropInFeeFor(gymId: string): Promise<DropInFee | null> {
    const [row] = await scope(gymId, tx => tx.select({ amountCents: chargeTypes.amountCents, currency: chargeTypes.currency, active: chargeTypes.active })
      .from(gyms).innerJoin(chargeTypes, and(eq(chargeTypes.gymId, gyms.id), eq(chargeTypes.id, gyms.dropInChargeTypeId)))
      .where(eq(gyms.id, gymId)));
    return row?.active ? { amountCents: row.amountCents, currency: row.currency } : null;
  };
}
