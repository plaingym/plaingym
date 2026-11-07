// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq } from 'drizzle-orm';
import { forGym, paymentMethods, payments, refunds, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { onMinorUnitStep } from '@plaingym/shared/money';
import { notFound, type MutationContext } from '../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import type { Payments, Refund } from '../../infra/payments/index.js';
import { holdGymSettings } from '../settings/settings.js';
import { catalogAudit } from './catalog.js';
import { loadHousehold, loadInvoice, presentRefund, type PaymentOptions } from './payments.js';
import { paymentConflict, paymentUnavailable } from './payments.errors.js';

type Options = PaymentOptions & { scope: typeof forGym; clock: Clock; transitions: InvoiceTransitions; settings: GymSettingsAccessor };
export const receiptJob = 'billing.payments.receipt';
export const detachJob = 'billing.payments.detach';
export const refundRetryWindowMs = 23 * 3600_000;
export const pastRefundWindow = (row: { createdAt: Date }, clock: Clock) => clock.now().getTime() - row.createdAt.getTime() >= refundRetryWindowMs;
/** Past the retry window no new request may use this reservation's expired key. Record its named refund or release it. */
export async function settleLapsed(options: Pick<Options, 'clock' | 'transitions'>, context: MutationContext, provider: Payments,
  payment: typeof payments.$inferSelect, rows: readonly (typeof refunds.$inferSelect)[], listed?: readonly Refund[]) {
  const eligible = rows.filter(row => row.gymId === context.gymId && row.paymentId === payment.id && row.status === 'pending'
    && row.taggedAt !== null && row.processorId === null && pastRefundWindow(row, options.clock));
  if (!eligible.length) return;
  if (payment.gymId !== context.gymId || !payment.paymentIntentId) notFound();
  const found = listed ?? await provider.listRefunds(payment.paymentIntentId);
  for (const row of eligible) {
    if (new Set(found.filter(refund => refund.reservationId === row.id).map(refund => refund.id)).size > 1)
      paymentConflict('refund_reconciliation', 'Ambiguous refund reservation; staff resolution required');
    const own = found.find(refund => refund.reservationId === row.id && refund.amount === row.amountCents
      && refund.currency.toUpperCase() === row.currency && refund.metadata.gymId === context.gymId
      && [payment.paymentIntentId, payment.chargeId].includes(refund.chargeId));
    await options.transitions.refund(context, { invoiceId: payment.invoiceId, paymentId: payment.id, refundId: row.id, amountCents: row.amountCents,
      currency: row.currency, ...(own ? { processorId: own.id, status: own.status } : { status: 'failed' as const }) });
  }
}
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
        const pending = open[0];
        if (!lapsed.length && pending && (pending.amountCents !== request.amountCents || pending.reason !== null && pending.reason !== request.reason)) paymentConflict('pending_refund', 'Resolve the pending refund first');
        return { payment, invoice, pending, lapsed };
      });
      const { payment, invoice, pending, lapsed } = loaded;
      const provider = payment.method === 'card' ? await paymentsFor?.(context.gymId) : null;
      if (payment.method === 'card' && (!provider || !payment.paymentIntentId)) paymentUnavailable('payments_unavailable', 'Payments are not configured');
      if (provider && lapsed.length) {
        await settleLapsed({ clock, transitions }, context, provider, payment, lapsed);
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
      const { released, tag, createdAt } = await scope(context.gymId, async tx => {
        await holdGymSettings(tx, context.gymId);
        await loadInvoice(tx, invoice.id, true);
        const current = (await tx.select().from(refunds).where(eq(refunds.id, refundId)))[0] ?? notFound();
        const [paid] = await tx.select({ reference: payments.reference }).from(payments).where(eq(payments.id, paymentId));
        if (payment.method === 'card' && paid?.reference === c.stripeTestPaymentReference)
          return { released: current.status === 'pending' && current.processorId === null, tag: {}, createdAt: current.createdAt };
        // A webhook released the reservation after it was read: its amount is no longer held, so nothing may be sent.
        if (c.refundReleased(current)) paymentConflict('refund_released', 'The pending refund was released. Check the payment, and refund again only if it is still owed');
        if (current.reason !== null && current.reason !== request.reason) paymentConflict('pending_refund', 'Resolve the pending refund first');
        if (current.reason === null) {
          await tx.update(refunds).set({ reason: request.reason }).where(eq(refunds.id, refundId));
          await catalogAudit(tx, context, clock, 'billing.refund.requested', 'refund', refundId, undefined,
            { paymentId, amountCents: request.amountCents, currency: request.currency });
        }
        return { released: null, tag: current.taggedAt ? { reservationId: refundId } : {}, createdAt: current.createdAt };
      });
      if (released !== null) {
        // The reservation never reached Stripe: it ends failed, with no processor refund, and releases its amount.
        if (released) await transitions.refund(context, { ...base, status: 'failed' });
        paymentConflict('test_payment', 'A Stripe test-mode payment can’t be refunded with the live key');
      }
      if (provider) {
        // A lost response leaves this reservation pending. Reuse its key inside Stripe's retention window; after that,
        // a tagged reservation was settled above, and any other waits for known refunds by ID, with no new network refund.
        if (pastRefundWindow({ createdAt }, clock)) paymentConflict('refund_reconciliation', 'The pending refund needs reconciliation');
        const result = await provider.refund({ chargeId: payment.paymentIntentId!, amount: request.amountCents, idempotencyKey: `refund:${refundId}`, ...tag });
        if (result.metadata.gymId !== context.gymId || result.amount !== request.amountCents || result.currency.toUpperCase() !== request.currency
          || ![payment.paymentIntentId, payment.chargeId].includes(result.chargeId)) paymentConflict('refund_identity', 'Refund identity does not match');
        await transitions.refund(context, { ...base, processorId: result.id, status: result.status });
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
