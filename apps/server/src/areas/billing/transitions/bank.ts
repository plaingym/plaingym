// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { auditEvents, households, paymentAttempts, paymentMethods, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { MutationContext } from '../../../core/interfaces/common.js';
import { holdGymSettings, readGymSettings } from '../../settings/settings.js';
import { promoteDefaultCard } from '../payments.mutations.js';
import { abandonedAttempt, audit, canceledAttempt, type InvoiceRow } from './store.js';

export const retriesStopped = 'billing.invoice.retries_stopped';
export const invoiceProcessing = 'billing.invoice.processing';
export const invoiceLateProcessing = 'billing.invoice.late_processing';
export const unsavedBankRevoked = 'billing.payment_method.unsaved_revoked';

/** The invoice lock serializes the intent history, including Checkout payments without a runner attempt. */
export async function processingIntents(tx: Transaction, invoiceId: string) {
  const rows = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
    eq(auditEvents.targetId, invoiceId), eq(auditEvents.action, invoiceProcessing)));
  return rows.map(row => row.after as { paymentIntentId: string; sequence: number })
    .sort((first, second) => first.sequence - second.sequence).map(event => event.paymentIntentId);
}

/** Three failed debits that reached the bank; an abandoned or cancelled-before-confirm attempt never did. */
export async function bankAttemptsExhausted(tx: Transaction, invoice: InvoiceRow) {
  const failed = await tx.select({ declineCode: paymentAttempts.declineCode }).from(paymentAttempts).innerJoin(paymentMethods, and(
    eq(paymentMethods.gymId, paymentAttempts.gymId), eq(paymentMethods.processorId, paymentAttempts.savedPaymentMethod)))
    .where(and(eq(paymentAttempts.invoiceId, invoice.id), eq(paymentMethods.householdId, invoice.householdId),
      eq(paymentAttempts.status, 'failed'), inArray(paymentMethods.type, ['us_bank_account', 'acss_debit'])));
  return failed.filter(row => !abandonedAttempt(row) && !canceledAttempt(row)).length >= 3;
}

export async function revokeBankMethod(tx: Transaction, context: MutationContext, clock: Clock, invoice: InvoiceRow, processorId: string) {
  // Lock order: invoice (caller), gym settings (key share), household, as staff default changes, card removal and the
  // Stripe key switch take the gym before households. Under a live provider, the invoice taken first meets the test-to-live
  // clear's gym-then-invoices order the other way round; PostgreSQL detects that deadlock and the job retries.
  await holdGymSettings(tx, context.gymId);
  await tx.select({ id: households.id }).from(households).where(eq(households.id, invoice.householdId)).for('update');
  const [removed] = await tx.update(paymentMethods).set({ revokedAt: clock.now(), isDefault: false }).where(and(
    eq(paymentMethods.householdId, invoice.householdId), eq(paymentMethods.processorId, processorId),
    inArray(paymentMethods.type, ['us_bank_account', 'acss_debit']), isNull(paymentMethods.revokedAt))).returning();
  if (!removed) {
    // A saved row may have already been revoked.
    const [saved] = await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(and(
      eq(paymentMethods.householdId, invoice.householdId), eq(paymentMethods.processorId, processorId)));
    if (saved) return;
    const revocations = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
      eq(auditEvents.action, unsavedBankRevoked), eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, invoice.householdId)));
    if (!revocations.some(({ after }) => (after as { paymentMethodId?: unknown } | null)?.paymentMethodId === processorId))
      await audit(tx, context, clock, unsavedBankRevoked, 'household', invoice.householdId,
        { invoiceId: invoice.id, paymentMethodId: processorId });
    return;
  }
  await audit(tx, context, clock, 'billing.payment_method.revoked', 'payment_method', removed.id, { invoiceId: invoice.id });
  const gym = await readGymSettings(tx, context.gymId);
  await promoteDefaultCard(tx, context, clock, invoice.householdId, gym.timezone);
}
