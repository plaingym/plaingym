// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { classPacks, classPackSales, classPackTaxRates, forGym, households, members, uuidv7 } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import { notFound, type MutationContext } from '../../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import { catalogAudit, type CatalogOptions } from '../catalog.js';
import { issueOneOff } from '../payments.js';
import { paymentConflict } from '../payments.errors.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { memberWriteScope } from '../../members/member-write.js';
import messages from '../../../../../../locales/en/billing/packs.json' with { type: 'json' };

const t = createTranslator({ 'billing/packs': messages });
export interface PackSalesOptions extends CatalogOptions {
  /** Supply the runtime's publishing transitions to enqueue zero-sale credit effects immediately. */
  transitions?: Pick<InvoiceTransitions, 'settleZero'>;
}
export function createPackSalesService(options: PackSalesOptions = {}) {
  const scope = memberWriteScope(options.scope ?? forGym), clock = options.clock ?? defaultClock, settings = options.settings ?? gymSettingsAccessor;
  const transitions = options.transitions ?? createInvoiceTransitions({ scope, clock });
  return {
    async sell(context: MutationContext, packId: string, input: unknown) {
      const request = c.sellClassPackRequestSchema.parse(input), gym = await settings.get(context.gymId);
      const invoice = await scope(context.gymId, async tx => {
        const pack = (await tx.select().from(classPacks).where(eq(classPacks.id, c.idSchema.parse(packId))).for('share'))[0] ?? notFound();
        if (!pack.active) paymentConflict('pack_inactive', t('billing/packs:inactive'));
        if (pack.currency !== gym.currency) paymentConflict('currency_mismatch', t('billing/packs:currencyMismatch'));
        const recipient = (await tx.select({ householdId: members.householdId }).from(members).where(eq(members.id, request.memberId)))[0] ?? notFound();
        // Erasure locks household before member. Match that order, then recheck a concurrent household move.
        const household = (await tx.select({ id: households.id }).from(households).where(eq(households.id, recipient.householdId)).for('share'))[0];
        if (!household) throw new AppError('conflict', 'The household changed while waiting to save');
        const member = (await tx.select().from(members).where(eq(members.id, request.memberId)).for('share'))[0];
        if (!member) throw new AppError('conflict', 'The member changed while waiting to save');
        if (member.anonymizedAt || member.householdId !== household.id) notFound();
        const links = () => tx.select({ id: classPackTaxRates.taxRateId }).from(classPackTaxRates).where(eq(classPackTaxRates.packId, pack.id));
        const currency = c.currencySchema.parse(pack.currency);
        const invoice = await issueOneOff(tx, context, clock, { householdId: member.householdId, currency, dueOn: request.dueOn,
          description: pack.name, amountCents: pack.amountCents }, (await links()).map(row => row.id), async () => (await links()).map(row => row.id));
        const sale = (await tx.insert(classPackSales).values({ id: uuidv7(), gymId: context.gymId, invoiceId: invoice.id,
          householdId: invoice.householdId, memberId: member.id, packId: pack.id, credits: pack.credits,
          expiryDays: pack.expiryDays, createdAt: clock.now() }).returning())[0]!;
        await catalogAudit(tx, context, clock, 'billing.class_pack.sold', 'class_pack_sale', sale.id, undefined, sale);
        return invoice;
      });
      // Commit the sale before its paid effect can run; the hourly sweep recovers a failed settlement.
      if (invoice.amountCents === 0) {
        const settled = await transitions.settleZero(context, { invoiceId: invoice.id });
        return { ...invoice, ...settled.invoice };
      }
      return invoice;
    },
  };
}
export type PackSalesService = ReturnType<typeof createPackSalesService>;
