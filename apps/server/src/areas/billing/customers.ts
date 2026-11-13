// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { auditEvents, forGym, households, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../core/clock.js';
import { CustomerCreationInProgress, CustomerDeleted, type Payments } from '../../infra/payments/index.js';
import { holdGymSettings } from '../settings/settings.js';

export type CustomerUnavailableReason = 'stripe_not_configured' | 'missing_details' | 'creation_expired' | 'details_changed' | 'customer_unreadable';
export class CustomerUnavailable extends AppError {
  constructor(readonly reason: CustomerUnavailableReason, cause?: unknown) {
    super('unavailable', 'Customer creation needs gym assistance');
    this.cause = cause;
  }
}

export interface CustomersOptions {
  scope?: typeof forGym;
  clock?: Clock;
  paymentsFor(gymId: string): Promise<Payments>;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** The provider request for a household, in the customer generation after `unlinked`. */
function customerRequest(household: Pick<typeof households.$inferSelect, 'id' | 'email' | 'name'>, unlinked: string | null) {
  return { email: household.email, name: household.name, householdId: household.id,
    idempotencyKey: `household:${household.id}:customer` + (unlinked ? ':after:' + unlinked : '') };
}

/** Hash the exact reserved provider request, including its customer generation, without storing PII. */
export function customerRequestHash(household: Pick<typeof households.$inferSelect, 'id' | 'email' | 'name'>, unlinked: string | null = null) {
  return createHash('sha256').update(JSON.stringify(customerRequest(household, unlinked))).digest('hex');
}

/** An unresolved creation must never be repeated after the provider can forget its key. */
export function createCustomersService(options: CustomersOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const sleep = options.sleep ?? pause;
  function details(household: typeof households.$inferSelect, unlinked: string | null = null) {
    if (!household.email?.trim() || !household.name.trim()) throw new CustomerUnavailable('missing_details');
    return { ...customerRequest(household, unlinked), email: household.email };
  }
  const audit = (tx: Transaction, gymId: string, householdId: string, action: string, after: unknown) => writeAudit(tx, {
    gymId, actorKind: 'system', action, targetType: 'household', targetId: householdId,
    before: null, after, occurredAt: clock.now(),
  });

  const lastSwitch = latestTestSwitchId;

  async function ensureCustomer(gymId: string, householdId: string, retried = false): Promise<string> {
    // Resolve local configuration before reserving an operation that might reach Stripe.
    // Existing/imported IDs never depend on provider configuration or payer details.
    const { existing, switched } = await scope(gymId, async tx => {
      const [household] = await tx.select().from(households).where(eq(households.id, householdId));
      if (!household) throw new AppError('not_found', 'Household not found');
      if (!household.stripeCustomerId) details(household);
      return { existing: household.stripeCustomerId, switched: await lastSwitch(tx, gymId) };
    });
    if (existing) return existing;
    let provider: Payments;
    try { provider = await options.paymentsFor(gymId); }
    catch (error) { throw new CustomerUnavailable('stripe_not_configured', error); }
    const prepared = await scope(gymId, async tx => {
      const [household] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!household) throw new AppError('not_found', 'Household not found');
      if (household.stripeCustomerId) return { kind: 'linked' as const, customerId: household.stripeCustomerId };
      const { reservation, unlinked } = await currentReservation(tx, householdId);
      const request = details(household, unlinked);
      // Keep PII out of the audit log. If details change after an uncertain call, refuse
      // rather than send different parameters with the same key or create another customer.
      const requestHash = customerRequestHash(household, unlinked);
      if (reservation) {
        const saved = reservation.after as { requestHash?: string } | null;
        if (saved?.requestHash !== requestHash) throw new CustomerUnavailable('details_changed');
        if (clock.now().getTime() >= reservation.occurredAt.getTime() + 23 * 60 * 60 * 1000)
          throw new CustomerUnavailable('creation_expired');
      }
      // A replay renews the reservation's lease, so campaign matching doesn't act while this attempt may still create.
      if (reservation) await audit(tx, gymId, householdId, creationRetriedAction, { reservation: reservation.id });
      const stored = reservation ?? await audit(tx, gymId, householdId, reservationAction, { requestHash, ...(unlinked ? { unlinked } : {}) });
      return { kind: 'create' as const, request, unlinked, reservedUntil: stored.occurredAt.getTime() + 23 * 60 * 60 * 1000 };
    });
    if (prepared.kind === 'linked') return prepared.customerId;
    const retryUntil = clock.now().getTime() + 2500;
    const delays = [100, 250, 500];
    let customer: Awaited<ReturnType<Payments['createCustomer']>>;
    for (let attempt = 0; ; attempt++) {
      if (clock.now().getTime() >= prepared.reservedUntil) throw new CustomerUnavailable('creation_expired');
      try { customer = await provider.createCustomer(prepared.request); break; }
      catch (error) {
        const delay = delays[attempt];
        if (!(error instanceof CustomerCreationInProgress) || delay === undefined
          || clock.now().getTime() + delay >= retryUntil) throw error;
        if (clock.now().getTime() + delay >= prepared.reservedUntil) throw new CustomerUnavailable('creation_expired', error);
        await sleep(delay);
        if (clock.now().getTime() >= retryUntil) throw error;
      }
    }
    const linked = await scope(gymId, async tx => {
      // A switch from test to live holds the gym row for its whole save: a link waits for it, so the switch either
      // sees this household's customer (and clears it) or has committed before the checks below.
      await holdGymSettings(tx, gymId);
      const [household] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!household) throw new AppError('not_found', 'Household not found');
      // An import or another opener may have linked the household while Stripe was called.
      if (household.stripeCustomerId) return household.stripeCustomerId;
      // A switch from test to live unlinked the household while Stripe was called: the customer is the old mode's.
      if ((await currentReservation(tx, householdId)).unlinked !== prepared.unlinked) return null;
      // A switch committed after the provider was resolved, without seeing this creation (reserved after it looked):
      // the customer was made with the old key. Abandon the creation as the switch does, in a new generation.
      if (await lastSwitch(tx, gymId) !== switched) {
        await audit(tx, gymId, householdId, customerUnlinkedAction, { customerId: null, reason: 'stripe_test_cleared' });
        return null;
      }
      // The ID is system-owned and hidden from staff, so linking leaves the staff edit revision unchanged.
      const [saved] = await tx.update(households).set({ stripeCustomerId: customer.id })
        .where(and(eq(households.id, householdId), isNull(households.stripeCustomerId))).returning();
      if (!saved) throw new AppError('conflict', 'Household changed');
      await audit(tx, gymId, householdId, 'billing.customer.linked', { customerId: customer.id });
      return saved.stripeCustomerId!;
    });
    if (linked) return linked;
    // Once, with the provider resolved again: the new generation creates the customer in the gym's current account.
    if (retried) throw new AppError('conflict', 'Household changed');
    return ensureCustomer(gymId, householdId, true);
  }

  /**
   * The household's stored customer, checked with the gym's Stripe account (and tagged for the gym, as a charge does)
   * before a Checkout uses it. A customer the account can't read (404: an imported ID from another account, or a typo) is
   * cleared with an audit and replaced by a new one, as is one the account has deleted (`CustomerDeleted`); any other failure is
   * raised. Every stored customer is read, including one this service created and linked or a link campaign matched: the
   * gym can delete it in the Stripe dashboard, and a Checkout for a deleted customer fails at Stripe. One read per Checkout
   * (a customer already tagged for the gym needs no write).
   * With a test key the ID is kept and the Checkout refused instead: a live customer of the gym's own account (one
   * imported, say) looks missing to a test key, and replacing it would lose the member's live customer. A deleted customer is kept
   * the same way: a test key reads only test mode, and the deleted customer may be the live one the gym later restores.
   */
  async function readableCustomer(gymId: string, householdId: string, customerId: string, provider: Payments): Promise<string> {
    let reason = 'unreadable';
    try { await provider.adoptCustomer(customerId); return customerId; }
    catch (error) {
      if (error instanceof CustomerDeleted) reason = 'deleted';
      else if (!unreadable(error)) throw error;
      if (provider.keyMode === 'test') throw new CustomerUnavailable('customer_unreadable', error);
    }
    await scope(gymId, async tx => {
      const [cleared] = await tx.update(households).set({ stripeCustomerId: null })
        .where(and(eq(households.id, householdId), eq(households.stripeCustomerId, customerId))).returning({ id: households.id });
      if (cleared) await writeAudit(tx, { gymId, actorKind: 'system', action: customerUnlinkedAction, targetType: 'household', targetId: householdId,
        before: { customerId }, after: { customerId: null, reason }, occurredAt: clock.now() });
    });
    return ensureCustomer(gymId, householdId);
  }
  return { ensureCustomer, readableCustomer };
}

