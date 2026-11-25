// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gte, ne } from 'drizzle-orm';
import { auditEvents, forGym, households, paymentMethods, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { logInfo, logWarn } from '../../../../core/log.js';
import type { PaymentMethod, Payments } from '../../../../infra/payments/index.js';
import { unsavedBankRevoked } from '../../transitions/bank.js';
import { audit } from '../../transitions/store.js';

/** Row locks serialize card changes per household; never re-enable a staff-revoked method. */
export function createCardHandlers(options: { scope: typeof forGym; clock: Clock }) {
  const { scope, clock } = options;
  const system = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
  const incompleteBankSkipped = 'billing.payment_method.incomplete_bank_skipped';
  const collectionCompleted = 'billing.payment_method.deferred_collection_completed';
  // Callers hold the household row lock.
  async function findIncompleteBankSkip(tx: Transaction, householdId: string, methodId: string) {
    const rows = await tx.select({ after: auditEvents.after, occurredAt: auditEvents.occurredAt }).from(auditEvents).where(and(
      eq(auditEvents.action, incompleteBankSkipped), eq(auditEvents.targetType, 'household'),
      eq(auditEvents.targetId, householdId)));
    const row = rows.find(({ after }) => (after as { paymentMethodId?: unknown } | null)?.paymentMethodId === methodId);
    // The skip's time comes from the injected clock, as every default change's audit time does.
    return row ? { ...row.after as { mandateId?: unknown; setupId?: unknown }, skippedAt: row.occurredAt } : undefined;
  }
  // Callers hold the household row lock.
  async function collectionWasCompleted(tx: Transaction, householdId: string, methodId: string) {
    const rows = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
      eq(auditEvents.action, collectionCompleted), eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, householdId)));
    return rows.some(({ after }) => (after as { paymentMethodId?: unknown } | null)?.paymentMethodId === methodId);
  }
  // Callers hold the household row lock.
  async function defaultChangedSince(tx: Transaction, householdId: string, since: Date) {
    const rows = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
      eq(auditEvents.action, 'billing.card.default_changed'), eq(auditEvents.targetType, 'payment_method'),
      gte(auditEvents.occurredAt, since)));
    return rows.some(({ after }) => (after as { householdId?: unknown } | null)?.householdId === householdId);
  }
  async function save(gymId: string, method: PaymentMethod, collect = false, mandateId?: string,
    eventId?: string): Promise<{ setupId: string } | undefined> {
    if (!Number.isFinite(method.createdAt.getTime())) throw new Error('Payment method creation time is unresolved');
    return scope(gymId, async tx => {
      const household = (await tx.select().from(households).where(eq(households.stripeCustomerId, method.customerId)).for('update'))[0];
      if (!household) {
        // A collection must find its household, so it fails for retry. An update for a customer no household is
        // linked to (an erased household's redacted card, or a dashboard card never imported) has nothing to change.
        if (collect) throw new Error('Saved card household is unresolved');
        logInfo('billing.payment_method.household_unresolved', { gymId, paymentMethodId: method.id,
          customerId: method.customerId, ...(eventId ? { eventId } : {}) });
        return;
      }
      const existing = (await tx.select().from(paymentMethods).where(eq(paymentMethods.processorId, method.id)).for('update'))[0];
      if (existing && existing.householdId !== household.id) throw new Error('Saved card household mismatch');
      if (existing?.revokedAt) return;
      if (!existing && method.type !== 'card') {
        const revocations = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
          eq(auditEvents.action, unsavedBankRevoked), eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, household.id)));
        if (revocations.some(({ after }) => (after as { paymentMethodId?: unknown } | null)?.paymentMethodId === method.id)) return;
      }
      const skipped = method.type !== 'card' ? await findIncompleteBankSkip(tx, household.id, method.id) : undefined;
      // The skipped setup's link completion runs until it has once succeeded.
      const collected = typeof skipped?.setupId === 'string' && !await collectionWasCompleted(tx, household.id, method.id)
        ? { setupId: skipped.setupId } : undefined;
      const deferred = !collect && !existing && !!skipped;
      // An update can finish a bank collection previously skipped for missing digits.
      if (!collect && !existing) {
        if (!skipped) return;
        collect = true;
        if (typeof skipped.mandateId === 'string') mandateId ??= skipped.mandateId;
      }
      if (!collect && method.type !== 'card' && existing) {
        const bankName = method.bankName ?? null;
        if (existing.bankName !== bankName || existing.last4 !== method.last4) {
          const details = { bankName, last4: method.last4 };
          await tx.update(paymentMethods).set(details).where(eq(paymentMethods.id, existing.id));
          await audit(tx, system(gymId), clock, 'billing.payment_method.updated', 'payment_method', existing.id, details);
        }
        return collected;
      }
      const current = (await tx.select().from(paymentMethods).where(and(eq(paymentMethods.householdId, household.id),
        eq(paymentMethods.isDefault, true))))[0];
      // A deferred collection never replaces a default chosen since its skip.
      const chosenSinceSkip = deferred && !!current && await defaultChangedSince(tx, household.id, skipped!.skippedAt);
      const newer = collect && !chosenSinceSkip && (!current || current.processorCreatedAt === null
        || current.processorCreatedAt < method.createdAt
        || (current.processorCreatedAt.getTime() === method.createdAt.getTime() && current.processorId < method.id));
      const rowId = existing?.id ?? uuidv7();
      const details = { last4: method.last4, expiryMonth: method.type === 'card' ? method.expiresMonth : null,
        expiryYear: method.type === 'card' ? method.expiresYear : null, processorCreatedAt: method.createdAt,
        ...(method.type === 'card' ? {} : { type: method.type, bankName: method.bankName ?? null, ...(mandateId ? { mandateId } : {}) }) };
      if (newer) await tx.update(paymentMethods).set({ isDefault: false }).where(and(
        eq(paymentMethods.householdId, household.id), eq(paymentMethods.isDefault, true), ne(paymentMethods.id, rowId)));
      const isDefault = newer ? true : existing?.isDefault ?? false;
      const changed = !existing || existing.last4 !== details.last4 || existing.expiryMonth !== details.expiryMonth
        || existing.expiryYear !== details.expiryYear || existing.isDefault !== isDefault
        || existing.processorCreatedAt?.getTime() !== method.createdAt.getTime()
        || (method.type !== 'card' && (existing.type !== method.type || existing.bankName !== details.bankName
          || (!!mandateId && existing.mandateId !== mandateId)));
      if (!existing) await tx.insert(paymentMethods).values({ id: rowId, gymId, householdId: household.id,
        processorId: method.id, brand: method.type === 'card' ? method.brand ?? null : null, ...details, isDefault, createdAt: clock.now() });
      else if (changed) await tx.update(paymentMethods).set({ ...details, isDefault }).where(eq(paymentMethods.id, rowId));
      if (changed) await audit(tx, system(gymId), clock, 'billing.payment_method.updated', 'payment_method', rowId,
        { ...details, isDefault });
      return collected;
    });
  }
  async function collect(gymId: string, provider: Payments, customerId: string, methodId: string, mandateId?: string, setupId?: string) {
    const found = await provider.readPaymentObject({ kind: 'payment_method', id: methodId });
    if (found.status === 'unknown' && found.incompleteBankMethod?.customerId === customerId) {
      logWarn('billing.payment_method.incomplete_bank', { gymId, paymentMethodId: methodId });
      const hasHousehold = await scope(gymId, async tx => {
        const household = (await tx.select({ id: households.id }).from(households)
          .where(eq(households.stripeCustomerId, customerId)).for('update'))[0];
        if (!household) return false;
        if (!await findIncompleteBankSkip(tx, household.id, methodId))
          await audit(tx, system(gymId), clock, incompleteBankSkipped, 'household', household.id,
            { paymentMethodId: methodId, ...(mandateId ? { mandateId } : {}), ...(setupId ? { setupId } : {}) });
        return true;
      });
      if (!hasHousehold) return;
      // An update may have arrived before the skip was committed.
      const refreshed = await provider.readPaymentObject({ kind: 'payment_method', id: methodId });
      if (refreshed.status === 'found' && refreshed.value.kind === 'payment_method' && refreshed.value.object.customerId === customerId)
        await save(gymId, refreshed.value.object, true, mandateId);
      return;
    }
    if (found.status !== 'found' || found.value.kind !== 'payment_method' || found.value.object.customerId !== customerId)
      throw new Error('Collected payment method is unresolved');
    await save(gymId, found.value.object, true, mandateId);
  }
  async function setup(gymId: string, provider: Payments, id: string) {
    const found = await provider.readPaymentObject({ kind: 'setup', id });
    if (found.status !== 'found' || found.value.kind !== 'setup') throw new Error('SetupIntent is unresolved');
    const setup = found.value.object;
    if (setup.metadata.gymId !== gymId) throw new Error('SetupIntent gym mismatch');
    if (setup.status !== 'succeeded') return;
    if (!setup.paymentMethodId) throw new Error('Successful SetupIntent has no payment method');
    await collect(gymId, provider, setup.customerId, setup.paymentMethodId, setup.mandateId, id);
  }
  /** Records once that a deferred collection's setup link completion succeeded, so later updates skip it. */
  async function markCollectionCompleted(gymId: string, customerId: string, methodId: string, setupId: string) {
    await scope(gymId, async tx => {
      const household = (await tx.select({ id: households.id }).from(households)
        .where(eq(households.stripeCustomerId, customerId)).for('update'))[0];
      if (!household || await collectionWasCompleted(tx, household.id, methodId)) return;
      await audit(tx, system(gymId), clock, collectionCompleted, 'household', household.id, { paymentMethodId: methodId, setupId });
    });
  }
  return { collect, setup, markCollectionCompleted,
    update: (gymId: string, method: PaymentMethod, eventId?: string) => save(gymId, method, false, undefined, eventId) };
}
