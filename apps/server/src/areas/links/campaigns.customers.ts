// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { households, type forGym, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { CustomerMatch, Payments } from '../../infra/payments/index.js';
import { creationLease, creationReleasedAction } from '../billing/customers.js';

/**
 * Email is only a candidate lookup: ambiguous matches and customers already linked elsewhere are left alone, and a customer
 * whose metadata names another household is never a candidate. One that names this household (made by a customer creation
 * whose reply was lost) wins over customers that name none.
 *
 * A customer creation in progress holds off matching for its lease. After the lease, the lookup above is the check for the
 * customer the creation may have made: if none names the household, the reservation is released (audited) and matching
 * goes on with the other candidates; a later creation still replays the reservation's own key.
 */
export async function matchCampaignCustomer(options: {
  scope: typeof forGym; clock: Clock; paymentsFor(gymId: string): Promise<Payments>;
}, gymId: string, householdId: string) {
  const { scope, clock } = options;
  const before = await scope(gymId, async tx => {
    const [household] = await tx.select().from(households).where(eq(households.id, householdId));
    if (!household || household.stripeCustomerId || !household.email?.trim()) return undefined;
    return { email: household.email, lease: await creationLease(tx, householdId, clock.now()) };
  });
  if (!before || before.lease.state === 'active') return;
  const email = before.email.trim().toLowerCase();
  const matches = (await (await options.paymentsFor(gymId)).findCustomerByEmail(before.email.trim()))
    .filter(match => match.email.trim().toLowerCase() === email);
  const own = matches.filter(match => match.householdId === householdId);
  const untagged = matches.filter(match => match.householdId === undefined);
  const match: CustomerMatch | undefined = own.length ? (own.length === 1 ? own[0] : undefined)
    : untagged.length === 1 ? untagged[0] : undefined;
  try {
    await scope(gymId, async tx => {
      const [current] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!current || current.stripeCustomerId || current.email !== before.email) return;
      // Customer creation reserves and retries under this same household lock. Never race a creation that may still create.
      const lease = await creationLease(tx, householdId, clock.now());
      if (lease.state === 'active') return;
      if (lease.state === 'expired' && !own.length) await writeAudit(tx, { gymId, actorKind: 'system', action: creationReleasedAction,
        targetType: 'household', targetId: householdId, after: { reservation: lease.reservation, attempt: lease.attempt }, occurredAt: clock.now() });
      if (!match) return;
      const [claimed] = await tx.select({ id: households.id }).from(households).where(eq(households.stripeCustomerId, match.id));
      if (claimed) return;
      await tx.update(households).set({ stripeCustomerId: match.id }).where(and(eq(households.id, householdId), isNull(households.stripeCustomerId)));
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.customer_matched',
        targetType: 'household', targetId: householdId, after: { matched: true, customerId: match.id,
          ...(match.householdId ? { tagged: true } : {}) }, occurredAt: clock.now() });
    });
  } catch (error) {
    // Another household can win the existing gym/customer unique constraint during the lookup.
    const cause = error instanceof Error ? error.cause : error;
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505'
      && 'constraint_name' in cause && cause.constraint_name === 'households_gym_stripe_customer_key') return;
    throw error;
  }
}
