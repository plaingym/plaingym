// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull } from 'drizzle-orm';
import { auditEvents, households, invoices, paymentAttempts, paymentMethods, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import type { GymSettings } from '../../../core/interfaces/gym-settings.js';
import { isAssignmentInvoice } from '../assignment-invoices.js';
export { assignmentInvoiceCondition, isAssignmentInvoice } from '../assignment-invoices.js';

export type ChargeMode = 'automatic' | 'retry' | 'staff';
export type SkipReason = 'billing_disabled' | 'not_payable' | 'needs_review' | 'pending_attempt' | 'no_saved_card'
  | 'already_attempted' | 'outside_retry_window' | 'not_auto_collectable' | 'not_due' | 'checkout_changed'
  | 'reservation_lost' | 'action_required' | 'collection_changed';
export const skipped = (reason: SkipReason) => ({ status: 'skipped' as const, reason });
export type Skipped = ReturnType<typeof skipped>;
export interface Eligible {
  status: 'eligible';
  invoice: typeof invoices.$inferSelect;
  latest: typeof paymentAttempts.$inferSelect | undefined;
  payment: { customerId: string; methodId: string } | null;
}
/** Exactly the same rules before provider I/O and again under the reservation lock. */
export async function eligibility(tx: Transaction, gym: GymSettings, clock: Clock, invoiceId: string,
  mode: ChargeMode, lock = false): Promise<Eligible | Skipped> {
  if (!gym.billingEnabled) return skipped('billing_disabled');
  const query = tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  const invoice = (await (lock ? query.for('update') : query))[0];
  if (!invoice || !['open', 'past_due'].includes(invoice.status)) return skipped('not_payable');
  if (invoice.needsReview) return skipped('needs_review');
  if (mode !== 'staff' && invoice.dueOn > localDate(clock.now(), gym.timezone)) return skipped('not_due');
  if (mode === 'automatic' && invoice.kind !== 'cycle' && !await isAssignmentInvoice(tx, invoiceId))
    return skipped('not_auto_collectable');
  const attempts = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoice.id))
    .orderBy(asc(paymentAttempts.attemptNumber));
  if (attempts.some(row => row.status === 'pending')) return skipped('pending_attempt');
  if (mode === 'retry') {
    if (invoice.kind !== 'cycle') return skipped('not_auto_collectable');
    const anchor = (await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'billing.invoice.dunning_started'),
      eq(auditEvents.targetId, invoiceId))))[0];
    if (!anchor) return skipped('outside_retry_window');
    const firstDate = localDate(anchor.occurredAt, gym.timezone);
    const deadlines = [3, 7].map(day => zonedInstant(addDays(firstDate, day), '09:00', gym.timezone, { gap: 'shift' })!);
    const deadline = deadlines.filter(date => date <= clock.now()).at(-1);
    if (!deadline || attempts.some(row => row.createdAt >= deadline && row.declineCode !== 'create_abandoned'))
      return skipped('outside_retry_window');
  } else if (mode === 'automatic' && attempts.some(row => row.declineCode !== 'create_abandoned')) return skipped('already_attempted');
  const latest = attempts.at(-1);
  if (invoice.amountCents === 0) return { status: 'eligible', invoice, latest, payment: null };
  const home = (await tx.select().from(households).where(eq(households.id, invoice.householdId)))[0]!;
  const method = (await tx.select().from(paymentMethods).where(and(eq(paymentMethods.householdId, home.id),
    eq(paymentMethods.isDefault, true), isNull(paymentMethods.revokedAt))))[0];
  if (!home.stripeCustomerId || !method) return skipped('no_saved_card');
  return { status: 'eligible', invoice, latest, payment: { customerId: home.stripeCustomerId, methodId: method.processorId } };
}
