// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { invoices, paymentAttempts, signedLinks, type forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema, voidInvoiceRequestSchema } from '@plaingym/shared/contracts';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import { notFound } from '../../../core/interfaces/common.js';
import { revokeSignedLinkIn } from '../../links/service.js';
import { paymentConflict } from '../payments.errors.js';
import { audit, result, snapshot } from './store.js';

export function createInvoiceVoid(scope: typeof forGym, clock: Clock): InvoiceTransitions['voidInvoice'] {
  return async (context, request) => {
    const invoiceId = idSchema.parse(request.invoiceId), { reason } = voidInvoiceRequestSchema.parse({ reason: request.reason });
    return scope(context.gymId, async tx => {
      // Checkout takes the link before the invoice. Follow that order when revoking its credentials.
      const links = await tx.select({ id: signedLinks.id }).from(signedLinks)
        .where(eq(signedLinks.invoiceId, invoiceId)).orderBy(asc(signedLinks.id)).for('update');
      const invoice = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update'))[0] ?? notFound();
      if (invoice.status === 'void') return result('ignored', invoice);
      if (!['open', 'past_due'].includes(invoice.status)) paymentConflict('not_payable', 'Only unpaid invoices can be voided');
      // The invoice lock serializes both charge-runner and Checkout reservations.
      const unresolved = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoiceId));
      if (unresolved.some(row => row.status === 'pending')) paymentConflict('pending_attempt', 'Resolve the pending card attempt before voiding');
      if (unresolved.some(row => row.status === 'requires_action')) paymentConflict('action_required', 'Resolve the authentication attempt before voiding');
      if (invoice.checkoutSessionId || invoice.checkoutExpiresAt && invoice.checkoutExpiresAt > clock.now())
        paymentConflict('checkout_reserved', 'Resolve the reserved Checkout before voiding');
      // Link creation holds an invoice share lock. If it committed while we waited for the invoice, retry with its link
      // in our lock set rather than taking a new link lock after the invoice and deadlocking a Checkout start.
      const currentLinks = await tx.select({ id: signedLinks.id }).from(signedLinks).where(eq(signedLinks.invoiceId, invoiceId));
      const locked = new Set(links.map(link => link.id));
      if (currentLinks.some(link => !locked.has(link.id))) paymentConflict('void_links_changed', 'Pay links changed; reload before voiding');
      const voided = { ...invoice, status: 'void' };
      await tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoiceId));
      await audit(tx, context, clock, 'billing.invoice.voided', 'invoice', invoiceId,
        { ...snapshot(voided), reason }, snapshot(invoice));
      for (const link of links) await revokeSignedLinkIn(tx, context, link.id, clock.now());
      return result('applied', voided);
    });
  };
}
