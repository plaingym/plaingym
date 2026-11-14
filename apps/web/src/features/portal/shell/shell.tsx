// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { canMember, type NavigationEntry } from '@plaingym/shared';
import { portalContracts, type PortalContext, type PortalHouseholdChoice as HouseholdChoice } from '@plaingym/shared/contracts';
import { bootstrapKey, useBootstrap, useShellServices } from '../../../app/context.js';
import { sessionName } from '../../../app/identity.js';
import { createRegistries } from '../../../lib/registries.js';
import { createJsonTransport } from '../../../lib/api.js';
import { parseResponse } from '../../../lib/response.js';
import { ownAnswer, householdListsVersion, portalHouseholdKey, portalHouseholdsKey, portalHouseholdsOptions, portalLoginKey, refreshHouseholds, runPortalOperation, portalRecoveryNoticeKey, clearPortalRecoveryNotice } from '../household/api.js';
import { t } from '../../../lib/i18n.js';
import { PortalRecoveryNotice } from '../household/recovery.js';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { Select } from '../../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader } from '../../../components/ui/page.js';

const text = (key: string) => t('portal/shell:' + key);
/** How the login stands in a household, as the header and the household picker both say it. */
const scopeLabel = (role: PortalContext['role']) => text(role === 'payer' ? 'rolePayer' : 'roleMember');
/**
 * The household the name in the cached bootstrap was last settled for, one entry per login. It lives in the query cache, under
 * the bootstrap's own prefix, outside every household's entries, and never expires on its own, so a layout that unmounts and
 * mounts again (or whose household lists were collected meanwhile) still knows whether the household changed while it was away.
 */
const openHouseholdKey = (userId: string) => ['shell', 'portal-household', userId] as const;
const readOpenHousehold = (cache: QueryClient, userId: string) => cache.getQueryData<string | null>(openHouseholdKey(userId));
const keepsEntries = new WeakSet<QueryClient>();
/** Entries under these prefixes are never collected; the defaults are set once per client. */
function keepShellEntries(cache: QueryClient) {
  if (keepsEntries.has(cache)) return;
  cache.setQueryDefaults(['shell', 'portal-household'], { gcTime: Infinity });
  cache.setQueryDefaults(['shell', 'portal-name'], { gcTime: Infinity });
  keepsEntries.add(cache);
}
function rememberOpenHousehold(cache: QueryClient, userId: string, householdId: string | null) {
  keepShellEntries(cache);
  cache.setQueryData(openHouseholdKey(userId), householdId);
}
/**
 * Present from the moment the open household changed until the bootstrap has been asked for again, one entry per login, holding
 * the change that set it. While it is present the name in the cached bootstrap may be the previous household's. It sits under the
 * bootstrap's own prefix, so discarding a household's entries leaves it alone, and the layout reads it from the cache, so a layout that remounts
 * meanwhile still knows.
 */
const staleNameKey = (userId: string) => ['shell', 'portal-name', userId] as const;
function markNameStale(cache: QueryClient, userId: string) {
  keepShellEntries(cache);
  const change = Symbol('household change');
  cache.setQueryData(staleNameKey(userId), change);
  return change;
}
/**
 * Asks for the bootstrap again, cancelling a load already under way (it may carry the previous name), and lifts the mark once a
 * load has finished. A load that failed lifts it too: the header then falls back to the generic label until one succeeds
 * (`isRefetchError`). A bootstrap nobody is watching stays invalidated, so the mark waits for the load that its next observer starts.
 */
async function refreshName(cache: QueryClient, userId: string, change: symbol) {
  await cache.invalidateQueries({ queryKey: bootstrapKey });
  const mine = () => cache.getQueryData(staleNameKey(userId)) === change;
  const settled = () => { const state = cache.getQueryState(bootstrapKey); return state?.fetchStatus === 'idle' && (!state.isInvalidated || state.status === 'error'); };
  const lift = () => cache.removeQueries({ queryKey: staleNameKey(userId), exact: true });
  if (!mine()) return;
  if (settled()) return lift();
  // Only the bootstrap and the mark itself matter here, so everything else the cache does is ignored.
  const stop = cache.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] !== 'shell') return;
    if (!mine()) stop(); else if (settled()) { stop(); lift(); }
  });
}
/**
 * Drops everything cached for any household but the open one. Every portal query is keyed by the open household
 * (`usePortalScope`), so nothing of it can be reached from the household now open; this only cancels what is still loading and
 * frees the entries. The household lists, the bootstrap and root queries such as demo discovery are not under this prefix.
 */
