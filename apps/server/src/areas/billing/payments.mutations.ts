// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq } from 'drizzle-orm';
import { forGym, paymentMethods, payments, refunds, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { notFound, type MutationContext } from '../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { catalogAudit } from './catalog.js';
import { loadHousehold, loadInvoice, presentRefund, type PaymentOptions } from './payments.js';
import { paymentConflict, paymentUnavailable } from './payments.errors.js';

type Options = PaymentOptions & { scope: typeof forGym; clock: Clock; transitions: InvoiceTransitions; settings: GymSettingsAccessor };
export const receiptJob = 'billing.payments.receipt';
export const detachJob = 'billing.payments.detach';
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
        const pending = (await tx.select().from(refunds).where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'pending'))).orderBy(asc(refunds.id)))[0];
        if (pending && (pending.amountCents !== request.amountCents || pending.reason !== null && pending.reason !== request.reason)) paymentConflict('pending_refund', 'Resolve the pending refund first');
        return { payment, invoice, pending };
      });
      const { payment, invoice, pending } = loaded;
      const provider = payment.method === 'card' ? await paymentsFor?.(context.gymId) : null;
      if (payment.method === 'card' && (!provider || !payment.paymentIntentId)) paymentUnavailable('payments_unavailable', 'Payments are not configured');
      const refundId = pending?.id ?? uuidv7(), base = { invoiceId: invoice.id, paymentId, refundId, amountCents: request.amountCents, currency: request.currency };
      await transitions.refund(context, { ...base, status: 'pending' });
      if (!pending || pending.reason === null) await scope(context.gymId, async tx => {
        await loadInvoice(tx, invoice.id, true);
        const current = (await tx.select().from(refunds).where(eq(refunds.id, refundId)))[0] ?? notFound();
        if (current.reason !== null && current.reason !== request.reason) paymentConflict('pending_refund', 'Resolve the pending refund first');
        await tx.update(refunds).set({ reason: request.reason }).where(eq(refunds.id, refundId));
        await catalogAudit(tx, context, clock, 'billing.refund.requested', 'refund', refundId, undefined,
          { paymentId, amountCents: request.amountCents, currency: request.currency });
      });
      if (provider) {
        // A lost response leaves this reservation pending. Reuse its key inside Stripe's retention window;
        // after that, reconcile known refunds by ID and refuse a new network refund.
        if (pending && clock.now().getTime() - pending.createdAt.getTime() >= 23 * 3600_000)
          paymentConflict('refund_reconciliation', 'The pending refund needs reconciliation');
        const result = await provider.refund({ chargeId: payment.paymentIntentId!, amount: request.amountCents, idempotencyKey: `refund:${refundId}` });
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
