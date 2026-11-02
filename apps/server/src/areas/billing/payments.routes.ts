// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';
import { AppError, canStaff } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import type { RequestEnvironment } from '../../core/context.js';
import type { RouteRegistration } from '../../core/registry.js';
import { billingMutation, billingRoute } from './catalog.routes.js';
import { createPaymentService, type PaymentService } from './payments.js';

/** `billingRoute`'s body limit: the most the guard below reads. */
const bodyLimit = 64_000;
/** The body as JSON, read from a copy so the route still gets it whole; undefined if it is over the limit or not JSON. */
async function peekJson(request: Request): Promise<unknown> {
  const reader = request.clone().body?.getReader(), chunks: Uint8Array[] = [];
  if (!reader) return undefined;
  let size = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.length;
      if (size > bodyLimit) return undefined;
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => undefined); }
}
/**
 * The one-off route's `payments.custom` rule (the contract's description): staff without it get 403 for any
 * `source: "custom"` body. It runs before the body is validated, so a malformed custom body is refused the same way.
 */
const customAmountGuard: MiddlewareHandler<RequestEnvironment> = async (ctx, next) => {
  const { principal, gym } = ctx.get('context');
  if (principal.kind === 'staff' && principal.gymId === gym?.gymId && !canStaff(principal.roles, 'payments.custom')) {
    const body = await peekJson(ctx.req.raw);
    if (typeof body === 'object' && body !== null && (body as { source?: unknown }).source === 'custom') throw new AppError('forbidden', 'Access denied');
  }
  await next();
};
/**
 * Runs `guard` on the route's own method and path, after the route's permission check (so a disabled module, a missing
 * login or a role without the route's capability is answered as for any route) and before its validation.
 */
function guarded(registration: RouteRegistration, guard: MiddlewareHandler<RequestEnvironment>): RouteRegistration {
  const { method, path, permission } = registration.definition;
  if (path.includes('{')) throw new Error('A guarded route has no path parameters');
  return { ...registration, mount(app, authorize) { app.on(method, path, authorize(permission), guard); registration.mount(app, authorize); } };
}

let configured: PaymentService | undefined;
export function configurePayments(service: PaymentService) { configured = service; }
export function createPaymentRoutes(service?: PaymentService) {
  const fallback = createPaymentService(), read = () => service ?? configured ?? fallback;
  return [
    billingRoute(c.billingContracts.listInvoices, (ctx, _p, q) => read().listInvoices(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getInvoice, async (ctx, p) => ({ data: await read().getInvoice(ctx.gym.gymId, p.invoiceId!) })),
    guarded(billingRoute(c.billingContracts.createOneOffInvoice, async (ctx, _p, _q, b) => {
      const request = c.createOneOffInvoiceRequestSchema.parse(b);
      // The guard has refused this already; the check stays with the handler, which bills the amount.
      if (request.source === 'custom' && !(ctx.principal.kind === 'staff' && canStaff(ctx.principal.roles, 'payments.custom')))
        throw new AppError('forbidden', 'Access denied');
      return { data: await read().createOneOff(billingMutation(ctx), request) };
    }), customAmountGuard),
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
