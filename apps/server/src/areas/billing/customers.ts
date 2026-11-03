// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { auditEvents, forGym, households, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../core/clock.js';
import { CustomerCreationInProgress, type Payments } from '../../infra/payments/index.js';
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

/** An unresolved creation must never be repeated after the provider can forget its key. */
export function createCustomersService(options: CustomersOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const sleep = options.sleep ?? pause;
  const reservationAction = 'billing.customer.creation_reserved';
  function details(household: typeof households.$inferSelect, unlinked: string | null = null) {
    if (!household.email?.trim() || !household.name.trim()) throw new CustomerUnavailable('missing_details');
    return { email: household.email, name: household.name, householdId: household.id,
      idempotencyKey: `household:${household.id}:customer` + (unlinked ? ':after:' + unlinked : '') };
  }
  const audit = (tx: Transaction, gymId: string, householdId: string, action: string, after: unknown) => writeAudit(tx, {
    gymId, actorKind: 'system', action, targetType: 'household', targetId: householdId,
    before: null, after, occurredAt: clock.now(),
  });

  /**
   * The household's creation generation: `unlinked` is its latest `customerUnlinkedAction` audit (null before any), and
   * `reservation` the creation reserved in that generation, which records the unlink it followed. A creation reserved
   * before an unlink made the old customer, in another mode or account, and must neither block nor replay a new one.
   * Unlinks and reservations are written under the household's row lock, so they never interleave.
   */
  async function currentReservation(tx: Transaction, householdId: string) {
    const rows = (action: string) => tx.select().from(auditEvents).where(and(eq(auditEvents.targetType, 'household'),
      eq(auditEvents.targetId, householdId), eq(auditEvents.action, action))).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));
    const [unlinked] = await rows(customerUnlinkedAction).limit(1), generation = unlinked?.id ?? null;
    const reservation = (await rows(reservationAction)).find((row) => ((row.after as { unlinked?: string } | null)?.unlinked ?? null) === generation);
    return { reservation, unlinked: generation };
  }

  /** The gym's latest switch from test to live (its audit's ID), or null. */
  async function lastSwitch(tx: Transaction, gymId: string): Promise<string | null> {
    const [row] = await tx.select({ id: auditEvents.id }).from(auditEvents)
      .where(and(eq(auditEvents.action, stripeTestClearedAction), eq(auditEvents.targetId, gymId)))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
    return row?.id ?? null;
  }

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
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      if (reservation) {
        const saved = reservation.after as { requestHash?: string } | null;
        if (saved?.requestHash !== requestHash) throw new CustomerUnavailable('details_changed');
        if (clock.now().getTime() >= reservation.occurredAt.getTime() + 23 * 60 * 60 * 1000)
          throw new CustomerUnavailable('creation_expired');
      }
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
   * cleared with an audit and replaced by a new one; any other failure is raised. A customer this service created and
   * linked is the account's own (a key for another account is refused while it is linked), so it needs no Stripe call.
   * With a test key the ID is kept and the Checkout refused instead: a live customer of the gym's own account (one
   * imported, say) looks missing to a test key, and replacing it would lose the member's live customer.
   */
  async function readableCustomer(gymId: string, householdId: string, customerId: string, provider: Payments): Promise<string> {
    const created = await scope(gymId, async tx => (await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
      eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, householdId), eq(auditEvents.action, 'billing.customer.linked'))))
      .some(({ after }) => (after as { customerId?: unknown } | null)?.customerId === customerId));
    if (created) return customerId;
    try { await provider.adoptCustomer(customerId); return customerId; }
    catch (error) {
      if (!unreadable(error)) throw error;
      if (provider.keyMode === 'test') throw new CustomerUnavailable('customer_unreadable', error);
    }
    await scope(gymId, async tx => {
      const [cleared] = await tx.update(households).set({ stripeCustomerId: null })
        .where(and(eq(households.id, householdId), eq(households.stripeCustomerId, customerId))).returning({ id: households.id });
      if (cleared) await writeAudit(tx, { gymId, actorKind: 'system', action: customerUnlinkedAction, targetType: 'household', targetId: householdId,
        before: { customerId }, after: { customerId: null, reason: 'unreadable' }, occurredAt: clock.now() });
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
/**
 * Audited (target: the gym) by a switch from test to live; the latest one is the gym's test-data boundary. A creation
 * that started before it and wasn't cleared by it is abandoned when it comes to link (`ensureCustomer`).
 */
export const stripeTestClearedAction = 'integrations.stripe_test_cleared';
/** Stripe's answer for an object this account doesn't have (`resource_missing`, 404 or 400), as the payments module raises it. */
function unreadable(error: unknown): boolean {
  const value = error as { code?: unknown; statusCode?: unknown } | null;
  return !!value && value.code === 'resource_missing' && (value.statusCode === 404 || value.statusCode === 400);
}
