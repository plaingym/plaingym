// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { canMember, type NavigationEntry } from '@plaingym/shared';
import { portalContextResponseSchema, type PortalContext } from '@plaingym/shared/contracts';
import { useBootstrap, useShellServices } from '../../../app/context.js';
import { createRegistries } from '../../../lib/registries.js';
import { createJsonTransport } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader } from '../../../components/ui/page.js';

const text = (key: string) => t('portal/shell:' + key);
export function portalNavigation(entries: readonly NavigationEntry[], role: PortalContext['role'], modules: readonly string[]) {
  return entries.filter(entry => entry.enabled && (!entry.moduleId || modules.includes(entry.moduleId)) && entry.permission.kind === 'member' && canMember(role, entry.permission.capability));
}
export function PortalLayout({ name, entries, children, onSignOut, signingOut = false }: { name: string; entries: readonly NavigationEntry[]; children: ReactNode; onSignOut(): void; signingOut?: boolean }) {
  const [open, setOpen] = useState(false), [online, setOnline] = useState(navigator.onLine);
  const pathname = useRouterState({ select: state => state.location.pathname });
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine), escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('online', update); window.addEventListener('offline', update); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); window.removeEventListener('keydown', escape); };
  }, []);
  return <div className="flex min-h-dvh min-w-0 flex-col">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      <Button variant="outline" className="md:hidden" aria-expanded={open} aria-controls="portal-navigation" onClick={() => setOpen(!open)}>{text('menu')}</Button>
      <p className="min-w-0 flex-1 truncate font-semibold">{name}</p>
      <Button variant="ghost" onClick={onSignOut} disabled={signingOut}>{text('signOut')}</Button>
    </header>
    <div className="flex min-w-0 flex-1 flex-col md:flex-row">
      <nav id="portal-navigation" aria-label={text('navigation')} className={`${open ? 'block' : 'hidden'} border-b border-border p-3 md:block md:w-56 md:shrink-0 md:border-b-0 md:border-r`}>
        <ul className="space-y-1">{entries.map(entry => <li key={entry.id}><Link to={entry.href} className="flex min-h-11 items-center rounded-md px-3 hover:bg-muted" activeOptions={{ exact: true }} activeProps={{ className: 'bg-muted font-semibold', 'aria-current': 'page' }}>{t(entry.labelKey)}</Link></li>)}</ul>
      </nav>
      <main id="main-content" className="min-w-0 flex-1 px-4 py-6 sm:px-6">{!online && <Alert>{text('offline')}</Alert>}{children}</main>
    </div>
  </div>;
}
function AuthenticatedPortal() {
  const bootstrap = useBootstrap(), services = useShellServices(), cache = useQueryClient();
  const session = bootstrap.data?.session;
  const context = useQuery({ queryKey: ['portal', bootstrap.data?.gym.id, session?.userId, 'context'], enabled: !!session?.member && session.roles.length === 0,
    queryFn: async () => portalContextResponseSchema.parse(await createJsonTransport()('/api/portal/context')).data, retry: false, staleTime: 0 });
  const signOut = useMutation({ mutationFn: async () => { await services.signOut(); await cache.cancelQueries(); cache.clear(); location.assign('/login'); } });
  useEffect(() => {
    const manifest = document.createElement('link'); manifest.rel = 'manifest'; manifest.href = '/portal/manifest.webmanifest'; document.head.append(manifest);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/portal/sw.js', { scope: '/portal' }).catch(() => undefined);
    return () => manifest.remove();
  }, []);
  if (bootstrap.isPending) return <LoadingState />;
  if (bootstrap.isError) return <ErrorState onRetry={() => void bootstrap.refetch()} />;
  if (session?.roles.length) return <Navigate to="/admin" replace />;
  if (!session?.member) return <Navigate to="/login" replace />;
  if (context.isPending) return <LoadingState />;
  if (context.isError) return <Page><ErrorState message={text('failed')} onRetry={() => void context.refetch()} /><Button onClick={() => signOut.mutate()} disabled={signOut.isPending}>{text('signOut')}</Button></Page>;
  return <PortalLayout name={bootstrap.data.gym.name} entries={portalNavigation(createRegistries().portalNav.all(), context.data.role, bootstrap.data.gym.enabledModules)} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending}>
    {signOut.isError && <Alert>{text('failed')}</Alert>}<Outlet />
  </PortalLayout>;
}
export function PortalShell() {
  const pathname = useRouterState({ select: state => state.location.pathname });
  return pathname === '/portal/claim' ? <Outlet /> : <AuthenticatedPortal />;
}
export function PortalHome() { return <Page><PageHeader title={text('welcome')} description={text('description')} /></Page>; }
