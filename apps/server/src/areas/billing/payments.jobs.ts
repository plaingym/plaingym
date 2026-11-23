// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { forGym, households, invoices, paymentMethods, payments, refunds, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { notFound } from '../../core/interfaces/common.js';
import type { JobRegistration } from '../../core/registry.js';
import type { TransitionNotifications } from './transitions/notifications.js';
import { snapshot } from './transitions/store.js';
import { isProviderOutage, type DetachOptions, type Payments } from '../../infra/payments/index.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import { detachJob, receiptJob, recordCardDetached } from './payments.mutations.js';
import { refundRetryWindowMs, refundSettleSkewMs, settleLapsed } from './transitions/lapsed-refunds.js';

export const lapsedRefundJob = 'billing.payments.settle_lapsed';
/** The ordinary per-gym job lane serializes this sweep with duplicate-refund workers. A staff retry still sending a row
 * is waited for (`settleLapsed`). No transaction holds a provider call. */
export function createLapsedRefundJobs(options: { scope?: typeof forGym; clock: Clock; transitions: InvoiceTransitions;
  payments(gymId: string): Promise<Payments> }): readonly JobRegistration[] {
  const scope = options.scope ?? forGym;
  return [{ id: lapsedRefundJob, cron: '43 * * * *', async handler(_payload, context) {
    const rows = await scope(context.gymId, tx => tx.select({ reservation: refunds, payment: payments }).from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId)).where(and(eq(refunds.status, 'pending'), isNotNull(refunds.taggedAt),
        isNull(refunds.processorId), lte(refunds.createdAt, new Date(options.clock.now().getTime() - refundRetryWindowMs - refundSettleSkewMs)),
        inArray(payments.method, ['card', 'bank_debit']))).orderBy(asc(refunds.createdAt), asc(refunds.id)).limit(100));
    // Resolve the provider only when a payment needs Stripe; a gym without Stripe has nothing to settle, and a payment
    // marked as test is released without it.
    let provider: Promise<Payments> | undefined;
    const providerFor = () => provider ??= options.payments(context.gymId);
    // Each payment's refunds are listed once. A row that can't settle stays pending for staff. The oldest come first, so
    // it must not hold back the rows behind it, and the run still ends failed.
    const byPayment = new Map<string, { payment: typeof rows[number]['payment']; reservations: (typeof rows[number]['reservation'])[] }>();
    for (const { reservation, payment } of rows) {
      const group = byPayment.get(payment.id) ?? { payment, reservations: [] };
      group.reservations.push(reservation); byPayment.set(payment.id, group);
    }
    const failures: unknown[] = [];
    for (const { payment, reservations } of byPayment.values()) {
      await settleLapsed({ scope, clock: options.clock, transitions: options.transitions }, { gymId: context.gymId, actor: { kind: 'system' } },
        providerFor, payment, reservations).catch((error: unknown) => { failures.push(error); });
    }
    if (failures.length) throw failures[0];
  } }];
}

interface DeliveryOptions {
  scope?: typeof forGym;
  notifications: TransitionNotifications;
  detachCard(gymId: string, processorId: string, options?: DetachOptions): Promise<void>;
  /** Adopts the household's stored Stripe customer for this gym (tags an untagged one); rejects one tagged for another gym or deleted. */
  adoptCustomer?(gymId: string, customerId: string): Promise<unknown>;
}
/** An outage (rate limit, server error, lost connection, rejected key), a permission the key lacks or a programming
 * error is not an ownership refusal: the detach stays retryable, and adopting the customer would not help. */
function transientFailure(error: unknown): boolean {
  return [error, (error as { cause?: unknown } | null)?.cause].some(value => {
    const { statusCode: status, type } = (value ?? {}) as { statusCode?: unknown; type?: unknown };
    return isProviderOutage(value) || status === 401 || status === 403 || type === 'StripePermissionError'
      || value instanceof TypeError;
  });
}
let configured: DeliveryOptions | undefined;
export function configurePaymentDelivery(options: DeliveryOptions) { configured = options; }
export function createPaymentJobs(options?: DeliveryOptions): readonly JobRegistration[] {
  const read = () => { const value = options ?? configured; if (!value) throw new Error('Payment delivery is not configured'); return value; };
  return [
    { id: receiptJob, async handler(payload, ctx) {
      const { invoiceId } = payload as { invoiceId: string }; idSchema.parse(invoiceId);
      const options = read(), scope = options.scope ?? forGym;
      const notice = await scope(ctx.gymId, async tx => {
        const invoice = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)))[0] ?? notFound();
        if (!invoice.paidAt) throw new Error('Invoice has no receipt');
        const payment = (await tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)))[0];
        // Each requested resend is its own job, so it sends again, and a retry of this job does not.
        return { gymId: ctx.gymId, generation: ctx.jobId, invoice: snapshot(invoice), ...(payment ? { payment } : {}) };
      });
      await options.notifications.receipt(notice, { emailOnly: true });
    } },
    { id: detachJob, async handler(payload, ctx) {
      const { paymentMethodId, redactBillingDetails, customerId } = payload as { paymentMethodId: string; redactBillingDetails?: boolean; customerId?: unknown };
      idSchema.parse(paymentMethodId);
      const options = read(), scope = options.scope ?? forGym;
      const { row, stripeCustomerId } = await scope(ctx.gymId, async tx => {
        const found = (await tx.select({ row: paymentMethods, stripeCustomerId: households.stripeCustomerId })
          .from(paymentMethods).innerJoin(households, eq(households.id, paymentMethods.householdId)).where(and(
            eq(paymentMethods.id, paymentMethodId), eq(paymentMethods.isDefault, false))))[0] ?? notFound();
        return { row: found.row, stripeCustomerId: found.stripeCustomerId };
      });
      // Only an erasure asks for the card's billing details to be cleared; a staff removal queues the job without the flag.
      if (!row.revokedAt) return;
      const detach = () => redactBillingDetails === true ? options.detachCard(ctx.gymId, row.processorId, { redactBillingDetails: true })
        : options.detachCard(ctx.gymId, row.processorId);
      // An erasure clears the household's customer link in the transaction that queues this job, so its payload carries
      // the customer ID it read from that household's row. The stored link always wins; the payload's only fills a null one.
      const erasedCustomerId = typeof customerId === 'string' && /^cus_[A-Za-z0-9]+$/.test(customerId) ? customerId : null;
      const adoptId = stripeCustomerId ?? erasedCustomerId;
      try { await detach(); }
      catch (first) {
        // A people CSV can save the household's method and mandate on its customer without tagging it. Adopt only the
        // customer the method's own household links (or linked until its erasure), then detach once more. Another gym's
        // or a deleted customer is refused by adoption, and the first refusal stands; a method on any other customer is
        // refused by the second detach. An outage or a key's missing permission is left to the job's retry.
        if (!options.adoptCustomer || !adoptId || transientFailure(first)) throw first;
        try { await options.adoptCustomer(ctx.gymId, adoptId); }
        catch { throw first; }
        await detach();
        await scope(ctx.gymId, tx => writeAudit(tx, { gymId: ctx.gymId, actorKind: 'system', action: 'billing.customer.adopted',
          targetType: 'household', targetId: row.householdId,
          after: { customerId: adoptId, paymentMethodId: row.id, source: 'detach' }, occurredAt: ctx.clock.now() }));
      }
      await recordCardDetached(scope, { gymId: ctx.gymId, actor: { kind: 'system' } }, ctx.clock, row);
    } },
  ];
}
export const jobs = createPaymentJobs();
