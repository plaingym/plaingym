// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, or } from 'drizzle-orm';
import { classCreditEntries, classPackSales, forGym, uuidv7 } from '@plaingym/db';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../../core/clock.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import type { CatalogOptions } from '../catalog.js';
import { audit, effect, hasCreditReversal, lockInvoice, recorded, systemContext as system } from '../transitions/store.js';
import { markLeadWon } from '../../leads/stages.js';
import { lockMemberCredits } from './ledger.js';

/** Audited once per sale whose credits weren't granted because its member was erased before it was paid. */
export const creditsNotGranted = 'billing.credits.not_granted';

/** Invoice first, member second: every credit mutation serializes with the member's other ledger writes. */
export function createPackCredits(options: CatalogOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, settings = options.settings ?? gymSettingsAccessor;
  return {
    async grant(gymId: string, invoiceId: string) {
      const gym = await settings.get(gymId);
      await scope(gymId, async tx => {
        const invoice = await lockInvoice(tx, invoiceId);
        if (!['paid', 'partially_refunded'].includes(invoice.status)) return;
        const sale = (await tx.select().from(classPackSales).where(eq(classPackSales.invoiceId, invoice.id)))[0];
        if (!sale) return;
        const member = await lockMemberCredits(tx, sale.memberId);
        // A failed full refund can reopen a paid invoice. It must not resurrect a skipped grant either.
        if (await hasCreditReversal(tx, invoice.id)) return;
        if (!invoice.paidAt) throw new Error('Paid pack invoice has no payment time');
        // A member erased before the pack was paid can't use credits: staff are told, once, so they can refund the payer.
        if (member.anonymizedAt) {
          if (await recorded(tx, creditsNotGranted, sale.id)) return;
          await audit(tx, system(gymId), clock, creditsNotGranted, 'class_pack_sale', sale.id, { invoiceId: invoice.id, credits: sale.credits });
          await effect(tx, system(gymId), clock, { kind: 'staff_notice', notice: 'credits_not_granted', invoiceId: invoice.id });
          return;
        }
        // Expiry counts from the later of the payment's local date and the grant's, so a backdated manual payment
        // never grants credits that have already expired.
        const paidOn = localDate(invoice.paidAt, gym.timezone), grantedOn = localDate(clock.now(), gym.timezone);
        const startsOn = paidOn > grantedOn ? paidOn : grantedOn;
        const expiresAt = sale.expiryDays === null ? null
          : zonedInstant(addDays(startsOn, sale.expiryDays), '00:00', gym.timezone, { gap: 'shift' });
        const [entry] = await tx.insert(classCreditEntries).values({ id: uuidv7(), gymId, memberId: sale.memberId,
          kind: 'grant', credits: sale.credits, saleId: sale.id, expiresAt, createdAt: clock.now() }).onConflictDoNothing().returning();
        if (!entry) return;
        await audit(tx, system(gymId), clock, 'billing.credits.granted', 'class_credit_entry', entry.id, entry);
        // A paid pack is a purchase, like a membership that starts: the buyer's lead is won.
        await markLeadWon(tx, { gymId, memberId: sale.memberId, actor: { kind: 'system' }, now: clock.now() });
      });
    },
    /** Called only by the durable full-refund effect; a later failed refund never cancels this reversal. */
    async reverse(gymId: string, invoiceId: string) {
      await scope(gymId, async tx => {
        await lockInvoice(tx, invoiceId);
        const sale = (await tx.select().from(classPackSales).where(eq(classPackSales.invoiceId, invoiceId)))[0];
        if (!sale) return;
        await lockMemberCredits(tx, sale.memberId);
        const grant = (await tx.select().from(classCreditEntries).where(and(eq(classCreditEntries.memberId, sale.memberId),
          eq(classCreditEntries.saleId, sale.id), eq(classCreditEntries.kind, 'grant'))))[0];
        if (!grant) return;
        const entries = await tx.select({ credits: classCreditEntries.credits }).from(classCreditEntries).where(and(
          eq(classCreditEntries.memberId, sale.memberId), or(eq(classCreditEntries.id, grant.id), eq(classCreditEntries.lotId, grant.id))));
        const remaining = entries.reduce((total, row) => total + row.credits, 0);
        if (remaining <= 0) return;
        const [entry] = await tx.insert(classCreditEntries).values({ id: uuidv7(), gymId, memberId: sale.memberId,
          kind: 'reverse', credits: -remaining, saleId: sale.id, lotId: grant.id, createdAt: clock.now() }).onConflictDoNothing().returning();
        if (entry) await audit(tx, system(gymId), clock, 'billing.credits.reversed', 'class_credit_entry', entry.id, entry);
      });
    },
  };
}
