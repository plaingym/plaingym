// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { plans, classPacks, chargeTypes, discounts, memberships, invoices, paymentMethods, type Transaction } from '@plaingym/db';
import { AppError } from '@plaingym/shared';

/**
 * Refuses a currency change once the gym has billing records or an active bank account its current currency charges.
 * `currency` is the gym's current currency. Call it after locking the gym row `for update`, so a concurrent billing
 * insert and the currency change serialize.
 */
export async function assertCurrencyChangeable(tx: Transaction, gymId: string, currency: string): Promise<void> {
  // Discounts are listed too: the setup save has no currency foreign-key mapping of its own.
  for (const table of [plans, classPacks, chargeTypes, discounts, memberships, invoices]) {
    const existing = await tx.select({ id: table.id }).from(table).where(eq(table.gymId, gymId)).limit(1);
    if (existing.length) throw new AppError('conflict', 'Currency cannot change after billing records exist');
  }
  // Matches `bankAccountType` in `areas/billing/customer-card-import.ts` (inline because billing imports settings).
  const bankType = currency === 'USD' ? 'us_bank_account' : currency === 'CAD' ? 'acss_debit' : null;
  if (bankType) {
    const existing = await tx.select({ id: paymentMethods.id }).from(paymentMethods)
      .where(and(eq(paymentMethods.gymId, gymId), eq(paymentMethods.type, bankType), isNull(paymentMethods.revokedAt)))
      .limit(1);
    if (existing.length) throw new AppError('conflict', 'Currency cannot change after billing records exist');
  }
}
