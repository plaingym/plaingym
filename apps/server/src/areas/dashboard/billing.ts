// SPDX-License-Identifier: AGPL-3.0-only
import { billingDashboardWidgetSchema } from '@plaingym/shared/contracts';
import { billingDashboardResponseSchema, terminalDisputeStatuses } from '@plaingym/shared/contracts';
import { AppError, canStaff } from '@plaingym/shared';
import { addDays, localDate } from '@plaingym/shared/time';
import type { BillingDashboardWidget, ListResponse } from '@plaingym/shared/contracts';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import type { MembershipService } from '../billing/memberships.js';
import type { PaymentService } from '../billing/payments.js';
import { isOverdueInvoice } from '../billing/kiosk-standing.rules.js';
import { createWidgetRegistry } from './widgets.js';
import type { DashboardContext } from './widgets.js';

export const createBillingWidgetRegistry = () => createWidgetRegistry(billingDashboardWidgetSchema);

export interface BillingDashboardServices {
  settings: GymSettingsAccessor;
  memberships: Pick<MembershipService, 'list'>;
  payments: Pick<PaymentService, 'listInvoices'>;
}
async function allPages<T extends { id: string }>(read: (page: { limit: number; offset: number }) => Promise<ListResponse<T>>) {
  const rows = new Map<string, T>();
  for (let offset = 0; ; offset += 100) {
    const page = await read({ limit: 100, offset });
    for (const row of page.data) rows.set(row.id, row);
    if (!page.data.length || offset + 100 >= page.pagination.total) return [...rows.values()];
  }
}
const terminalDisputes = new Set<string>(terminalDisputeStatuses);
/** Reads through billing services, outside an enclosing transaction. Projections never issue invoices. */
export function createBillingDashboardService(services: BillingDashboardServices) {
  return { async get(context: DashboardContext) {
    if (!canStaff(context.roles, 'billing.read')) throw new AppError('forbidden', 'Access denied');
    const now = context.clock.now(), gym = await services.settings.get(context.gymId);
    const from = localDate(now, gym.timezone), through = addDays(from, 6);
    const [activeMemberships, upcomingMemberships, pastDueInvoices, overdueOpenInvoices, upcomingInvoices, disputeInvoices] = await Promise.all([
      allPages(page => services.memberships.list(context.gymId, { ...page, status: 'active' })),
      allPages(page => services.memberships.list(context.gymId, { ...page, dueOnOrBefore: through })),
      allPages(page => services.payments.listInvoices(context.gymId, { ...page, status: 'past_due' })),
      allPages(page => services.payments.listInvoices(context.gymId, { ...page, status: 'open', dueThrough: addDays(from, -1) })),
      allPages(page => services.payments.listInvoices(context.gymId, { ...page, dueFrom: from, dueThrough: through })),
      allPages(page => services.payments.listInvoices(context.gymId, { ...page, dispute: 'open' })),
    ]);
    if ([...activeMemberships, ...upcomingMemberships, ...pastDueInvoices, ...overdueOpenInvoices, ...upcomingInvoices, ...disputeInvoices].some(row => row.currency !== gym.currency))
      throw new AppError('unavailable', 'Billing currency mismatch');
    // Sum twelfths of a cent, then round once, keeping annual normalization exact.
    const twelfths = activeMemberships.reduce((sum, row) =>
      sum + BigInt(row.amountCents) * (row.interval === 'annual' ? 1n : 12n), 0n);
    const pastDue = [...new Map([...pastDueInvoices, ...overdueOpenInvoices].map(row => [row.id, row])).values()]
      .filter(row => isOverdueInvoice(row, from));
    const disputes = disputeInvoices.filter(row => row.disputeId !== null && !terminalDisputes.has(row.disputeStatus ?? ''));
    const upcoming = new Map<string, number>();
    for (const row of upcomingMemberships) {
      if (!['active', 'trial'].includes(row.status) || row.nextDueOn < from || row.nextDueOn > through) continue;
      const key = row.householdId + ':' + row.nextDueOn;
      upcoming.set(key, (upcoming.get(key) ?? 0) + row.amountCents);
    }
    // An issued cycle's final total replaces its estimate. Paid/void cycles suppress that estimate.
    for (const row of upcomingInvoices) {
      if (row.dueOn < from || row.dueOn > through) continue;
      if (row.status === 'draft') continue;
      const key = row.kind === 'cycle' ? row.householdId + ':' + row.dueOn : row.id;
      if (row.kind === 'cycle') upcoming.delete(key);
      if (row.status === 'open') upcoming.set(key, row.amountCents);
    }
    const money = (amountCents: number) => ({ amountCents, currency: gym.currency });
    const total = (rows: readonly { amountCents: number }[]) => rows.reduce((sum, row) => sum + row.amountCents, 0);
    const widgets: BillingDashboardWidget[] = [
      { id: 'mrr', titleKey: 'dashboard/billing:mrr', status: 'ready', money: money(Number((twelfths + 6n) / 12n)) },
      { id: 'past_due', titleKey: 'dashboard/billing:past_due', status: 'ready', money: money(total(pastDue)), invoiceCount: pastDue.length },
      { id: 'upcoming_charges', titleKey: 'dashboard/billing:upcoming_charges', status: 'ready', money: money([...upcoming.values()].reduce((a, b) => a + b, 0)), invoiceCount: upcoming.size, from, through },
      { id: 'disputes', titleKey: 'dashboard/billing:disputes', status: 'ready', money: money(total(disputes)), count: disputes.length },
    ];
    const registry = createBillingWidgetRegistry();
    registry.registerAll(widgets.map((widget): DashboardWidgetProvider<BillingDashboardWidget> => ({
      id: widget.id, permission: 'billing.read', schema: billingDashboardWidgetSchema, async read() { return widget; },
    })));
    return billingDashboardResponseSchema.parse({ data: { generatedAt: now.toISOString(), currency: gym.currency,
      widgets: await registry.read(context) } });
  } };
}