function discardOtherHouseholds(cache: QueryClient, login: ReturnType<typeof portalLoginKey>, open: string | null) {
  cache.removeQueries({ queryKey: [...login, 'household'], predicate: query => query.queryKey[4] !== open });
}
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
    {failed && <Alert variant="error" focusOnReveal>{text('chooseFailed')}</Alert>}
    <ul className="space-y-3">{households.map(choice => <li key={choice.householdId}>
      <Button variant="outline" className="h-auto min-h-11 w-full justify-start whitespace-normal py-3 text-left" disabled={pending} onClick={() => onChoose(choice.householdId)}>
        <span className="min-w-0 break-words"><span className="block font-medium">{choice.name}</span><span className="block text-sm text-muted-foreground">{scopeLabel(choice.role)}</span></span>
      </Button></li>)}</ul>
  </Page>;
}
export function PortalLayout({ name, person, scope, entries, children, onSignOut, signingOut = false, switcher, account = false }:
  { name: string; person?: string; scope?: PortalContext['role']; entries: readonly NavigationEntry[]; children: ReactNode; onSignOut(): void; signingOut?: boolean; switcher?: ReactNode;
    /** Shows the link to the login's own account page; the household picker has no page to show it in. */
    account?: boolean }) {
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
      {/* At least 10rem for the gym and the person: on a phone the account actions move to their own row instead. */}
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate font-semibold" title={name}>{name}</p>
        {/* A long name gives way to its ellipsis; the scope stays. */}
        {person && <p className="flex min-w-0 text-xs text-muted-foreground" data-testid="signed-in-identity">
          <span className="truncate font-medium text-foreground">{person}</span>{scope && <span className="shrink-0 whitespace-pre"> · {scopeLabel(scope)}</span>}
        </p>}
      </div>
      {switcher && <div className="order-last flex w-full min-w-0 sm:order-none sm:w-auto">{switcher}</div>}
      <div className="ml-auto flex gap-2">
        {account && <Button asChild variant="ghost"><Link to="/portal/account" activeProps={{ 'aria-current': 'page' }}>{t('auth/account:menuLink')}</Link></Button>}
        <Button variant="ghost" onClick={onSignOut} disabled={signingOut}>{text('signOut')}</Button>
      </div>
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
  const gymId = bootstrap.data?.gym.id, userId = session?.userId, login = portalLoginKey(gymId, userId);
  const pathname = useRouterState({ select: state => state.location.pathname });
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) clearPortalRecoveryNotice(cache, portalLoginKey(gymId, userId));
    previousPath.current = pathname;
  }, [pathname, cache, gymId, userId]);
  const households = useQuery(portalHouseholdsOptions(login, member));
  const current = households.data?.current ?? null;
  // The shell's own context query lives in the open household's subtree like every portal query, so it is unreachable from any
  // other, under the reserved `shell` segment no page key uses, so no page's query or invalidation reaches it.
  const householdKey = portalHouseholdKey(login, current);
  const context = useQuery({ queryKey: [...householdKey, 'shell', 'context'], enabled: member && !!current,
    // The server answers for the household it has open. If the lists this key came from name another one, the server moved on
    // (a revoked link fell back to another household) and this answer is the new household's: it is never stored under the
    // old household's key, and the lists are read again; once they name the other household, this key is no longer the open one.
    queryFn: async () => {
      const listsVersion = householdListsVersion(cache, householdKey);
      return runPortalOperation(async () => ownAnswer(cache, householdKey, parseResponse(portalContracts.context.response, await createJsonTransport()(portalContracts.context.path)), listsVersion).data,
        expected => { void refreshHouseholds(cache, householdKey, listsVersion, expected).catch(() => undefined); });
    },
    retry: false, staleTime: 0 });
  // While the name may still be the previous household's, the header says nothing about who is signed in. Only the shell's own
  // entries (the mark and the bootstrap) can change that, so no other cache event wakes this.
  const nameStale = useSyncExternalStore(useCallback(notify => cache.getQueryCache().subscribe(event => { if (event.query.queryKey[0] === 'shell') notify(); }), [cache]),
    () => userId !== undefined && cache.getQueryData(staleNameKey(userId)) !== undefined);
  const choose = useMutation({
    mutationFn: async (householdId: string) => {
      await createJsonTransport()('/api/portal/households/current', { householdId });
      // From here the server has the switch, so whatever a later step does, the portal is the new household's. The name is
      // stale now, whatever else happens, so say so before anything below can be interrupted.
      const change = userId ? (rememberOpenHousehold(cache, userId, householdId), markNameStale(cache, userId)) : undefined;
      try {
        // The lists name the new household from here on, so every portal key is the new household's and the previous one's
        // entries are unreachable. A list load that started before the switch could still answer with the old name, so it is
        // cancelled first. The lists are then read again, and waited for, so every switch finishes in order.
        await cache.cancelQueries({ queryKey: portalHouseholdsKey(login) });
        cache.setQueryData(portalHouseholdsKey(login), (old: typeof households.data) => old && { ...old, current: householdId });
        clearPortalRecoveryNotice(cache, login);
        discardOtherHouseholds(cache, login, householdId);
        await cache.refetchQueries({ queryKey: portalHouseholdsKey(login) });
        await navigate({ to: '/portal', replace: true });
      } catch {
        // Going home failed after the server stored the switch: not a failed switch. The portal is the new household's.
      } finally {
        // The name is asked for again whatever stopped the steps above, and the switch goes home without waiting for it.
        // This runs even if the layout that asked for the switch has gone.
        if (userId && change) void refreshName(cache, userId, change); else void cache.invalidateQueries({ queryKey: bootstrapKey });
      }
    },
  });
  // The name the gym knows the person by follows the open household, however it changed: a switch here, or the server
  // falling back to another household when a link was revoked. The session keeps its data meanwhile (the shell stays up).
  // A noticed change discards the previous household's entries as a switch does; the pages already follow the new key.
  const loaded = households.data !== undefined;
  useEffect(() => {
    if (!loaded || !userId) return;
    const seen = readOpenHousehold(cache, userId);
    rememberOpenHousehold(cache, userId, current);
    // Whatever the household did, only the open one keeps entries (a list read that lagged behind a switch can have left some).
    discardOtherHouseholds(cache, login, current);
    if (seen === undefined || seen === current) return;
    cache.setQueryData(portalRecoveryNoticeKey(login), true);
    const change = markNameStale(cache, userId);
    void refreshName(cache, userId, change);
  }, [loaded, current, userId, gymId, cache]);
  const signOut = useMutation({ mutationFn: async () => { await services.signOut(); await cache.cancelQueries(); cache.clear(); location.assign('/login'); } });
  useEffect(() => {
    const manifest = document.createElement('link'); manifest.rel = 'manifest'; manifest.href = '/portal/manifest.webmanifest'; document.head.append(manifest);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/portal/sw.js', { scope: '/portal' }).catch(() => undefined);
    return () => manifest.remove();
  }, []);
  // A refetch that fails keeps the portal up: only a first load with nothing to show is an error page.
  if (!bootstrap.data) return bootstrap.isError ? <ErrorState onRetry={() => void bootstrap.refetch()} /> : <LoadingState />;
  if (session?.roles.length) return <Navigate to="/admin" replace />;
  if (!session?.member) return <Navigate to="/login" replace />;
  // While the refetch after a change is pending, and after one that failed, the name is the previous household's (or an older
  // load's), so the generic label stands in until one succeeds.
  // The same holds for the one render in which the lists first name another household, before the effect above has marked it.
  const settledFor = userId === undefined ? undefined : readOpenHousehold(cache, userId);
  const changed = loaded && settledFor !== undefined && settledFor !== current;
  const person = sessionName(bootstrap.isRefetchError || nameStale || changed ? { displayName: null } : session);
  const failed = (retry: () => void) => <Page><ErrorState message={text('failed')} onRetry={retry} /><Button onClick={() => signOut.mutate()} disabled={signOut.isPending}>{text('signOut')}</Button></Page>;
  if (households.isPending || choose.isPending) return <LoadingState />;
  // A list load that fails while the portal has lists to show keeps it up, like the bootstrap: every key follows the lists.
  if (households.isError && !households.data) return failed(() => void households.refetch());
  if (!current) {
    if (!households.data.households.length) return failed(() => void households.refetch());
    return <PortalLayout name={bootstrap.data.gym.name} person={person} entries={[]} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending}>
      <PortalRecoveryNotice /><HouseholdPicker households={households.data.households} onChoose={id => choose.mutate(id)} pending={choose.isPending} failed={choose.isError} />
    </PortalLayout>;
  }
  // A context read that failed waits only for the lists being read again; if they still name this household, it is an error.
  if (!context.data) {
    if (context.isPending || households.isFetching) return <LoadingState />;
    return failed(() => { void households.refetch(); void context.refetch(); });
  }
  const switcher = households.data.households.length > 1
    ? <HouseholdSwitcher households={households.data.households} current={current} onChoose={id => { if (id !== current) choose.mutate(id); }} disabled={choose.isPending} /> : undefined;
  return <PortalLayout name={bootstrap.data.gym.name} person={person} scope={context.data.role} entries={portalNavigation(createRegistries().portalNav.all(), context.data.role, bootstrap.data.gym.enabledModules)} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending} switcher={switcher} account>
    {context.isError && !households.isFetching && <ErrorState message={text('failed')} onRetry={() => { void households.refetch(); void context.refetch(); }} />}
    <PortalRecoveryNotice />{(signOut.isError || choose.isError) && <Alert variant="error">{text(choose.isError ? 'chooseFailed' : 'failed')}</Alert>}<Outlet key={current} />
  </PortalLayout>;
}
export function PortalShell() {
  const pathname = useRouterState({ select: state => state.location.pathname });
  return pathname === '/portal/claim' ? <Outlet /> : <AuthenticatedPortal />;
}
export { PortalHome } from './home.js';
