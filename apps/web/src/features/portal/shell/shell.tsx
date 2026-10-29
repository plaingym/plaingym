// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { canMember, type NavigationEntry } from '@plaingym/shared';
import { portalAccessContracts, portalContextResponseSchema, type PortalContext, type PortalHouseholdChoice as HouseholdChoice } from '@plaingym/shared/contracts';
import { bootstrapKey, useBootstrap, useShellServices } from '../../../app/context.js';
import { createRegistries } from '../../../lib/registries.js';
import { createJsonTransport } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { Select } from '../../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader } from '../../../components/ui/page.js';

const text = (key: string) => t('portal/shell:' + key);
export function portalNavigation(entries: readonly NavigationEntry[], role: PortalContext['role'], modules: readonly string[]) {
  return entries.filter(entry => entry.enabled && (!entry.moduleId || modules.includes(entry.moduleId)) && entry.permission.kind === 'member' && canMember(role, entry.permission.capability));
}
/** Switches the session's household; the server stores the choice and rechecks it on every request. */
export function HouseholdSwitcher({ households, current, onChoose, disabled = false }: { households: readonly HouseholdChoice[]; current: string; onChoose(householdId: string): void; disabled?: boolean }) {
  return <label className="flex w-full min-w-0 items-center gap-2 text-sm">
    <span className="sr-only sm:not-sr-only sm:shrink-0">{text('household')}</span>
    <Select className="min-w-0 sm:w-64" value={current} disabled={disabled} onChange={event => onChoose(event.target.value)}>
      {households.map(choice => <option key={choice.householdId} value={choice.householdId}>{choice.name}</option>)}
    </Select>
  </label>;
}
export function HouseholdPicker({ households, onChoose, pending = false, failed = false }: { households: readonly HouseholdChoice[]; onChoose(householdId: string): void; pending?: boolean; failed?: boolean }) {
  return <Page className="max-w-md"><PageHeader title={text('chooseTitle')} description={text('chooseDescription')} />
    {failed && <Alert>{text('chooseFailed')}</Alert>}
    <ul className="space-y-3">{households.map(choice => <li key={choice.householdId}>
      <Button variant="outline" className="h-auto min-h-11 w-full justify-start whitespace-normal py-3 text-left" disabled={pending} onClick={() => onChoose(choice.householdId)}>
        <span className="min-w-0 break-words"><span className="block font-medium">{choice.name}</span><span className="block text-sm text-muted-foreground">{text(choice.role === 'payer' ? 'rolePayer' : 'roleMember')}</span></span>
      </Button></li>)}</ul>
  </Page>;
}
export function PortalLayout({ name, entries, children, onSignOut, signingOut = false, switcher }: { name: string; entries: readonly NavigationEntry[]; children: ReactNode; onSignOut(): void; signingOut?: boolean; switcher?: ReactNode }) {
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
      {switcher && <div className="order-last flex w-full min-w-0 sm:order-none sm:w-auto">{switcher}</div>}
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
  const bootstrap = useBootstrap(), services = useShellServices(), cache = useQueryClient(), navigate = useNavigate();
  const session = bootstrap.data?.session, member = !!session?.member && session.roles.length === 0;
  const base = ['portal', bootstrap.data?.gym.id, session?.userId] as const;
  const households = useQuery({ queryKey: [...base, 'households'], enabled: member,
    queryFn: async () => portalAccessContracts.households.response.parse(await createJsonTransport()('/api/portal/households')).data, retry: false, staleTime: 0 });
  const current = households.data?.current ?? null;
  const context = useQuery({ queryKey: [...base, 'context', current], enabled: member && !!current,
    queryFn: async () => portalContextResponseSchema.parse(await createJsonTransport()('/api/portal/context')).data, retry: false, staleTime: 0 });
  const choose = useMutation({
    mutationFn: async (householdId: string) => {
      await createJsonTransport()('/api/portal/households/current', { householdId });
      // Nothing from the previous household may remain on screen or in the cache.
      await cache.cancelQueries();
      await cache.resetQueries({ predicate: query => query.queryKey[0] !== bootstrapKey[0] });
      await navigate({ to: '/portal', replace: true });
    },
  });
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
  const failed = (retry: () => void) => <Page><ErrorState message={text('failed')} onRetry={retry} /><Button onClick={() => signOut.mutate()} disabled={signOut.isPending}>{text('signOut')}</Button></Page>;
  if (households.isPending || choose.isPending) return <LoadingState />;
  if (households.isError) return failed(() => void households.refetch());
  if (!current) {
    if (!households.data.households.length) return failed(() => void households.refetch());
    return <PortalLayout name={bootstrap.data.gym.name} entries={[]} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending}>
      <HouseholdPicker households={households.data.households} onChoose={id => choose.mutate(id)} pending={choose.isPending} failed={choose.isError} />
    </PortalLayout>;
  }
  if (context.isPending) return <LoadingState />;
  if (context.isError) return failed(() => { void households.refetch(); void context.refetch(); });
  const switcher = households.data.households.length > 1
    ? <HouseholdSwitcher households={households.data.households} current={current} onChoose={id => { if (id !== current) choose.mutate(id); }} disabled={choose.isPending} /> : undefined;
  return <PortalLayout name={bootstrap.data.gym.name} entries={portalNavigation(createRegistries().portalNav.all(), context.data.role, bootstrap.data.gym.enabledModules)} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending} switcher={switcher}>
    {(signOut.isError || choose.isError) && <Alert>{text(choose.isError ? 'chooseFailed' : 'failed')}</Alert>}<Outlet />
  </PortalLayout>;
}
export function PortalShell() {
  const pathname = useRouterState({ select: state => state.location.pathname });
  return pathname === '/portal/claim' ? <Outlet /> : <AuthenticatedPortal />;
}
export function PortalHome() { return <Page><PageHeader title={text('welcome')} description={text('description')} /></Page>; }
