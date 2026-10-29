// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { AppError } from '@plaingym/shared';
import { portalContracts as contracts } from '@plaingym/shared/contracts';
import type { RequestEnvironment } from '../../core/context.js';
import { route } from '../../core/registry.js';
import { rateLimit } from '../../core/rate-limit.js';
import type { Uploads } from '../../infra/storage/index.js';
import { checkoutReceipts } from '../../public/links/receipt.js';
// The `/l/*` cookie: Stripe returns to `/l/return`, which reopens the internal link's page to confirm the result.
import { receiptCookie } from '../../public/links/links.routes.js';
import { portalIdentity } from './auth.permissions.js';
import { ok } from './household.js';
import { createPortalBillingService, type PortalBillingService, type PortalCheckout, type PortalCheckoutStart } from './billing.js';

type Receipts = ReturnType<typeof checkoutReceipts>;
interface PortalBillingRuntime { checkout: PortalCheckout; receipts: Receipts; uploadsFor(gymId: string): Promise<Uploads> }
let configured: PortalBillingRuntime | undefined;
const runtime = () => configured ?? (() => { throw new AppError('unavailable', 'Portal billing is not configured'); })();
/** Runtime passes the signed-link Checkout, the signed-link receipt key and the gym's file storage. */
export function configurePortalBilling(options: { checkout: PortalCheckout; receiptKey: Uint8Array; uploadsFor(gymId: string): Promise<Uploads> }) {
  configured = { checkout: options.checkout, receipts: checkoutReceipts(options.receiptKey), uploadsFor: options.uploadsFor };
}

export function createPortalBillingRoutes(service: PortalBillingService = createPortalBillingService({
  checkout: () => runtime().checkout, uploadsFor: () => runtime().uploadsFor }), receipts: () => Receipts = () => runtime().receipts) {
  const { invoices, invoice, receipt, payInvoice, paymentMethods, updateCard } = contracts;
  function redirect(c: Context<RequestEnvironment>, started: PortalCheckoutStart) {
    const now = c.get('context').clock.now().getTime(), expires = Date.parse(started.expiresAt);
    setCookie(c, receiptCookie, receipts().seal({ token: started.token, gymId: c.get('context').gym.gymId, linkId: started.linkId,
      sessionId: started.session.id, expires, tablet: false }), { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.max(1, Math.floor((expires - now) / 1000)) });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { url: started.session.url, expiresAt: started.expiresAt } }, 200);
  }
  return [
    route({ ...invoices, request: { query: invoices.query }, responses: ok('Household invoices', invoices.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json(await service.list(portalIdentity(c.get('context')), c.req.valid('query')), 200);
    }),
    route({ ...invoice, request: { params: invoice.params }, responses: ok('Household invoice', invoice.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.get(portalIdentity(c.get('context')), c.req.valid('param').invoiceId) }, 200);
    }),
    route({ ...receipt, middleware: rateLimit({ limit: 10 }), request: { params: receipt.params }, responses: ok('Receipt download link', receipt.response) }, async c => {
      const context = c.get('context');
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.receipt(portalIdentity(context), c.req.valid('param').invoiceId, context.gym.timezone) }, 200);
    }),
    route({ ...payInvoice, middleware: rateLimit({ limit: 10 }), request: { params: payInvoice.params }, responses: ok('Checkout redirect', payInvoice.response) }, async c =>
      redirect(c, await service.pay(portalIdentity(c.get('context')), c.req.valid('param').invoiceId))),
    route({ ...paymentMethods, responses: ok('Saved cards', paymentMethods.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.paymentMethods(portalIdentity(c.get('context'))) }, 200);
    }),
    route({ ...updateCard, middleware: rateLimit({ limit: 10 }), responses: ok('Checkout redirect', updateCard.response) }, async c =>
      redirect(c, await service.updateCard(portalIdentity(c.get('context'))))),
  ];
}
export const routes = createPortalBillingRoutes();
