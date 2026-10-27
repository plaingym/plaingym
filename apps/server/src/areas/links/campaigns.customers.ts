// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { auditEvents, households, type forGym, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { Payments } from '../../infra/payments/index.js';

/** Email is only a candidate lookup: ambiguous matches and customers already linked elsewhere are left alone. */
export async function matchCampaignCustomer(options: {
  scope: typeof forGym; clock: Clock; paymentsFor(gymId: string): Promise<Payments>;
}, gymId: string, householdId: string) {
  const { scope, clock } = options;
  const [before] = await scope(gymId, tx => tx.select().from(households).where(eq(households.id, householdId)));
  if (!before || before.stripeCustomerId || !before.email?.trim()) return;
  const matches = await (await options.paymentsFor(gymId)).findCustomerByEmail(before.email.trim());
  if (matches.length !== 1) return;
  const match = matches[0]!;
  if (match.email.trim().toLowerCase() !== before.email.trim().toLowerCase()) return;
  try {
    await scope(gymId, async tx => {
      const [current] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!current || current.stripeCustomerId || current.email !== before.email) return;
      // R6 reserves under this same household lock. Never race an already-started creation.
      const [reservation] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
        eq(auditEvents.targetId, householdId), eq(auditEvents.action, 'billing.customer.creation_reserved'))).limit(1);
      if (reservation) return;
      const [claimed] = await tx.select({ id: households.id }).from(households).where(eq(households.stripeCustomerId, match.id));
      if (claimed) return;
      await tx.update(households).set({ stripeCustomerId: match.id }).where(and(eq(households.id, householdId), isNull(households.stripeCustomerId)));
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.customer_matched',
        targetType: 'household', targetId: householdId, after: { matched: true }, occurredAt: clock.now() });
    });
  } catch (error) {
    // Another household can win the existing gym/customer unique constraint during the lookup.
    const cause = error instanceof Error ? error.cause : error;
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505'
      && 'constraint_name' in cause && cause.constraint_name === 'households_gym_stripe_customer_key') return;
    throw error;
  }
}
