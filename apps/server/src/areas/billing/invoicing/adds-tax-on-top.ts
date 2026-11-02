// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt } from 'drizzle-orm';
import { taxRates } from '@plaingym/db';

/**
 * A rate that adds to the price: exclusive, and above zero. This is the rate `calculatePrices` adds on top of an
 * amount. It does not decide which rates apply: each caller filters archived rates as its own invoice path does.
 * Plans count archived rates, as the join and cycle invoices read `plan_tax_rates` without filtering them; the
 * drop-in fee counts only active ones, as `createOneOff` refuses an archived rate.
 */
export const addsTaxOnTop = and(eq(taxRates.inclusive, false), gt(taxRates.rateMillionths, 0));
