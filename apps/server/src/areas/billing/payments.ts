// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { allocateInvoiceNumber, forGym, households, invoices, invoiceLineItems, payments, refunds,
  paymentAttempts, chargeTypes, chargeTypeTaxRates, taxRates, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { notFound, type MutationContext } from '../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import type { Payments } from '../../infra/payments/index.js';
import type { Jobs } from '../../infra/jobs/index.js';
import { gymSettingsAccessor } from '../settings/settings.js';
import { catalogAudit } from './catalog.js';
import { calculateOneOffInvoice } from './invoicing/index.js';
import { createInvoiceTransitions } from './transitions/index.js';
import { releaseActionNeeded, releaseCheckout, type ChargeRunner } from './runner/index.js';
import { createReconciliation } from './runner/reconciliation.js';
import { chargeSkipped, paymentConflict, paymentUnavailable } from './payments.errors.js';
import { createPaymentMutations } from './payments.mutations.js';

export interface PaymentOptions {
  scope?: typeof forGym;
  clock?: Clock;
  settings?: GymSettingsAccessor;
  transitions?: InvoiceTransitions;
  paymentsFor?: (gymId: string) => Promise<Payments | null>;
  jobs?: Jobs;
  runner?: Pick<ChargeRunner, 'charge'>;
  /** TODO(CCR): promote detach to Payments, implement in Stripe and its contract fake. */
  detachCard?: (gymId: string, processorId: string) => Promise<void>;
}
export const presentInvoice = (r: typeof invoices.$inferSelect) => c.invoiceSchema.parse({
  id: r.id, createdAt: r.createdAt.toISOString(), householdId: r.householdId, kind: r.kind, status: r.status,
  number: r.number, dueOn: r.dueOn, periodStartsOn: r.periodStartsOn, periodEndsOn: r.periodEndsOn,
  amountCents: r.amountCents, currency: r.currency, paidAt: r.paidAt?.toISOString() ?? null,
  needsReview: r.needsReview, disputeId: r.disputeId, disputeStatus: r.disputeStatus,
});
export const presentPayment = (r: typeof payments.$inferSelect) => c.paymentSchema.parse({
  id: r.id, createdAt: r.createdAt.toISOString(), invoiceId: r.invoiceId, method: r.method,
  amountCents: r.amountCents, currency: r.currency, reference: r.reference, paidAt: r.paidAt.toISOString(),
});
export const presentRefund = (r: typeof refunds.$inferSelect) => c.refundSchema.parse({
  id: r.id, createdAt: r.createdAt.toISOString(), paymentId: r.paymentId, amountCents: r.amountCents,
  currency: r.currency, status: r.status, reason: r.reason, resolvedAt: r.resolvedAt?.toISOString() ?? null,
});
export async function loadInvoice(tx: Transaction, id: string, lock = false) {
  const query = tx.select().from(invoices).where(eq(invoices.id, c.idSchema.parse(id)));
  return (await (lock ? query.for('update') : query))[0] ?? notFound();
}
export async function loadHousehold(tx: Transaction, id: string, lock = false) {
  const query = tx.select().from(households).where(eq(households.id, c.idSchema.parse(id)));
  return (await (lock ? query.for('update') : query))[0] ?? notFound();
}
/** Recheck under the invoice lock after releasing provider work. Holds permit cash/check. */
export async function requireCollectible(tx: Transaction, invoice: typeof invoices.$inferSelect) {
  if (['paid', 'partially_refunded', 'refunded'].includes(invoice.status)) paymentConflict('already_paid', 'Invoice is already paid');
  if (!['open', 'past_due'].includes(invoice.status)) paymentConflict('not_payable', 'Invoice is not available for collection');
  if (invoice.disputeId && !['won', 'lost', 'closed'].includes(invoice.disputeStatus ?? '')) paymentConflict('open_dispute', 'Invoice has an open dispute');
  if (invoice.checkoutSessionId) paymentConflict('checkout_changed', 'Resolve the existing Checkout before recording another payment');
  if ((await tx.select({ id: paymentAttempts.id }).from(paymentAttempts).where(and(eq(paymentAttempts.invoiceId, invoice.id),
    inArray(paymentAttempts.status, ['pending', 'requires_action']))).limit(1)).length) chargeSkipped('pending_attempt');
}
const presentAttempt = (r: typeof paymentAttempts.$inferSelect) => c.paymentAttemptSchema.parse({
  id: r.id, createdAt: r.createdAt.toISOString(), invoiceId: r.invoiceId, attemptNumber: r.attemptNumber,
  amountCents: r.amountCents, currency: r.currency, status: r.status, declineCode: r.declineCode,
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
});

