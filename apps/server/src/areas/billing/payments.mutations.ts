// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq } from 'drizzle-orm';
import { forGym, paymentMethods, payments, refunds, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { onMinorUnitStep } from '@plaingym/shared/money';
import { notFound, type MutationContext } from '../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { holdGymSettings } from '../settings/settings.js';
import { catalogAudit } from './catalog.js';
import { processorRefundId } from './disputes-refunds.js';
import { loadHousehold, loadInvoice, presentRefund, type PaymentOptions } from './payments.js';
import { paymentConflict, paymentUnavailable } from './payments.errors.js';
import { markRefundSending, markRefundSent, pastRefundWindow, sameRefund, settleLapsed } from './transitions/lapsed-refunds.js';

type Options = PaymentOptions & { scope: typeof forGym; clock: Clock; transitions: InvoiceTransitions; settings: GymSettingsAccessor };
export const receiptJob = 'billing.payments.receipt';
export const detachJob = 'billing.payments.detach';
/** A row a staff retry may send again under `refund:<row ID>`, the key it was first sent with: a reservation, or a refund
 * this app sent. A refund made outside the app is stored under the ID derived from its processor ID, and a duplicate
 * payment's reservation is sent under its own key; retrying either would make a second, real refund. */
const retryable = (gymId: string, row: typeof refunds.$inferSelect) => row.reason !== 'duplicate_payment'
  && (row.processorId === null || row.id !== processorRefundId(gymId, row.processorId));
const masked = (r: typeof paymentMethods.$inferSelect) => c.maskedPaymentMethodSchema.parse({
  id: r.id, createdAt: r.createdAt.toISOString(), householdId: r.householdId, brand: r.brand, last4: r.last4,
  expiryMonth: r.expiryMonth, expiryYear: r.expiryYear, isDefault: r.isDefault, revokedAt: r.revokedAt?.toISOString() ?? null,
});

export function createPaymentMutations({ scope, clock, settings, transitions, jobs, paymentsFor, detachCard }: Options) {
  return {
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
      const card = await scope(context.gymId, async tx => {
        await loadHousehold(tx, householdId, true);
        return (await tx.select().from(paymentMethods).where(and(eq(paymentMethods.id, c.idSchema.parse(id)), eq(paymentMethods.householdId, householdId))))[0] ?? notFound();
      });
      if (!detachCard) paymentUnavailable('detach_unavailable', 'Card removal is not configured');
      const row = await scope(context.gymId, async tx => {
        await loadHousehold(tx, householdId, true);
        const changed = (await tx.update(paymentMethods).set({ isDefault: false, revokedAt: card.revokedAt ?? clock.now() })
          .where(eq(paymentMethods.id, id)).returning())[0] ?? notFound();
        if (!card.revokedAt) await catalogAudit(tx, context, clock, 'billing.card.revoked', 'payment_method', id, undefined, { householdId });
        return changed;
      });
      // Queue before the immediate attempt: a Stripe outage leaves a revoked local card and durable retry.
      if (jobs) await jobs.enqueue(detachJob, { paymentMethodId: id }, {
        gymId: context.gymId, timezone: (await settings.get(context.gymId)).timezone, idempotencyKey: `detach:${id}`, maxAttempts: 12,
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
        if (payment.method === 'card' && !onMinorUnitStep(request.amountCents, request.currency))
          paymentConflict('refund_off_step', 'A card refund must be a whole step of its currency');
        // Marked by a switch to live: the payment is in the test account, which the gym's live key can't refund.
        if (payment.method === 'card' && payment.reference === c.stripeTestPaymentReference)
          paymentConflict('test_payment', 'A Stripe test-mode payment can’t be refunded with the live key');
        const open = await tx.select().from(refunds).where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'pending'))).orderBy(asc(refunds.id));
        const lapsed = open.filter(row => row.taggedAt !== null && row.processorId === null && pastRefundWindow(row, clock));
        // Any other pending refund, such as one made in Stripe's dashboard, must be resolved first.
        const pending = open.find(row => retryable(context.gymId, row));
        if (!lapsed.length && open.length && (!pending || pending.amountCents !== request.amountCents
          || pending.reason !== null && pending.reason !== request.reason)) paymentConflict('pending_refund', 'Resolve the pending refund first');
        return { payment, invoice, pending, lapsed };
      });
      const { payment, invoice, pending, lapsed } = loaded;
      const provider = payment.method === 'card' ? await paymentsFor?.(context.gymId) : null;
      if (payment.method === 'card' && (!provider || !payment.paymentIntentId)) paymentUnavailable('payments_unavailable', 'Payments are not configured');
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
        await holdGymSettings(tx, context.gymId);
        await loadInvoice(tx, invoice.id, true);
        const current = (await tx.select().from(refunds).where(eq(refunds.id, refundId)))[0] ?? notFound();
        const [paid] = await tx.select({ reference: payments.reference }).from(payments).where(eq(payments.id, paymentId));
        if (payment.method === 'card' && paid?.reference === c.stripeTestPaymentReference)
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
