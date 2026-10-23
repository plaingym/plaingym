// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { dashboardContracts, matDashboardResponseSchema } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { DashboardWidgets } from './widgets.js';
import { BillingDashboardPanel, billingWidgetViews } from './billing.widgets.js';

const label = (key: string) => t('dashboard/dashboard:' + key);
function DashboardPanel({ gymId, roles }: { gymId: string; roles: readonly StaffRole[] }) {
  const query = useQuery({ queryKey: ['dashboard', gymId, [...roles].sort()], queryFn: async ({ signal }) => {
    const result = await api.GET(dashboardContracts.mat.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('Dashboard request failed');
    return matDashboardResponseSchema.parse(result.data).data;
  }, refetchInterval: 60_000 });
  return <main className="mx-auto max-w-7xl space-y-6 p-6">
    <div className="flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold">{label('title')}</h1>
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{label('refresh')}</Button></div>
    {query.isPending ? <p role="status">{label('loading')}</p> : query.isError ? <Alert>{label('loadFailed')}</Alert>
      : <>
        <DashboardWidgets widgets={query.data.widgets} roles={roles} views={billingWidgetViews}/>
        <p className="text-xs text-muted-foreground">{label('updated')}: <time dateTime={query.data.generatedAt}>{new Date(query.data.generatedAt).toLocaleString()}</time></p>
      </>}
    {canStaff(roles, 'billing.read') && <BillingDashboardPanel gymId={gymId} roles={roles}/>}
  </main>;
}
export function DashboardPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{label('loading')}</p>;
  if (bootstrap.isError) return <Alert>{label('loadFailed')}</Alert>;
  if (!bootstrap.data.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return <Alert>{label('noAccess')}</Alert>;
  return <DashboardPanel key={bootstrap.data.gym.id} gymId={bootstrap.data.gym.id} roles={bootstrap.data.session.roles}/>;
}
