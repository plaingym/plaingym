// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, not, notExists } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The scoped erasure query needs isolated JSON extraction and one aliased audit anti-join.
import { sql } from 'drizzle-orm';
import { auditEvents, households, type Transaction } from '@plaingym/db';

/** Audited (target: the erased household) when the daily check queued an erasure's customer (`after.erasure`: its `household.anonymized` audit). */
export const redactionQueuedAction = 'members.erasure.redaction_queued';
/** Audited (target: the gym) when a customer redaction succeeded (`after.stripeCustomerId`). */
export const customerRedactedAction = 'members.erasure.customer_redacted';
/** Identifier-only markers for narrow billing email cleanup and its completion. */
export const billingEmailQueuedAction = 'members.erasure.billing_email_queued';
export const billingEmailClearedAction = 'members.erasure.billing_email_cleared';

export function billingEmailErasuresToRetry(tx: Transaction, gymId: string, limit: number, afterId?: string) {
  const erasure = sql<string>`${auditEvents.after}->>'erasure'`;
  return tx.select({ id: auditEvents.id, erasureId: erasure }).from(auditEvents).where(and(eq(auditEvents.gymId, gymId),
    eq(auditEvents.action, billingEmailQueuedAction),
    afterId ? gt(auditEvents.id, afterId) : undefined,
    sql`${erasure} ~ '^[a-f0-9-]{36}$'`,
    sql`not exists (select 1 from audit_events completed where completed.gym_id = ${gymId}
      and completed.action = ${billingEmailClearedAction} and completed.after->>'erasure' = ${erasure})`))
    .orderBy(asc(auditEvents.id)).limit(limit);
}

/**
 * Called inside forGym: the oldest erasures (`household.anonymized` audits that recorded a Stripe customer ID) whose
 * customer still needs a redaction queued, at most `limit`. An erasure is handled once the check queued it (a marker
 * naming the erasure, or, from before markers named one, a marker for its customer written after it) or once a
 * redaction of its customer succeeded after it. A customer a household of the gym links today is left out: the gym
 * reused it. The isolated SQL fragments extract the audit JSON's customer and erasure, and alias the marker audits
 * apart from the erasure's own row; the anti-joins and the limit run in the database, so a run reads only what it queues.
 */
export function erasuresToRedact(tx: Transaction, gymId: string, limit: number) {
  const customer = sql<string>`${auditEvents.before}->>'stripeCustomerId'`;
  const handled = sql`exists (select 1 from audit_events marker where marker.gym_id = ${gymId} and (
    (marker.action = ${redactionQueuedAction} and (marker.after->>'erasure' = ${auditEvents.id}::text
      or (marker.after->>'erasure' is null and marker.after->>'stripeCustomerId' = ${customer} and marker.created_at >= ${auditEvents.createdAt})))
    or (marker.action = ${customerRedactedAction} and marker.after->>'stripeCustomerId' = ${customer} and marker.created_at >= ${auditEvents.createdAt})))`;
  return tx.select({ id: auditEvents.id, householdId: auditEvents.targetId, customerId: customer }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'household.anonymized'), sql`${customer} ~ '^cus_[A-Za-z0-9_]+$'`,
      not(handled), notExists(tx.select({ id: households.id }).from(households).where(eq(households.stripeCustomerId, customer)))))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id)).limit(limit);
}
