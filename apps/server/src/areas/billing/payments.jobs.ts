// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { forGym, invoices, paymentMethods, payments, refunds } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { notFound } from '../../core/interfaces/common.js';
import type { JobRegistration } from '../../core/registry.js';
import type { TransitionNotifications } from './transitions/notifications.js';
import { snapshot } from './transitions/store.js';
import type { DetachOptions, Payments } from '../../infra/payments/index.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import { detachJob, receiptJob, refundRetryWindowMs, settleLapsed } from './payments.mutations.js';

export const lapsedRefundJob = 'billing.payments.settle_lapsed';
/** The ordinary per-gym job lane serializes this sweep with duplicate-refund workers. No transaction holds a provider call. */
export function createLapsedRefundJobs(options: { scope?: typeof forGym; clock: Clock; transitions: InvoiceTransitions;
  payments(gymId: string): Promise<Payments> }): readonly JobRegistration[] {
  const scope = options.scope ?? forGym;
  return [{ id: lapsedRefundJob, cron: '43 * * * *', async handler(_payload, context) {
    const rows = await scope(context.gymId, tx => tx.select({ reservation: refunds, payment: payments }).from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId)).where(and(eq(refunds.status, 'pending'), isNotNull(refunds.taggedAt),
        isNull(refunds.processorId), lte(refunds.createdAt, new Date(options.clock.now().getTime() - refundRetryWindowMs)),
        eq(payments.method, 'card'))).orderBy(asc(refunds.createdAt), asc(refunds.id)).limit(100));
    // Resolve the provider only when there is work; a gym without Stripe has nothing to settle.
    if (!rows.length) return;
    const provider = await options.payments(context.gymId);
    // A row that can't settle stays pending for staff. The oldest come first, so it must not hold back the rows behind it,
    // and the run still ends failed.
    const failures: unknown[] = [];
    for (const { reservation, payment } of rows) {
      await settleLapsed(options, { gymId: context.gymId, actor: { kind: 'system' } }, provider, payment, [reservation])
        .catch((error: unknown) => { failures.push(error); });
    }
    if (failures.length) throw failures[0];
  } }];
}

interface DeliveryOptions {
  scope?: typeof forGym;
  notifications: TransitionNotifications;
  detachCard(gymId: string, processorId: string, options?: DetachOptions): Promise<void>;
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
      await options.notifications.receipt(notice);
    } },
    { id: detachJob, async handler(payload, ctx) {
      const { paymentMethodId, redactBillingDetails } = payload as { paymentMethodId: string; redactBillingDetails?: boolean }; idSchema.parse(paymentMethodId);
      const options = read(), scope = options.scope ?? forGym;
      const row = await scope(ctx.gymId, async tx => (await tx.select().from(paymentMethods).where(and(
        eq(paymentMethods.id, paymentMethodId), eq(paymentMethods.isDefault, false))))[0] ?? notFound());
      // Only an erasure asks for the card's billing details to be cleared; a staff removal queues the job without the flag.
      if (row.revokedAt) await (redactBillingDetails === true ? options.detachCard(ctx.gymId, row.processorId, { redactBillingDetails: true })
        : options.detachCard(ctx.gymId, row.processorId));
    } },
  ];
}
export const jobs = createPaymentJobs();
