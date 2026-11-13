// SPDX-License-Identifier: AGPL-3.0-only
import { billingDashboardWidgetSchema, billingDashboardResponseSchema, extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import { AppError, canStaff, createTranslator } from '@plaingym/shared';
import { addDays, localDate } from '@plaingym/shared/time';
import { cardChargeIssue, formatMinorUnits } from '@plaingym/shared/money';
import { locales } from '@plaingym/shared/locales';
import { forGym, invoices } from '@plaingym/db';
import { and, asc, count, eq, gt, inArray, lte, or } from 'drizzle-orm';
import type { BillingDashboardWidget } from '@plaingym/shared/contracts';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { assignmentInvoiceCondition } from '../billing/assignment-invoices.js';
import { skippedAmountCondition, readBillingTotals } from './billing.query.js';
import { createWidgetRegistry } from './widgets.js';
import type { DashboardContext } from './widgets.js';

export const createBillingWidgetRegistry = () => createWidgetRegistry(billingDashboardWidgetSchema);

export interface BillingDashboardServices {
  scope?: typeof forGym;
  settings: GymSettingsAccessor;
}

/** Uses the dashboard's existing shortlist extension; collection and email behavior stay with billing. */
export function createSkippedCollectionsProvider<T extends BillingDashboardServices>(services: T):
DashboardWidgetProvider<ReturnType<typeof extensionDashboardWidgetSchema.parse>> {
  const t = createTranslator(locales.en ?? {});
  return { id: 'billing.skipped-collections', permission: 'billing.read', order: 45, schema: extensionDashboardWidgetSchema,
    async read(context) {
      if (!canStaff(context.roles, 'billing.read')) throw new AppError('forbidden', 'Access denied');
      const gym = await services.settings.get(context.gymId), today = localDate(context.clock.now(), gym.timezone);
      const { rows, total } = gym.billingEnabled ? await (services.scope ?? forGym)(context.gymId, async tx => {
        const filter = and(eq(invoices.gymId, context.gymId), eq(invoices.currency, gym.currency),
          inArray(invoices.status, ['open', 'past_due']), gt(invoices.amountCents, 0), eq(invoices.needsReview, false),
          lte(invoices.dueOn, today), or(eq(invoices.kind, 'cycle'), assignmentInvoiceCondition(tx)),
          skippedAmountCondition(gym.currency));
        const [result] = await tx.select({ total: count() }).from(invoices).where(filter);
        const rows = await tx.select({ id: invoices.id, number: invoices.number, amountCents: invoices.amountCents, currency: invoices.currency })
          .from(invoices).where(filter).orderBy(asc(invoices.dueOn), asc(invoices.id)).limit(20);
        return { rows, total: result!.total };
      }) : { rows: [], total: 0 };
      if (!total) return null;
      return { id: 'billing.skipped-collections', titleKey: 'dashboard/billing:skippedCollections', status: 'ready', kind: 'count', count: total,
        items: rows.map(row => ({ href: `/admin/billing/invoices/${row.id}`,
          label: t('dashboard/billing:skippedCollection', { number: row.number ?? '', amount: formatMinorUnits(row.amountCents, row.currency),
            reason: t('dashboard/billing:' + cardChargeIssue(row.amountCents, row.currency)) }) })) };
    },
  };
}
/** One aggregate snapshot after settings; projections never issue invoices. */
export function createBillingDashboardService(services: BillingDashboardServices) {
  return { async get(context: DashboardContext) {
    if (!canStaff(context.roles, 'billing.read')) throw new AppError('forbidden', 'Access denied');
    const now = context.clock.now(), gym = await services.settings.get(context.gymId);
    const from = localDate(now, gym.timezone), through = addDays(from, 6);
    const totals = await readBillingTotals(services.scope ?? forGym, context.gymId, gym.currency, from, through);
    if (totals.mismatch)
      throw new AppError('unavailable', 'Billing currency mismatch');
    const money = (amountCents: number) => ({ amountCents, currency: gym.currency });
    const widgets: BillingDashboardWidget[] = [
      { id: 'mrr', titleKey: 'dashboard/billing:mrr', status: 'ready', money: money(Number(totals.mrr)) },
      { id: 'past_due', titleKey: 'dashboard/billing:past_due', status: 'ready', money: money(Number(totals.past_due)), invoiceCount: Number(totals.past_due_count) },
      { id: 'upcoming_charges', titleKey: 'dashboard/billing:upcoming_charges', status: 'ready', money: money(Number(totals.upcoming)), invoiceCount: Number(totals.upcoming_count), from, through },
      ...(Number(totals.dispute_count) ? [{ id: 'disputes' as const, titleKey: 'dashboard/billing:disputes', status: 'ready' as const,
        money: money(Number(totals.disputes)), count: Number(totals.dispute_count) }] : []),
    ];
    const registry = createBillingWidgetRegistry();
    registry.registerAll(widgets.map((widget): DashboardWidgetProvider<BillingDashboardWidget> => ({
      id: widget.id, permission: 'billing.read', schema: billingDashboardWidgetSchema,
      async read() { return widget; },
    })));
    return billingDashboardResponseSchema.parse({ data: { generatedAt: now.toISOString(), currency: gym.currency,
      widgets: await registry.read(context) } });
  } };
}
