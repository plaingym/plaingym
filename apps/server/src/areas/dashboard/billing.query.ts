// SPDX-License-Identifier: AGPL-3.0-only
import { lt, ne, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated parameterized arithmetic; Drizzle has no modulo operator.
import { sql } from 'drizzle-orm';
import { invoices } from '@plaingym/db';
import { minimumChargeAmount, minorUnitStep } from '@plaingym/shared/money';

/** Called within forGym, with an invoice currency filter matching this currency. */
export function skippedAmountCondition(currency: string) {
  const minimum = minimumChargeAmount(currency), step = minorUnitStep(currency);
  return or(lt(invoices.amountCents, minimum ?? 0),
    ne(sql<number>`mod(${invoices.amountCents}, ${step}::integer)`, 0));
}
