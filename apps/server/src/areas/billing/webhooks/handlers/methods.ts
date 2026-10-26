// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, ne } from 'drizzle-orm';
import { forGym, households, paymentMethods, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { PaymentMethod, Payments } from '../../../../infra/payments/index.js';
import { audit } from '../../transitions/store.js';

/** Row locks serialize card changes per household; never re-enable a staff-revoked method. */
export function createCardHandlers(options: { scope: typeof forGym; clock: Clock }) {
  const { scope, clock } = options;
  const system = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
  async function save(gymId: string, method: PaymentMethod, collect = false) {
    if (!Number.isFinite(method.createdAt.getTime())) throw new Error('Payment method creation time is unresolved');
    await scope(gymId, async tx => {
      const household = (await tx.select().from(households).where(eq(households.stripeCustomerId, method.customerId)).for('update'))[0];
      if (!household) throw new Error('Saved card household is unresolved');
      const existing = (await tx.select().from(paymentMethods).where(eq(paymentMethods.processorId, method.id)).for('update'))[0];
      if (existing && existing.householdId !== household.id) throw new Error('Saved card household mismatch');
      if (existing?.revokedAt) return;
      // An update refreshes an already-known card; it is not consent to collect a new card.
      if (!collect && !existing) return;
      const current = (await tx.select().from(paymentMethods).where(and(eq(paymentMethods.householdId, household.id),
        eq(paymentMethods.isDefault, true))))[0];
      const newer = collect && (!current || current.processorCreatedAt === null
        || current.processorCreatedAt < method.createdAt
        || (current.processorCreatedAt.getTime() === method.createdAt.getTime() && current.processorId < method.id));
      const rowId = existing?.id ?? uuidv7();
      const details = { last4: method.last4, expiryMonth: method.expiresMonth, expiryYear: method.expiresYear,
        processorCreatedAt: method.createdAt };
      if (newer) await tx.update(paymentMethods).set({ isDefault: false }).where(and(
        eq(paymentMethods.householdId, household.id), eq(paymentMethods.isDefault, true), ne(paymentMethods.id, rowId)));
      const isDefault = newer ? true : existing?.isDefault ?? false;
      const changed = !existing || existing.last4 !== details.last4 || existing.expiryMonth !== details.expiryMonth
        || existing.expiryYear !== details.expiryYear || existing.isDefault !== isDefault
        || existing.processorCreatedAt?.getTime() !== method.createdAt.getTime();
      if (!existing) await tx.insert(paymentMethods).values({ id: rowId, gymId, householdId: household.id,
        processorId: method.id, ...details, isDefault, createdAt: clock.now() });
      else if (changed) await tx.update(paymentMethods).set({ ...details, isDefault }).where(eq(paymentMethods.id, rowId));
      if (changed) await audit(tx, system(gymId), clock, 'billing.payment_method.updated', 'payment_method', rowId,
        { ...details, isDefault });
    });
  }
  async function collect(gymId: string, provider: Payments, customerId: string, methodId: string) {
    const found = await provider.readPaymentObject({ kind: 'payment_method', id: methodId });
    if (found.status !== 'found' || found.value.kind !== 'payment_method' || found.value.object.customerId !== customerId)
      throw new Error('Collected payment method is unresolved');
    await save(gymId, found.value.object, true);
  }
  async function setup(gymId: string, provider: Payments, id: string) {
    const found = await provider.readPaymentObject({ kind: 'setup', id });
    if (found.status !== 'found' || found.value.kind !== 'setup') throw new Error('SetupIntent is unresolved');
    const setup = found.value.object;
    if (setup.metadata.gymId !== gymId) throw new Error('SetupIntent gym mismatch');
    if (setup.status !== 'succeeded') return;
    if (!setup.paymentMethodId) throw new Error('Successful SetupIntent has no payment method');
    await collect(gymId, provider, setup.customerId, setup.paymentMethodId);
  }
  return { collect, setup, update: (gymId: string, method: PaymentMethod) => save(gymId, method) };
}
