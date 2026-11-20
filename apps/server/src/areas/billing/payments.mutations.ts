// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { forGym, paymentMethods, payments, refunds, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { onMinorUnitStep } from '@plaingym/shared/money';
import { localDate } from '@plaingym/shared/time';
import { notFound, type MutationContext } from '../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { latestTestSwitchId, stripeWriteCurrent } from './stripe-writes.js';
import { catalogAudit } from './catalog.js';
import { processorRefundId } from './disputes-refunds.js';
import { loadHousehold, loadInvoice, presentRefund, type PaymentOptions } from './payments.js';
import { paymentConflict, paymentUnavailable } from './payments.errors.js';
import { markRefundSending, markRefundSent, pastRefundWindow, sameRefund, settleLapsed } from './transitions/lapsed-refunds.js';
import { duplicateReservation } from './transitions/store.js';
import { withJobTransaction } from '../../infra/jobs/index.js';
import { CardImportRefused } from '../../infra/payments/index.js';
import { customerCardImportJob } from './customer-card-import.js';

type Options = PaymentOptions & { scope: typeof forGym; clock: Clock; transitions: InvoiceTransitions; settings: GymSettingsAccessor };
export const receiptJob = 'billing.payments.receipt';
export const detachJob = 'billing.payments.detach';
/** A row a staff retry may send again under `refund:<row ID>`, the key it was first sent with: a reservation, or a refund
 * this app sent. A refund made outside the app is stored under the ID derived from its processor ID, and a duplicate
 * payment's reservation is sent under its own key; retrying either would make a second, real refund. */
const retryable = (gymId: string, row: typeof refunds.$inferSelect) =>
  row.processorId === null || row.id !== processorRefundId(gymId, row.processorId);
const masked = (r: typeof paymentMethods.$inferSelect) => c.maskedPaymentMethodSchema.parse({
  id: r.id, createdAt: r.createdAt.toISOString(), householdId: r.householdId,
  type: r.type, bankName: r.bankName, brand: r.brand, last4: r.last4,
  expiryMonth: r.expiryMonth, expiryYear: r.expiryYear, isDefault: r.isDefault, revokedAt: r.revokedAt?.toISOString() ?? null,
});

/** Caller holds the household lock. Preserve a chosen default; prefer an unexpired replacement in the gym's month. */
export async function promoteDefaultCard(tx: Transaction, context: MutationContext, clock: Clock, householdId: string,
  timezone: string, requestId?: string) {
  const cards = await tx.select({ id: paymentMethods.id, isDefault: paymentMethods.isDefault,
    processorCreatedAt: paymentMethods.processorCreatedAt, createdAt: paymentMethods.createdAt,
    expiryMonth: paymentMethods.expiryMonth, expiryYear: paymentMethods.expiryYear }).from(paymentMethods)
    .where(and(eq(paymentMethods.householdId, householdId), isNull(paymentMethods.revokedAt)));
  if (cards.some(card => card.isDefault)) return;
  // Use the processor's date when known, otherwise the local date; local date and row ID break ties.
  cards.sort((a, b) => (b.processorCreatedAt ?? b.createdAt).getTime() - (a.processorCreatedAt ?? a.createdAt).getTime()
    || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  const month = localDate(clock.now(), timezone).slice(0, 7);
  const replacement = cards.find(card => card.expiryYear === null || card.expiryMonth === null
    || `${card.expiryYear}-${String(card.expiryMonth).padStart(2, '0')}` >= month) ?? cards[0];
  if (replacement) {
    await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, replacement.id));
    await catalogAudit(tx, context, clock, 'billing.card.default_changed', 'payment_method', replacement.id, undefined,
      { householdId, ...(requestId ? { requestId } : {}) });
  }
}

