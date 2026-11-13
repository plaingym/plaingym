// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { planTaxRates, taxRates, type Transaction } from '@plaingym/db';

/** A plan's tax rates as the invoice engine applies them, in stable order. */
export function planTaxes(tx: Transaction, planId: string) {
  return tx.select({ id: taxRates.id, name: taxRates.name, rateMillionths: taxRates.rateMillionths, inclusive: taxRates.inclusive })
    .from(planTaxRates).innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId)).where(eq(planTaxRates.planId, planId))
    .orderBy(asc(taxRates.id));
}
