// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { useBootstrap, useShellServices } from '../../app/context.js';
import { AdminShell } from '../../app/admin-shell.js';
function AdminLayout() {
  const bootstrap = useBootstrap();
  const services = useShellServices();
  const queryClient = useQueryClient();
  const logout = useMutation({ mutationFn: () => services.signOut(), onSuccess: async () => {
    await queryClient.cancelQueries(); queryClient.clear();
    // Reload removes route caches and any mounted state belonging to the previous account.
    window.location.assign('/login');
  } });
  if (bootstrap.isPending) return <main id="main-content" className="px-4 py-6 sm:px-6"><LoadingState /></main>;
  if (bootstrap.isError) return <main id="main-content" className="px-4 py-6 sm:px-6"><ErrorState title={t('shell/shell:loadFailed')} onRetry={() => void bootstrap.refetch()} /></main>;
  const { session } = bootstrap.data;
  if (!session) return <Navigate to="/login" replace />;
  if (session.roles.length === 0) return session.member ? <Navigate to="/portal" replace /> : <main id="main-content" className="px-4 py-6 sm:px-6"><Alert>{t('shell/shell:noAccess')}</Alert></main>;
  return <AdminShell state={{ ...bootstrap.data, session }} onSignOut={() => logout.mutate()} signingOut={logout.isPending}>
    {logout.isError && <Alert>{t('shell/shell:error')}</Alert>}<Outlet />
  </AdminShell>;
}
export const Route = createFileRoute('/admin')({ component: AdminLayout });
