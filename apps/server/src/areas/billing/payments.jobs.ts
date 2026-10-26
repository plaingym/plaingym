// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, invoices, paymentMethods, payments } from '@plaingym/db';
import { idSchema } from '@plaingym/shared/contracts';
import { notFound } from '../../core/interfaces/common.js';
import type { JobRegistration } from '../../core/registry.js';
import type { TransitionNotifications } from './transitions/notifications.js';
import { snapshot } from './transitions/store.js';
import { detachJob, receiptJob } from './payments.mutations.js';

interface DeliveryOptions {
  scope?: typeof forGym;
  notifications: TransitionNotifications;
  detachCard(gymId: string, processorId: string): Promise<void>;
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
        return { gymId: ctx.gymId, invoice: snapshot(invoice), ...(payment ? { payment } : {}) };
      });
      await options.notifications.receipt(notice);
    } },
    { id: detachJob, async handler(payload, ctx) {
      const { paymentMethodId } = payload as { paymentMethodId: string }; idSchema.parse(paymentMethodId);
      const options = read(), scope = options.scope ?? forGym;
      const row = await scope(ctx.gymId, async tx => (await tx.select().from(paymentMethods).where(and(
        eq(paymentMethods.id, paymentMethodId), eq(paymentMethods.isDefault, false))))[0] ?? notFound());
      if (row.revokedAt) await options.detachCard(ctx.gymId, row.processorId);
    } },
  ];
}
export const jobs = createPaymentJobs();
