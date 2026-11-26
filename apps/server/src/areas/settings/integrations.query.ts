// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, exists, inArray, isNotNull, isNull, ne, notExists, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated JSON text extractions from audit rows: the audited customer ID and the saved Stripe mode.
import { sql } from 'drizzle-orm';
import { auditEvents, households, paymentAttempts, paymentMethods, payments, type Transaction } from '@plaingym/db';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';
import type { PaymentTransport } from '../../infra/payments/transport.js';
import { latestTestSwitchId } from '../billing/stripe-writes.js';
import type { StripeConfig } from '../setup/stripe-step.js';

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

/** A household with a customer the app linked, or one imported without a matching link audit. */
export function linkedCustomer(tx: Transaction, gymId: string, linked: boolean) {
  return and(isNotNull(households.stripeCustomerId), (linked ? exists : notExists)(customerLinkAudits(tx, gymId)));
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
    linkedCustomer(tx, gymId, true)));
  return and(isNull(paymentMethods.revokedAt), or(notExists(cardImportAudits(tx, gymId)), exists(clearedHousehold)));
}

/** Card payments recorded through Stripe that no switch marked as test mode. */
const liveCardPayments = and(or(isNotNull(payments.paymentIntentId), isNotNull(payments.chargeId)),
  or(isNull(payments.reference), ne(payments.reference, stripeTestPaymentReference)));
/**
 * Customers, cards and card payments belong to the Stripe account that created them. Returns null when the gym has none,
 * otherwise the Stripe paths of a few of them (newest first), which a restricted key with the setup permissions can read
 * (customers, PaymentIntents, charges and payment methods are all readable). Several, so that one stale ID the account
 * doesn't have can't block a key change on its own. The app's own references come first and, when there are any, alone:
 * customers it linked, attempts, card payments and cards saved through Stripe. Imported customer IDs and cards (written
 * without asking Stripe, so possibly from another account, or mistyped) are used only when nothing else exists.
 * `customersOnly` is true when only imported customer IDs hold them (no customer the app linked, no attempts, card
 * payments or cards): with no Stripe settings, those tie the gym to no account. A customer the app linked always needs
 * the account read, with or without stored settings. `own` is true when the app's own references exist (the paths are
 * theirs): with no stored settings, only those hold a key change to the latest saved mode. What a switch to live cleared is marked, not compared by time: its card payments carry the
 * test-mode reference, the cards it saved through Stripe are revoked (the imported cards it kept aren't), and its
 * attempts aren't sampled after a switch (a live attempt's customer is a household's, and its payment is sampled).
 */
export async function stripeReference(tx: Transaction, gymId: string): Promise<{ paths: string[]; customersOnly: boolean; own: boolean } | null> {
  const switched = await latestTestSwitchId(tx, gymId) !== null;
  const customers = (linked: boolean) => tx.select({ id: households.stripeCustomerId }).from(households)
    .where(linkedCustomer(tx, gymId, linked))
    .orderBy(desc(households.id)).limit(3);
  const cards = (imported: boolean) => tx.select({ id: paymentMethods.processorId }).from(paymentMethods)
    .where(and(switched ? isNull(paymentMethods.revokedAt) : undefined, (imported ? exists : notExists)(cardImportAudits(tx, gymId))))
    .orderBy(desc(paymentMethods.id)).limit(1);
  const linked = await customers(true);
  const attempts = switched ? [] : await tx.select({ id: paymentAttempts.stripeCustomerId }).from(paymentAttempts)
    .orderBy(desc(paymentAttempts.id)).limit(1);
  const paid = await tx.select({ intent: payments.paymentIntentId, charge: payments.chargeId }).from(payments)
    .where(liveCardPayments).orderBy(desc(payments.id)).limit(2);
  const saved = await cards(false), importedCards = await cards(true);
  const own = [...linked.map((row) => '/v1/customers/' + row.id), ...attempts.map((row) => '/v1/customers/' + row.id),
    ...paid.map((row) => row.intent ? '/v1/payment_intents/' + row.intent : '/v1/charges/' + row.charge),
    ...saved.map((row) => '/v1/payment_methods/' + row.id)];
  const paths = own.length ? own : [...(await customers(false)).map((row) => '/v1/customers/' + row.id),
    ...importedCards.map((row) => '/v1/payment_methods/' + row.id)];
  return paths.length ? { paths: [...new Set(paths)],
    customersOnly: !linked.length && !attempts.length && !paid.length && !saved.length && !importedCards.length, own: own.length > 0 } : null;
}
/**
 * Imported customer IDs alone (none the app linked), with no Stripe settings stored, tie the gym to no account: any
 * key, in either mode, is accepted.
 */
export const importedOnly = (config: StripeConfig | null, reference: { customersOnly: boolean } | null) => config === null && reference?.customersOnly === true;
/**
 * The mode of the latest key saved for the gym (in setup or Settings → Payments), or null when none was. With no
 * settings stored (setup's skip removed them, or they can't be read) and the app's own references held, a key change
 * compares its mode with this one. Unlike go-live's `readSavedStripeMode` (the latest save's mode, none after a skip),
 * it passes over a skip's audit, whose mode is null.
 */
export async function savedStripeMode(tx: Transaction, gymId: string): Promise<'test' | 'live' | null> {
  const [row] = await tx.select({ mode: sql<string>`${auditEvents.after}->>'mode'` }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.targetType, 'gym'), eq(auditEvents.targetId, gymId),
      inArray(auditEvents.action, ['integrations.stripe_saved', 'setup.stripe_configured']),
      inArray(sql<string>`${auditEvents.after}->>'mode'`, ['test', 'live'])))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  return row?.mode === 'test' || row?.mode === 'live' ? row.mode : null;
}
/**
 * Whether a key's transport can read an object the gym's current Stripe account created: a key for another account (or
 * the other mode) gets a 404 `resource_missing`. Stripe keeps deleted customers readable, so a deleted one still matches.
 * Call it outside any transaction.
 */
export async function readsStripeReference(transport: PaymentTransport, reference: { paths: string[] }): Promise<boolean> {
  for (const path of reference.paths) {
    if (!/^\/v1\/(customers\/cus|payment_intents\/pi|charges\/(ch|py)|payment_methods\/(pm|card|src))_[A-Za-z0-9_]+$/.test(path)) continue;
    try { await transport.request({ method: 'GET', path }); return true; }
    catch (error) {
      const value = error as { code?: unknown; statusCode?: unknown };
      if (!(value.code === 'resource_missing' && value.statusCode === 404)) throw error;
    }
  }
  return false;
}
