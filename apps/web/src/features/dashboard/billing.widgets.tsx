// SPDX-License-Identifier: AGPL-3.0-only
import { canStaff, type StaffRole } from '@plaingym/shared';
import { useQuery } from '@tanstack/react-query';
import { billingDashboardResponseSchema, dashboardContracts, type DashboardWidget } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { PageSection } from '../../components/ui/page.js';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states.js';
import { DashboardWidgets } from './widgets.js';
import type { DashboardView } from './widgets.js';
import { money } from '../billing/catalog/format.js';

const label = (key: string, values?: Parameters<typeof t>[1]) => t('dashboard/billing:' + key, values);
const calendarDate = (date: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
function BillingMetric({ widget }: { widget: DashboardWidget }) {
  if (!('money' in widget)) return null;
  return <div className="min-w-0 space-y-3 pt-3">
    <p className="break-words text-3xl font-semibold tabular-nums">{money(widget.money.amountCents, widget.money.currency)}</p>
    {'invoiceCount' in widget && <p className="text-sm text-muted-foreground">{label(widget.id === 'upcoming_charges' ? 'chargeCount' : 'invoiceCount', { count: widget.invoiceCount })}</p>}
    {widget.id === 'disputes' && <p className="text-sm text-muted-foreground">{label('disputeCount', { count: widget.count })}</p>}
    {widget.id === 'upcoming_charges' && <p className="text-sm text-muted-foreground">{label('range', { from: calendarDate(widget.from), through: calendarDate(widget.through) })}</p>}
    <p className="text-sm text-muted-foreground">{label('help.' + widget.id)}</p>
  </div>;
}
export const billingWidgetViews: readonly DashboardView[] = ['mrr', 'past_due', 'upcoming_charges', 'disputes'].map(id => ({
  id, permission: 'billing.read', render: widget => <BillingMetric widget={widget}/>,
}));
function BillingPanel({ gymId, roles }: { gymId: string; roles: readonly StaffRole[] }) {
  const query = useQuery({ queryKey: ['dashboard-billing', gymId, [...roles].sort()], queryFn: async ({ signal }) => {
    const result = await api.GET(dashboardContracts.billing.path, { signal, cache: 'no-store' });
    return billingDashboardResponseSchema.parse(result.data).data;
  }, refetchInterval: 5 * 60_000 });
  return <PageSection title={label('title')} actions={<Button variant="outline" disabled={query.isFetching}
    onClick={() => void query.refetch()}>{label('refresh')}</Button>}>
    {query.isPending ? <LoadingState label={label('loading')}/> : query.isError ? <ErrorState message={label('loadFailed')} onRetry={() => void query.refetch()}/>
      : query.data.widgets.length === 0 ? <EmptyState title={label('empty')}/>
        : <DashboardWidgets widgets={query.data.widgets} roles={roles} views={billingWidgetViews}/>}
  </PageSection>;
}
export function BillingDashboardPanel(props: { gymId: string; roles: readonly StaffRole[] }) {
  return canStaff(props.roles, 'billing.read') ? <BillingPanel key={props.gymId + ':' + [...props.roles].sort().join(',')} {...props}/> : null;
}
