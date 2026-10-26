// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { auditEvents, forGym, households, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../core/clock.js';
import { CustomerCreationInProgress, type Payments } from '../../infra/payments/index.js';

export type CustomerUnavailableReason = 'stripe_not_configured' | 'missing_details' | 'creation_expired' | 'details_changed';
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
  function details(household: typeof households.$inferSelect) {
    if (!household.email?.trim() || !household.name.trim()) throw new CustomerUnavailable('missing_details');
    return { email: household.email, name: household.name, householdId: household.id,
      idempotencyKey: `household:${household.id}:customer` };
  }
  const audit = (tx: Transaction, gymId: string, householdId: string, action: string, after: unknown) => writeAudit(tx, {
    gymId, actorKind: 'system', action, targetType: 'household', targetId: householdId,
    before: null, after, occurredAt: clock.now(),
  });

  async function ensureCustomer(gymId: string, householdId: string): Promise<string> {
    // Resolve local configuration before reserving an operation that might reach Stripe.
    // Existing/imported IDs never depend on provider configuration or payer details.
    const existing = await scope(gymId, async tx => {
      const [household] = await tx.select().from(households).where(eq(households.id, householdId));
      if (!household) throw new AppError('not_found', 'Household not found');
      if (!household.stripeCustomerId) details(household);
      return household.stripeCustomerId;
    });
    if (existing) return existing;
    let provider: Payments;
    try { provider = await options.paymentsFor(gymId); }
    catch (error) { throw new CustomerUnavailable('stripe_not_configured', error); }
    const prepared = await scope(gymId, async tx => {
      const [household] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!household) throw new AppError('not_found', 'Household not found');
      if (household.stripeCustomerId) return { kind: 'linked' as const, customerId: household.stripeCustomerId };
      const request = details(household);
      // Keep PII out of the audit log. If details change after an uncertain call, refuse
      // rather than send different parameters with the same key or create another customer.
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const [reservation] = await tx.select().from(auditEvents).where(and(
        eq(auditEvents.action, reservationAction), eq(auditEvents.targetId, householdId),
      )).limit(1);
      if (reservation) {
        const saved = reservation.after as { requestHash?: string } | null;
        if (saved?.requestHash !== requestHash) throw new CustomerUnavailable('details_changed');
        if (clock.now().getTime() >= reservation.occurredAt.getTime() + 23 * 60 * 60 * 1000)
          throw new CustomerUnavailable('creation_expired');
      }
      const stored = reservation ?? await audit(tx, gymId, householdId, reservationAction, { requestHash });
      return { kind: 'create' as const, request, reservedUntil: stored.occurredAt.getTime() + 23 * 60 * 60 * 1000 };
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
    return scope(gymId, async tx => {
      const [household] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!household) throw new AppError('not_found', 'Household not found');
      // An import or another opener may have linked the household while Stripe was called.
      if (household.stripeCustomerId) return household.stripeCustomerId;
      const [saved] = await tx.update(households).set({ stripeCustomerId: customer.id, revision: household.revision + 1 })
        .where(and(eq(households.id, householdId), isNull(households.stripeCustomerId))).returning();
      if (!saved) throw new AppError('conflict', 'Household changed');
      await audit(tx, gymId, householdId, 'billing.customer.linked', { customerId: customer.id });
      return saved.stripeCustomerId!;
    });
  }
  return { ensureCustomer };
}
