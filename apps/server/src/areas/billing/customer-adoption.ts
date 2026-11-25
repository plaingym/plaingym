// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { auditEvents, forGym, households, type Transaction } from '@plaingym/db';

export const customerAdoptedAction = 'billing.customer.adopted';

/**
 * Audits a gym tag this app wrote, once per household and customer. The retry rereads the audits,
 * so a first round that committed but lost its reply never writes a second audit.
 */
export async function recordCustomerAdoption(
  scope: typeof forGym,
  gymId: string,
  householdId: string,
  customerId: string,
  write: (tx: Transaction) => Promise<unknown>,
): Promise<boolean> {
  const round = () => scope(gymId, async tx => {
    await tx.select({ id: households.id }).from(households).where(eq(households.id, householdId)).for('update');
    const existing = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
      eq(auditEvents.action, customerAdoptedAction),
      eq(auditEvents.targetType, 'household'),
      eq(auditEvents.targetId, householdId),
    ));
    if (existing.some(row => (row.after as { customerId?: unknown } | null)?.customerId === customerId)) return false;
    await write(tx);
    return true;
  });
  try { return await round(); }
  catch { return round(); }
}
