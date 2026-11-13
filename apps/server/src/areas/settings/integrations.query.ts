// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, exists, inArray, isNotNull, isNull, notExists, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The scoped Drizzle subquery needs one isolated JSON text extraction to match the audited customer ID.
import { sql } from 'drizzle-orm';
import { auditEvents, households, paymentMethods, type Transaction } from '@plaingym/db';

/** The audits that record the app linking a household to a Stripe customer: created by the customers service, or matched by email for a link campaign. */
export const customerLinkActions = ['billing.customer.linked', 'link_campaign.customer_matched'];

/**
 * Called inside forGym, in a query on `households`: the audits naming the household's current Stripe customer as one the
 * app linked. With `exists`, the customer is the app's own (made or matched with the gym's key); with `notExists`, it
 * was imported (an import writes Stripe IDs without asking Stripe). The isolated SQL fragment only extracts the audit
 * JSON's customer ID.
 */
export function customerLinkAudits(tx: Transaction, gymId: string) {
  return tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.gymId, gymId),
    inArray(auditEvents.action, customerLinkActions), eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, households.id),
    eq(sql<string>`${auditEvents.after}->>'customerId'`, households.stripeCustomerId)));
}

/** Called inside forGym, in a query on `payment_methods`: the audit of a card the import wrote (never saved through Stripe). */
export function cardImportAudits(tx: Transaction, gymId: string) {
  return tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.gymId, gymId),
    eq(auditEvents.action, 'payment_method.created'), eq(auditEvents.targetType, 'payment_method'), eq(auditEvents.targetId, paymentMethods.id)));
}

/**
 * Called inside forGym, in a query on `payment_methods`: the unrevoked cards a switch from test to live revokes. A card
 * saved through Stripe was saved with the test key; an imported card stays, unless its household's customer is one
 * the switch clears (the card belongs to that customer).
 */
export function testCards(tx: Transaction, gymId: string) {
  const clearedHousehold = tx.select({ id: households.id }).from(households).where(and(eq(households.id, paymentMethods.householdId),
    isNotNull(households.stripeCustomerId), exists(customerLinkAudits(tx, gymId))));
  return and(isNull(paymentMethods.revokedAt), or(notExists(cardImportAudits(tx, gymId)), exists(clearedHousehold)));
}