export function createPaymentMutations({ scope, clock, settings, transitions, jobs, paymentsFor, detachCard }: Options) {
  return {
    async importCustomerCards(context: MutationContext, householdId: string) {
      // Check local ownership before configuration or provider access.
      const loaded = await scope(context.gymId, async tx => ({ household: await loadHousehold(tx, householdId),
        switched: await latestTestSwitchId(tx, context.gymId) }));
      if (!loaded.household.stripeCustomerId) paymentConflict('card_import_no_customer', 'Household has no Stripe customer');
      if (!jobs || !paymentsFor) paymentUnavailable('payments_unavailable', 'Card import is not configured');
      const customerId = loaded.household.stripeCustomerId, provider = await paymentsFor(context.gymId);
      if (!provider) paymentUnavailable('payments_unavailable', 'Payments are not configured');
      try { await provider.listCustomerCards(customerId, { householdId, limit: 1 }); }
      catch (error) {
        if (error instanceof CardImportRefused) paymentConflict('card_import_refused', 'Customer is not owned by this gym and household');
        throw error;
      }
      const requestId = uuidv7(), gym = await settings.get(context.gymId);
      await withJobTransaction(scope, context.gymId, async transaction => {
        const { tx } = transaction;
        if (!await stripeWriteCurrent(tx, context.gymId, loaded.switched)) paymentConflict('card_import_changed', 'Stripe configuration changed; request the import again');
        if ((await loadHousehold(tx, householdId, true)).stripeCustomerId !== customerId)
          paymentConflict('card_import_changed', 'Household customer changed; request the import again');
        await catalogAudit(tx, context, clock, 'billing.card.import_requested', 'household', householdId, undefined, { requestId });
        await jobs.enqueue(customerCardImportJob, { householdId, customerId, requestId, switched: loaded.switched },
          { gymId: context.gymId, timezone: gym.timezone, idempotencyKey: requestId, maxAttempts: 8 }, transaction);
      });
      return { queued: true as const };
    },
    async listPaymentMethods(gymId: string, householdId: string, input: unknown) {
      const q = c.billingPaymentMethodListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        await loadHousehold(tx, householdId);
        const where = eq(paymentMethods.householdId, householdId), total = await tx.$count(paymentMethods, where);
        const rows = await tx.select().from(paymentMethods).where(where).orderBy(desc(paymentMethods.createdAt), desc(paymentMethods.id)).limit(q.limit).offset(q.offset);
        return { data: rows.map(masked), pagination: { limit: q.limit, offset: q.offset, total } };
      });
    },
    async setDefault(context: MutationContext, householdId: string, id: string) {
      return scope(context.gymId, async tx => {
        await loadHousehold(tx, householdId, true);
        const row = (await tx.select().from(paymentMethods).where(and(eq(paymentMethods.id, c.idSchema.parse(id)), eq(paymentMethods.householdId, householdId))))[0] ?? notFound();
        if (row.revokedAt) paymentConflict('card_removed', 'Card has been removed');
        await tx.update(paymentMethods).set({ isDefault: false }).where(and(eq(paymentMethods.householdId, householdId), eq(paymentMethods.isDefault, true)));
        const changed = (await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, id)).returning())[0]!;
        await catalogAudit(tx, context, clock, 'billing.card.default_changed', 'payment_method', id, undefined, { householdId });
        return masked(changed);
      });
    },
    async revokeCard(context: MutationContext, householdId: string, id: string) {
      // Ownership precedes configuration checks; never reveal whether another gym configured Stripe.
      await scope(context.gymId, async tx => {
        await loadHousehold(tx, householdId, true);
        return (await tx.select().from(paymentMethods).where(and(eq(paymentMethods.id, c.idSchema.parse(id)), eq(paymentMethods.householdId, householdId))))[0] ?? notFound();
      });
      if (!detachCard) paymentUnavailable('detach_unavailable', 'Card removal is not configured');
      const { timezone } = await settings.get(context.gymId);
      const row = await scope(context.gymId, async tx => {
        await loadHousehold(tx, householdId, true);
        // Card state may have changed since the ownership check. Decide under the household lock.
        const card = (await tx.select().from(paymentMethods).where(and(eq(paymentMethods.id, id), eq(paymentMethods.householdId, householdId))))[0] ?? notFound();
        const changed = (await tx.update(paymentMethods).set({ isDefault: false, revokedAt: card.revokedAt ?? clock.now() })
          .where(eq(paymentMethods.id, id)).returning())[0] ?? notFound();
        if (!card.revokedAt) await catalogAudit(tx, context, clock, 'billing.card.revoked', 'payment_method', id, undefined, { householdId });
        if (card.isDefault) await promoteDefaultCard(tx, context, clock, householdId, timezone);
        return changed;
      });
      // Queue before the immediate attempt: a Stripe outage leaves a revoked local card and durable retry.
      if (jobs) await jobs.enqueue(detachJob, { paymentMethodId: id }, {
        gymId: context.gymId, timezone, idempotencyKey: `detach:${id}`, maxAttempts: 12,
      });
      await detachCard(context.gymId, row.processorId);
      return masked(row);
    },
    async refund(context: MutationContext, paymentId: string, input: c.CreateRefundRequest) {
      const request = c.createRefundRequestSchema.parse(input);
      const loaded = await scope(context.gymId, async tx => {
        const payment = (await tx.select().from(payments).where(eq(payments.id, c.idSchema.parse(paymentId))))[0] ?? notFound();
        const invoice = await loadInvoice(tx, payment.invoiceId, true);
        if (request.currency !== payment.currency || request.amountCents > payment.amountCents) paymentConflict('refund_mismatch', 'Refund amount or currency does not match');
        // Stripe refuses a card refund off the currency's step (5.50 ISK, 1.255 KWD); a manual refund may take any minor unit.
        const processorPayment = payment.method === 'card' || payment.method === 'bank_debit';
        if (processorPayment && !onMinorUnitStep(request.amountCents, request.currency))
          paymentConflict('refund_off_step', 'A processor refund must be a whole step of its currency');
        // Marked by a switch to live: the payment is in the test account, which the gym's live key can't refund.
        if (processorPayment && payment.reference === c.stripeTestPaymentReference)
          paymentConflict('test_payment', 'A Stripe test-mode payment can’t be refunded with the live key');
        const open = await tx.select().from(refunds).where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'pending'))).orderBy(asc(refunds.id));
        // Duplicate refunds use the worker's key and lane, including settlement. Staff never list or send them.
        for (const row of open) if (await duplicateReservation(tx, row))
          paymentConflict('pending_refund', 'Resolve the pending refund first');
        const lapsed = open.filter(row => row.taggedAt !== null && row.processorId === null && pastRefundWindow(row, clock));
        // Any other pending refund, such as one made in Stripe's dashboard, must be resolved first.
        const pending = open.find(row => retryable(context.gymId, row));
        if (!lapsed.length && open.length && (!pending || pending.amountCents !== request.amountCents
          || pending.reason !== null && pending.reason !== request.reason)) paymentConflict('pending_refund', 'Resolve the pending refund first');
        return { payment, invoice, pending, lapsed, processorPayment, switched: await latestTestSwitchId(tx, context.gymId) };
      });
      const { payment, invoice, pending, lapsed, processorPayment, switched } = loaded;
      const provider = processorPayment ? await paymentsFor?.(context.gymId) : null;
      if (processorPayment && (!provider || !payment.paymentIntentId)) paymentUnavailable('payments_unavailable', 'Payments are not configured');
      if (provider && lapsed.length) {
        const unsettled = await settleLapsed({ scope, clock, transitions }, context, async () => provider, payment, lapsed);
        if (unsettled.length) paymentConflict('refund_in_progress', 'A refund request for this payment is still being sent to Stripe. Try again in a minute');
        // Clearing a stuck reservation moves no money: the row may already be refunded, or the payer may have been paid
        // another way, so staff decide again from the settled payment.
        paymentConflict('refund_reconciled', 'The pending refund was reconciled with Stripe. Check the payment, and refund again only if it is still owed');
      }
      const refundId = pending?.id ?? uuidv7(), base = { invoiceId: invoice.id, paymentId, refundId, amountCents: request.amountCents, currency: request.currency };
      // Only a new card reservation is tagged. Whether its request names the row comes from the stored row, never from
      // this call, so a retry repeats the parameters its idempotency key was first sent with.
      await transitions.refund(context, { ...base, status: 'pending', ...(provider ? { tagged: true } : {}) });
      // A switch from test to live holds the gym row for its whole save. Waiting for it once the reservation has committed
      // means the switch either sees this pending refund (and refuses to run) or committed first and marked the payment
      // as test, which the refund then refuses. Nothing has reached Stripe yet.
      const { released, tag, sendId } = await scope(context.gymId, async tx => {
        const currentMode = await stripeWriteCurrent(tx, context.gymId, provider ? switched : undefined);
        await loadInvoice(tx, invoice.id, true);
        const current = (await tx.select().from(refunds).where(eq(refunds.id, refundId)))[0] ?? notFound();
        const [paid] = await tx.select({ reference: payments.reference }).from(payments).where(eq(payments.id, paymentId));
        if (processorPayment && (!currentMode || paid?.reference === c.stripeTestPaymentReference))
          return { released: current.status === 'pending' && current.processorId === null, tag: {}, sendId: null };
        // A webhook released the reservation after it was read: its amount is no longer held, so nothing may be sent.
        if (c.refundReleased(current)) paymentConflict('refund_released', 'The pending refund was released. Check the payment, and refund again only if it is still owed');
        if (current.reason !== null && current.reason !== request.reason) paymentConflict('pending_refund', 'Resolve the pending refund first');
        // A lost response leaves this reservation pending. Reuse its key inside Stripe's retention window; after that,
        // a tagged reservation is settled above or by the hourly job, and any other waits for known refunds by ID, with no
        // new network refund. The time is read under the invoice lock, and the send is recorded before Stripe is called:
        // the job, which takes the same lock once the window has passed, either sees this send and waits for it to
        // finish, or holds the lock first, and then this request finds the window passed.
        if (provider && pastRefundWindow(current, clock)) paymentConflict('refund_reconciliation', 'The pending refund needs reconciliation');
        if (current.reason === null) {
          await tx.update(refunds).set({ reason: request.reason }).where(eq(refunds.id, refundId));
          await catalogAudit(tx, context, clock, 'billing.refund.requested', 'refund', refundId, undefined,
            { paymentId, amountCents: request.amountCents, currency: request.currency });
        }
        return { released: null, tag: current.taggedAt ? { reservationId: refundId } : {},
          sendId: provider ? await markRefundSending(tx, context, clock, refundId) : null };
      });
      if (released !== null) {
        // The reservation never reached Stripe: it ends failed, with no processor refund, and releases its amount.
        if (released) await transitions.refund(context, { ...base, status: 'failed' });
        paymentConflict('test_payment', 'A Stripe test-mode payment can’t be refunded with the live key');
      }
      if (provider && sendId) {
        try {
          const result = await provider.refund({ chargeId: payment.paymentIntentId!, amount: request.amountCents, idempotencyKey: `refund:${refundId}`, ...tag });
          if (!sameRefund(result, request, payment, context.gymId)) paymentConflict('refund_identity', 'Refund identity does not match');
          await transitions.refund(context, { ...base, processorId: result.id, status: result.status });
        } finally { await markRefundSent(scope, context, clock, refundId, sendId); }
      } else await transitions.refund(context, { ...base, status: 'succeeded' });
      return scope(context.gymId, async tx => presentRefund((await tx.select().from(refunds).where(eq(refunds.id, refundId)))[0] ?? notFound()));
    },
    async resendReceipt(context: MutationContext, invoiceId: string) {
      const row = await scope(context.gymId, async tx => {
        const invoice = await loadInvoice(tx, invoiceId);
        if (!invoice.paidAt) paymentConflict('no_receipt', 'Invoice has no receipt yet');
        return invoice;
      });
      if (!jobs) paymentUnavailable('receipt_unavailable', 'Receipt delivery is not configured');
      const requestId = uuidv7(), gym = await settings.get(context.gymId);
      await scope(context.gymId, tx => catalogAudit(tx, context, clock, 'billing.receipt.requested', 'invoice', row.id, undefined, { requestId }));
      await jobs.enqueue(receiptJob, { invoiceId }, { gymId: context.gymId, timezone: gym.timezone, idempotencyKey: requestId, maxAttempts: 5 });
      return { queued: true as const };
    },
  };
}