/**
 * Audited (under the household's row lock) when a household's Stripe customer ID is cleared, or a creation in flight is
 * abandoned: a switch from test to live, or an ID the account can't read. It starts a new creation generation: a
 * reservation made before it belonged to the old customer and no longer counts.
 */
export const customerUnlinkedAction = 'billing.customer.unlinked';
/** Audited (under the household's row lock) before a customer creation calls Stripe; a failed call leaves it in place. */
export const reservationAction = 'billing.customer.creation_reserved';
/** Audited when a creation replays its reservation (`after.reservation`), renewing the lease. */
export const creationRetriedAction = 'billing.customer.creation_retried';
/**
 * Audited by campaign matching once a lease has run out and no Stripe customer tagged with the household was found
 * (`after.attempt`: the reservation or retry whose lease it ends). It only lets matching link a customer; a later
 * creation still replays the reservation with its own key, which renews the lease.
 */
export const creationReleasedAction = 'billing.customer.creation_released';
/** How long a creation reservation or its latest retry holds off campaign matching. */
export const creationLeaseMs = 15 * 60 * 1000;

/**
 * The household's creation generation: `unlinked` is its latest `customerUnlinkedAction` audit (null before any), and
 * `reservation` the creation reserved in that generation, which records the unlink it followed. A creation reserved
 * before an unlink made the old customer, in another mode or account, and must neither block nor replay a new one.
 * Unlinks and reservations are written under the household's row lock, so they never interleave.
 */
