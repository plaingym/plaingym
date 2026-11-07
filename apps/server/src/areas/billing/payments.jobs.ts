// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, invoices, paymentMethods, payments } from '@plaingym/db';
import { idSchema } from '@plaingym/shared/contracts';
import { notFound } from '../../core/interfaces/common.js';
import type { JobRegistration } from '../../core/registry.js';
import type { TransitionNotifications } from './transitions/notifications.js';
import { snapshot } from './transitions/store.js';
import type { DetachOptions } from '../../infra/payments/index.js';
import { detachJob, receiptJob } from './payments.mutations.js';

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