export function createPaymentService(options: PaymentOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? gymSettingsAccessor;
  const transitions = options.transitions ?? createInvoiceTransitions({ scope, clock });
  const dependencies = { ...options, scope, clock, settings, transitions };
  const mutations = createPaymentMutations(dependencies);
  const providerFor = async (gymId: string) => await options.paymentsFor?.(gymId)
    ?? paymentUnavailable('payments_unavailable', 'Stripe is unavailable; existing card or Checkout payments must be resolved before recording cash');
  const reconciliation = createReconciliation({ scope, clock, settings, transitions, payments: providerFor });
  async function getInvoice(gymId: string, id: string) {
    return scope(gymId, async tx => {
      const row = await loadInvoice(tx, id);
      const lines = await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id))
        .orderBy(asc(invoiceLineItems.kind), asc(invoiceLineItems.id));
      const paid = await tx.select().from(payments).where(eq(payments.invoiceId, id)).orderBy(asc(payments.id));
      const returned = await tx.select({ refund: refunds }).from(refunds).innerJoin(payments, eq(payments.id, refunds.paymentId))
        .where(eq(payments.invoiceId, id)).orderBy(asc(refunds.id));
      return c.invoiceDetailSchema.parse({ invoice: presentInvoice(row),
        lineItems: lines.map(({ gymId: _gym, createdAt, ...line }) => ({ ...line, createdAt: createdAt.toISOString() })),
        payments: paid.map(presentPayment), refunds: returned.map(r => presentRefund(r.refund)) });
    });
  }
  return {
    ...mutations, getInvoice,
    async charge(context: MutationContext, invoiceId: string) {
      const row = await scope(context.gymId, tx => loadInvoice(tx, invoiceId));
      if (row.amountCents === 0) paymentConflict('zero_invoice', 'A zero-value invoice cannot be charged from this action');
      if (row.disputeId && !['won', 'lost', 'closed'].includes(row.disputeStatus ?? '')) paymentConflict('open_dispute', 'Invoice has an open dispute');
      if (!options.runner) paymentUnavailable('runner_unavailable', 'Card collection is not configured');
      let result;
      try { result = await options.runner.charge(context.gymId, invoiceId, { mode: 'staff', context }); }
      catch (error) {
        if (error instanceof AppError) throw error;
        paymentUnavailable('payments_unavailable', 'Stripe is unavailable; check back shortly while the charge is reconciled');
      }
      switch (result.status) {
        case 'skipped': return chargeSkipped(result.reason);
        case 'settled_zero': return paymentConflict('zero_invoice', 'A zero-value invoice has no card attempt');
        case 'succeeded': case 'failed': case 'action_required': case 'pending': case 'unknown':
          return scope(context.gymId, async tx => presentAttempt((await tx.select().from(paymentAttempts)
            .where(eq(paymentAttempts.invoiceId, invoiceId)).orderBy(desc(paymentAttempts.attemptNumber)).limit(1))[0] ?? notFound()));
        default: { const exhaustive: never = result; return exhaustive; }
      }
    },
    async releaseHold(context: MutationContext, invoiceId: string) {
      return scope(context.gymId, async tx => {
        const row = await loadInvoice(tx, invoiceId, true);
        if (!['open', 'past_due'].includes(row.status)) paymentConflict('not_payable', 'Invoice is not available for review');
        if (!row.needsReview) return presentInvoice(row);
        const changed = (await tx.update(invoices).set({ needsReview: false }).where(eq(invoices.id, invoiceId)).returning())[0]!;
        await catalogAudit(tx, context, clock, 'billing.invoice.review_released', 'invoice', invoiceId,
          { needsReview: true }, { needsReview: false });
        return presentInvoice(changed);
      });
    },
    async listInvoices(gymId: string, input: unknown) {
      const q = c.invoiceListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        if (q.householdId) await loadHousehold(tx, q.householdId);
        const where = and(q.householdId ? eq(invoices.householdId, q.householdId) : undefined,
          q.kind ? eq(invoices.kind, q.kind) : undefined, q.status ? eq(invoices.status, q.status) : undefined,
          q.dueFrom ? gte(invoices.dueOn, q.dueFrom) : undefined, q.dueThrough ? lte(invoices.dueOn, q.dueThrough) : undefined);
        const total = await tx.$count(invoices, where);
        const rows = await tx.select().from(invoices).where(where).orderBy(desc(invoices.createdAt), desc(invoices.id)).limit(q.limit).offset(q.offset);
        return { data: rows.map(presentInvoice), pagination: { limit: q.limit, offset: q.offset, total } };
      });
    },
    async createOneOff(context: MutationContext, input: c.CreateOneOffInvoiceRequest) {
      const request = c.createOneOffInvoiceRequestSchema.parse(input), gym = await settings.get(context.gymId);
      return scope(context.gymId, async tx => {
        await loadHousehold(tx, request.householdId);
        let description: string, amountCents: number, currency: c.Currency, taxIds: string[], chargeTypeId: string | undefined;
        if (request.source === 'charge_type') {
          const row = (await tx.select().from(chargeTypes).where(eq(chargeTypes.id, request.chargeTypeId)).for('share'))[0] ?? notFound();
          if (!row.active) paymentConflict('charge_type_inactive', 'Charge type is inactive');
          description = row.name; amountCents = row.amountCents; currency = c.currencySchema.parse(row.currency); chargeTypeId = row.id;
          taxIds = (await tx.select().from(chargeTypeTaxRates).where(eq(chargeTypeTaxRates.chargeTypeId, row.id))).map(t => t.taxRateId);
        } else { ({ description, amountCents, currency } = request); taxIds = request.taxRateIds; }
        if (currency !== gym.currency) paymentConflict('currency_mismatch', 'Currency does not match the gym');
        const taxes = taxIds.length ? await tx.select().from(taxRates).where(inArray(taxRates.id, taxIds)).orderBy(asc(taxRates.id)).for('share') : [];
        if (taxes.length !== taxIds.length) notFound();
        if (taxes.some(t => !t.active)) paymentConflict('tax_rate_inactive', 'Tax rate is inactive');
        const calculated = calculateOneOffInvoice({ householdId: request.householdId, currency, dueOn: request.dueOn,
          charges: [{ kind: 'charge', description, amountCents, currency, taxRates: taxes, ...(chargeTypeId ? { chargeTypeId } : {}) }] });
        const { lineItems, ...invoice } = calculated;
        // Issuing a new invoice is its initial state; all subsequent state writes belong to transitions.
        const row = (await tx.insert(invoices).values({ ...invoice, id: uuidv7(), gymId: context.gymId,
          number: await allocateInvoiceNumber(tx, context.gymId), status: 'open', createdAt: clock.now() }).returning())[0]!;
        await tx.insert(invoiceLineItems).values(lineItems.map(line => ({ ...line, id: uuidv7(), gymId: context.gymId,
          householdId: row.householdId, invoiceId: row.id, createdAt: clock.now() })));
        await catalogAudit(tx, context, clock, 'billing.invoice.issued', 'invoice', row.id, undefined, presentInvoice(row));
        return presentInvoice(row);
      });
    },
    async manualPayment(context: MutationContext, invoiceId: string, input: c.RecordManualPaymentRequest) {
      const request = c.recordManualPaymentRequestSchema.parse(input), paymentId = uuidv7();
      const loaded = await scope(context.gymId, async tx => {
        const invoice = await loadInvoice(tx, invoiceId, true);
        if (['paid', 'partially_refunded', 'refunded'].includes(invoice.status)) paymentConflict('already_paid', 'Invoice is already paid');
        if (!['open', 'past_due'].includes(invoice.status)) paymentConflict('not_payable', 'Invoice is not available for collection');
        if (invoice.disputeId && !['won', 'lost', 'closed'].includes(invoice.disputeStatus ?? '')) paymentConflict('open_dispute', 'Invoice has an open dispute');
        if (request.amountCents !== invoice.amountCents || request.currency !== invoice.currency)
          paymentConflict('payment_mismatch', 'Payment amount or currency does not match');
        const attempts = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoiceId)).orderBy(desc(paymentAttempts.attemptNumber));
        if (attempts.some(a => a.status === 'pending')) chargeSkipped('pending_attempt');
        return { invoice, action: attempts.find(a => a.status === 'requires_action') };
      });
      if (loaded.action || loaded.invoice.checkoutSessionId) {
        try {
          const provider = await providerFor(context.gymId);
          if (loaded.action) {
            if (!loaded.action.paymentIntentId) paymentUnavailable('payments_unavailable', 'The action-needed payment must be reconciled first');
            if (await releaseActionNeeded(context.gymId, loaded.action.paymentIntentId, provider, reconciliation, context) === 'paid')
              paymentConflict('already_paid', 'Invoice is already paid');
          }
          if (loaded.invoice.checkoutSessionId) {
            const released = await releaseCheckout(context.gymId, invoiceId, loaded.invoice.checkoutSessionId, provider, reconciliation, scope, context);
            if (released === 'paid') paymentConflict('already_paid', 'Invoice is already paid');
            if (released === 'changed') chargeSkipped('checkout_changed');
          }
        } catch (error) {
          if (error instanceof AppError) throw error;
          paymentUnavailable('payments_unavailable', 'Stripe is unavailable; resolve the card or Checkout payment before recording cash');
        }
      }
      // The transition takes the same invoice lock and enforces the exact amount and terminal-state guard.
      await scope(context.gymId, async tx => { await requireCollectible(tx, await loadInvoice(tx, invoiceId, true)); });
      const { reference, ...money } = request;
      await transitions.manualPayment(context, { ...money, invoiceId, paymentId, ...(reference ? { reference } : {}) });
      return scope(context.gymId, async tx => {
        const row = await loadInvoice(tx, invoiceId, true);
        const payment = (await tx.select().from(payments).where(eq(payments.id, paymentId)))[0] ?? notFound();
        if (row.needsReview) {
          await tx.update(invoices).set({ needsReview: false }).where(eq(invoices.id, invoiceId));
          await catalogAudit(tx, context, clock, 'billing.invoice.review_cleared_by_payment', 'invoice', invoiceId,
            { needsReview: true }, { needsReview: false, paymentId });
        }
        return presentPayment(payment);
      });
    },
    async listPayments(gymId: string, input: unknown) {
      const q = c.billingPaymentListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        if (q.invoiceId) await loadInvoice(tx, q.invoiceId);
        const where = and(q.invoiceId ? eq(payments.invoiceId, q.invoiceId) : undefined, q.method ? eq(payments.method, q.method) : undefined);
        const total = await tx.$count(payments, where);
        const rows = await tx.select().from(payments).where(where).orderBy(desc(payments.paidAt), desc(payments.id)).limit(q.limit).offset(q.offset);
        return { data: rows.map(presentPayment), pagination: { limit: q.limit, offset: q.offset, total } };
      });
    },
    async listRefunds(gymId: string, input: unknown) {
      const q = c.billingRefundListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        if (q.paymentId && !(await tx.select({ id: payments.id }).from(payments).where(eq(payments.id, q.paymentId)))[0]) notFound();
        const where = and(q.paymentId ? eq(refunds.paymentId, q.paymentId) : undefined, q.status ? eq(refunds.status, q.status) : undefined);
        const total = await tx.$count(refunds, where);
        const rows = await tx.select().from(refunds).where(where).orderBy(desc(refunds.createdAt), desc(refunds.id)).limit(q.limit).offset(q.offset);
        return { data: rows.map(presentRefund), pagination: { limit: q.limit, offset: q.offset, total } };
      });
    },
  };
}
export type PaymentService = ReturnType<typeof createPaymentService>;