export async function currentReservation(tx: Transaction, householdId: string) {
  const [unlinked] = await householdAudits(tx, householdId, customerUnlinkedAction).limit(1), generation = unlinked?.id ?? null;
  const reservation = (await householdAudits(tx, householdId, reservationAction))
    .find((row) => ((row.after as { unlinked?: string } | null)?.unlinked ?? null) === generation);
  return { reservation, unlinked: generation };
}

/** The household's audits of one action, newest first. */
function householdAudits(tx: Transaction, householdId: string, action: string) {
  return tx.select().from(auditEvents).where(and(eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, householdId),
    eq(auditEvents.action, action))).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));
}
/**
 * Audited (target: the gym) by a switch from test to live; the latest one is the gym's test-data boundary. A creation
 * that started before it and wasn't cleared by it is abandoned when it comes to link (`ensureCustomer`).
 */
export const stripeTestClearedAction = 'integrations.stripe_test_cleared';
/**
 * The gym's latest switch from test to live: its audit's ID and time, or null when the gym never switched. Every reader
 * (customer creation, the charge runner, the webhook inbox and the integrations settings) uses this one query and order.
 */
export async function latestTestSwitch(tx: Transaction, gymId: string): Promise<{ id: string; occurredAt: Date } | null> {
  const [row] = await tx.select({ id: auditEvents.id, occurredAt: auditEvents.occurredAt }).from(auditEvents)
    .where(and(eq(auditEvents.action, stripeTestClearedAction), eq(auditEvents.targetType, 'gym'), eq(auditEvents.targetId, gymId)))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  return row ?? null;
}
/** The latest switch's audit ID (`latestTestSwitch`), or null: what a reader compares to see whether a switch committed since it last read. */
export const latestTestSwitchId = async (tx: Transaction, gymId: string): Promise<string | null> => (await latestTestSwitch(tx, gymId))?.id ?? null;
/** Stripe's answer for an object this account doesn't have (`resource_missing`, 404 or 400), as the payments module raises it. */
function unreadable(error: unknown): boolean {
  const value = error as { code?: unknown; statusCode?: unknown } | null;
  return !!value && value.code === 'resource_missing' && (value.statusCode === 404 || value.statusCode === 400);
}
