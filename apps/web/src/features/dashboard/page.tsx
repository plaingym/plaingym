// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { dashboardContracts, matDashboardResponseSchema } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states.js';
import { DashboardWidgets } from './widgets.js';
import { BillingDashboardPanel, billingWidgetViews } from './billing.widgets.js';

const label = (key: string) => t('dashboard/dashboard:' + key);
function DashboardPanel({ gymId, roles }: { gymId: string; roles: readonly StaffRole[] }) {
  const query = useQuery({ queryKey: ['dashboard', gymId, [...roles].sort()], queryFn: async ({ signal }) => {
    const result = await api.GET(dashboardContracts.mat.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('Dashboard request failed');
    return matDashboardResponseSchema.parse(result.data).data;
  }, refetchInterval: 60_000 });
  return <Page>
    <PageHeader title={label('title')} description={query.data && <>{label('updated')}: <time dateTime={query.data.generatedAt}>{new Date(query.data.generatedAt).toLocaleString()}</time></>}
      actions={<Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{label('refresh')}</Button>}/>
    {query.isPending ? <LoadingState label={label('loading')}/> : query.isError ? <ErrorState message={label('loadFailed')} onRetry={() => void query.refetch()}/>
      : query.data.widgets.length === 0 ? <EmptyState title={label('empty')} description={label('emptyHelp')}/>
      : <DashboardWidgets widgets={query.data.widgets} roles={roles} views={billingWidgetViews}/>}
    {canStaff(roles, 'billing.read') && <BillingDashboardPanel gymId={gymId} roles={roles}/>}
  </Page>;
}
export function DashboardPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={label('loading')}/></Page>;
  if (bootstrap.isError) return <Page><ErrorState message={label('loadFailed')} onRetry={() => void bootstrap.refetch()}/></Page>;
  if (!bootstrap.data.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return <Page><Alert>{label('noAccess')}</Alert></Page>;
  return <DashboardPanel key={bootstrap.data.gym.id} gymId={bootstrap.data.gym.id} roles={bootstrap.data.session.roles}/>;
}
