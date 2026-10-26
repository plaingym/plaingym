// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { billingMutation, billingRoute } from './catalog.routes.js';
import { createPaymentService, type PaymentService } from './payments.js';

let configured: PaymentService | undefined;
export function configurePayments(service: PaymentService) { configured = service; }
export function createPaymentRoutes(service?: PaymentService) {
  const fallback = createPaymentService(), read = () => service ?? configured ?? fallback;
  return [
    billingRoute(c.billingContracts.listInvoices, (ctx, _p, q) => read().listInvoices(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getInvoice, async (ctx, p) => ({ data: await read().getInvoice(ctx.gym.gymId, p.invoiceId!) })),
    billingRoute(c.billingContracts.createOneOffInvoice, async (ctx, _p, _q, b) => ({ data: await read().createOneOff(billingMutation(ctx), c.createOneOffInvoiceRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.chargeInvoice, async (ctx, p) => ({ data: await read().charge(billingMutation(ctx), p.invoiceId!) })),
    billingRoute(c.releaseInvoiceHoldContract, async (ctx, p) => ({ data: await read().releaseHold(billingMutation(ctx), p.invoiceId!) })),
    billingRoute(c.billingContracts.recordManualPayment, async (ctx, p, _q, b) => ({ data: await read().manualPayment(billingMutation(ctx), p.invoiceId!, c.recordManualPaymentRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.listPayments, (ctx, _p, q) => read().listPayments(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.listRefunds, (ctx, _p, q) => read().listRefunds(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.createRefund, async (ctx, p, _q, b) => ({ data: await read().refund(billingMutation(ctx), p.paymentId!, c.createRefundRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.listPaymentMethods, (ctx, p, q) => read().listPaymentMethods(ctx.gym.gymId, p.householdId!, q)),
    billingRoute(c.billingContracts.setDefaultPaymentMethod, async (ctx, p) => ({ data: await read().setDefault(billingMutation(ctx), p.householdId!, p.paymentMethodId!) })),
    billingRoute(c.billingContracts.revokePaymentMethod, async (ctx, p) => ({ data: await read().revokeCard(billingMutation(ctx), p.householdId!, p.paymentMethodId!) })),
    billingRoute(c.billingContracts.resendReceipt, async (ctx, p) => ({ data: await read().resendReceipt(billingMutation(ctx), p.invoiceId!) })),
  ];
}
export const routes = createPaymentRoutes();
