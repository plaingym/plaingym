// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq, inArray } from 'drizzle-orm';
import { allocateInvoiceNumber, classPacks, classPackSales, classPackTaxRates, forGym, households,
  invoiceLineItems, invoices, members, taxRates, uuidv7 } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import { notFound, type MutationContext } from '../../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import { catalogAudit, type CatalogOptions } from '../catalog.js';
import { calculateOneOffInvoice } from '../invoicing/index.js';
import { presentInvoice } from '../payments.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import messages from '../../../../../../locales/en/billing/packs.json' with { type: 'json' };

const t = createTranslator({ 'billing/packs': messages });
export interface PackSalesOptions extends CatalogOptions {
  /** Supply the runtime's publishing transitions to enqueue zero-sale credit effects immediately. */
  transitions?: Pick<InvoiceTransitions, 'settleZero'>;
}
export function createPackSalesService(options: PackSalesOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, settings = options.settings ?? gymSettingsAccessor;
  const transitions = options.transitions ?? createInvoiceTransitions({ scope, clock });
  return {
    async sell(context: MutationContext, packId: string, input: c.SellClassPackRequest) {
      const request = c.sellClassPackRequestSchema.parse(input), gym = await settings.get(context.gymId);
      const invoice = await scope(context.gymId, async tx => {
        const pack = (await tx.select().from(classPacks).where(eq(classPacks.id, c.idSchema.parse(packId))).for('share'))[0] ?? notFound();
        if (!pack.active) throw new AppError('conflict', t('billing/packs:inactive'));
        if (pack.currency !== gym.currency) throw new AppError('conflict', t('billing/packs:currencyMismatch'));
        const recipient = (await tx.select({ householdId: members.householdId }).from(members).where(eq(members.id, request.memberId)))[0] ?? notFound();
        // Erasure locks household before member. Match that order, then recheck a concurrent household move.
        const household = (await tx.select({ id: households.id }).from(households).where(eq(households.id, recipient.householdId)).for('share'))[0] ?? notFound();
        const member = (await tx.select().from(members).where(eq(members.id, request.memberId)).for('share'))[0] ?? notFound();
        if (member.anonymizedAt || member.householdId !== household.id) notFound();
        const links = () => tx.select({ id: classPackTaxRates.taxRateId }).from(classPackTaxRates).where(eq(classPackTaxRates.packId, pack.id));
        let taxIds = (await links()).map(row => row.id);
        let taxes = taxIds.length ? await tx.select().from(taxRates).where(inArray(taxRates.id, taxIds)).orderBy(asc(taxRates.id)).for('share') : [];
        // Tax archive can detach links while we wait for its rate lock. The pack lock prevents new links.
        if (taxes.length) { taxIds = (await links()).map(row => row.id); taxes = taxes.filter(row => taxIds.includes(row.id)); }
        if (taxes.length !== taxIds.length) notFound();
        if (taxes.some(row => !row.active)) throw new AppError('conflict', t('billing/packs:taxInactive'));
        const currency = c.currencySchema.parse(pack.currency);
        const { lineItems, ...calculated } = calculateOneOffInvoice({ householdId: member.householdId, currency, dueOn: request.dueOn,
          charges: [{ kind: 'charge', description: pack.name, amountCents: pack.amountCents, currency, taxRates: taxes }] });
        // Only issuance sets the initial state here; every later state change belongs to invoice transitions.
        const invoice = (await tx.insert(invoices).values({ ...calculated, id: uuidv7(), gymId: context.gymId,
          number: await allocateInvoiceNumber(tx, context.gymId), status: 'open', createdAt: clock.now() }).returning())[0]!;
        await tx.insert(invoiceLineItems).values(lineItems.map(line => ({ ...line, id: uuidv7(), gymId: context.gymId,
          householdId: invoice.householdId, invoiceId: invoice.id, createdAt: clock.now() })));
        const sale = (await tx.insert(classPackSales).values({ id: uuidv7(), gymId: context.gymId, invoiceId: invoice.id,
          householdId: invoice.householdId, memberId: member.id, packId: pack.id, credits: pack.credits,
          expiryDays: pack.expiryDays, createdAt: clock.now() }).returning())[0]!;
        await catalogAudit(tx, context, clock, 'billing.invoice.issued', 'invoice', invoice.id, undefined, presentInvoice(invoice));
        await catalogAudit(tx, context, clock, 'billing.class_pack.sold', 'class_pack_sale', sale.id, undefined, sale);
        return presentInvoice(invoice);
      });
      // One-off invoices never reach the runner's zero settlement. Commit the sale before its paid effect can run.
      if (invoice.amountCents === 0) {
        const settled = await transitions.settleZero(context, { invoiceId: invoice.id });
        return { ...invoice, ...settled.invoice };
      }
      return invoice;
    },
  };
}
export type PackSalesService = ReturnType<typeof createPackSalesService>;
