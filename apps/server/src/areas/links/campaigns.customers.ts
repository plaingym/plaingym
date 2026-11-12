// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { auditEvents, households, type forGym, type Transaction, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { CustomerMatch, Payments } from '../../infra/payments/index.js';
import { creationLeaseMs, creationReleasedAction, creationRetriedAction, customerRequestHash, customerUnlinkedAction,
  reservationAction } from '../billing/customers.js';

/**
 * Select the newest event of each kind by transaction start time, with ID as a tie-breaker.
 * This is not household-lock acquisition order. Generation and attempt references discard older events.
 * One statement, at most four returned rows.
 */
export async function campaignCreationLease(tx: Transaction, household: typeof households.$inferSelect, now: Date) {
  const events = await tx.selectDistinctOn([auditEvents.action]).from(auditEvents).where(and(
    eq(auditEvents.gymId, household.gymId), eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, household.id),
    inArray(auditEvents.action, [customerUnlinkedAction, reservationAction, creationRetriedAction, creationReleasedAction])))
    .orderBy(asc(auditEvents.action), desc(auditEvents.createdAt), desc(auditEvents.id));
  return creationLease(events, household, now);
}

function creationLease(events: (typeof auditEvents.$inferSelect)[], household: typeof households.$inferSelect, now: Date) {
  const event = (action: string) => events.find(row => row.action === action);
  const unlinked = event(customerUnlinkedAction)?.id ?? null, reservation = event(reservationAction);
  const saved = reservation?.after as { unlinked?: string; requestHash?: string } | null;
  if (!reservation || (saved?.unlinked ?? null) !== unlinked) return { state: 'none' as const };
  const retry = event(creationRetriedAction);
  const latest = (retry?.after as { reservation?: string } | null)?.reservation === reservation.id ? retry! : reservation;
  const release = event(creationReleasedAction);
  const state = now.getTime() < latest.occurredAt.getTime() + creationLeaseMs ? 'active'
    : (release?.after as { attempt?: string } | null)?.attempt === latest.id ? 'released' : 'expired';
  return { state, reservation: reservation.id, attempt: latest.id,
    matchesRequest: saved?.requestHash === customerRequestHash(household, unlinked) };
}

type CreationLease = ReturnType<typeof creationLease>;
/** After the lease, a reservation for other details holds matching until staff reconcile the household. */
const matchHeld = (lease: CreationLease): lease is Exclude<CreationLease, { state: 'none' }> =>
  lease.state !== 'none' && lease.state !== 'active' && !lease.matchesRequest;

/** Two bounded reads for a recipient page; no per-household queries or provider calls. */
export async function campaignCustomerHolds(tx: Transaction, householdIds: string[], now: Date) {
  const held = new Set<string>();
  if (!householdIds.length) return held;
  const candidates = await tx.select().from(households).where(and(inArray(households.id, householdIds), isNull(households.stripeCustomerId)));
  if (!candidates.length) return held;
  const events = await tx.selectDistinctOn([auditEvents.targetId, auditEvents.action]).from(auditEvents).where(and(
    eq(auditEvents.gymId, candidates[0]!.gymId), eq(auditEvents.targetType, 'household'),
    inArray(auditEvents.targetId, candidates.map(household => household.id)),
    inArray(auditEvents.action, [customerUnlinkedAction, reservationAction, creationRetriedAction, creationReleasedAction])))
    .orderBy(asc(auditEvents.targetId), asc(auditEvents.action), desc(auditEvents.createdAt), desc(auditEvents.id));
  for (const household of candidates) {
    if (matchHeld(creationLease(events.filter(event => event.targetId === household.id), household, now))) held.add(household.id);
  }
  return held;
}

async function recordMatchHold(tx: Transaction, household: typeof households.$inferSelect, lease: CreationLease, now: Date) {
  if (!matchHeld(lease)) return false;
  // The caller holds the household lock, so concurrent passes cannot write this twice.
  const events = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
    eq(auditEvents.gymId, household.gymId), eq(auditEvents.targetId, household.id), eq(auditEvents.targetType, 'household'),
    eq(auditEvents.action, 'link_campaign.customer_match_held')));
  if (!events.some(event => (event.after as { reservation?: string } | null)?.reservation === lease.reservation))
    await writeAudit(tx, { gymId: household.gymId, actorKind: 'system', action: 'link_campaign.customer_match_held',
      targetType: 'household', targetId: household.id, after: { reservation: lease.reservation }, occurredAt: now });
  return true;
}

/**
 * Email is only a candidate lookup: ambiguous matches and customers already linked elsewhere are left alone, and a customer
 * whose metadata names another household is never a candidate. One that names this household (made by a customer creation
 * whose reply was lost) wins over customers that name none.
 *
 * A customer creation in progress holds off matching for its lease. After the lease, the lookup above is the check for the
 * customer the creation may have made: if its request still matches and none names the household, the reservation is released (audited) and matching
 * goes on with the other candidates; a later creation still replays the reservation's own key. While a changed-details
 * hold is in force the lookup still runs, but only a single customer naming this household is linked; email-only matches wait.
 */
export async function matchCampaignCustomer(options: {
  scope: typeof forGym; clock: Clock; paymentsFor(gymId: string): Promise<Payments>;
}, gymId: string, householdId: string) {
  const { scope, clock } = options;
  const before = await scope(gymId, async tx => {
    const [household] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
    if (!household || household.stripeCustomerId) return undefined;
    const lease = await campaignCreationLease(tx, household, clock.now());
    await recordMatchHold(tx, household, lease, clock.now());
    if (!household.email?.trim()) return undefined;
    return { email: household.email, lease };
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
      if (!current || current.stripeCustomerId) return;
      // Customer creation reserves and retries under this same household lock. Never race a creation that may still create.
      const lease = await campaignCreationLease(tx, current, clock.now());
      const held = await recordMatchHold(tx, current, lease, clock.now());
      if (current.email !== before.email || lease.state === 'active') return;
      // A hold forbids email-only attribution. An exact gym-tagged customer naming this household is stronger evidence.
      if (held && (!match || match.householdId !== householdId)) return;
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
