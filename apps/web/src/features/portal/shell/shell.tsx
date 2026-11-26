// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { onlineManager, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { canMember, type NavigationEntry } from '@plaingym/shared';
import { portalContracts, type PortalContext, type PortalHouseholdChoice as HouseholdChoice } from '@plaingym/shared/contracts';
import { AccountMenu, useDismiss } from '../../../app/account-menu.js';
import { useMenuCovers } from '../../../app/menu-covers.js';
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
import { lockPageScroll } from '../../../components/ui/dialog.js';
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
      <Button wrap variant="outline" className="h-auto min-h-11 w-full justify-start whitespace-normal py-3 text-left" disabled={pending} onClick={() => onChoose(choice.householdId)}>
        <span className="min-w-0"><span className="block font-medium">{choice.name}</span><span className="block text-sm text-muted-foreground">{scopeLabel(choice.role)}</span></span>
      </Button></li>)}</ul>
  </Page>;
}
export function PortalLayout({ name, person, scope, entries, children, notices, failure, onSignOut, signingOut = false, switcher, account = false }:
  { name: string; person?: string; scope?: PortalContext['role']; entries: readonly NavigationEntry[]; children: ReactNode; onSignOut(): void; signingOut?: boolean; switcher?: ReactNode;
    /** What the page area says above a sign-out failure. */
    notices?: ReactNode;
    /** A sign-out failure. It has its own place above the page, so it stays mounted while the page's content changes. */
    failure?: ReactNode;
    /** Shows the link to the login's own account page; the household picker has no page to show it in. */
    account?: boolean }) {
  const [open, setOpen] = useState(false), [online, setOnline] = useState(navigator.onLine);
  const root = useRef<HTMLDivElement>(null), header = useRef<HTMLElement>(null);
  // A menu with nothing to list closes, so it never holds the page, and the focus its link or button held goes to the account menu.
  useLayoutEffect(() => {
    if (!open || entries.length) return;
    setOpen(false);
    if (document.activeElement === document.body) header.current?.querySelector<HTMLElement>('[aria-controls="account-menu"]')?.focus();
  }, [open, entries.length]);
  const menuButton = useRef<HTMLButtonElement>(null), nav = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null), cover = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0), [menuTop, setMenuTop] = useState<number>(), [capTop, setCapTop] = useState<number>();
  // The backdrop, and the cover over what is above the menu, close it on their click: gone on the press instead, a tap
  // would land on what is under them.
  const [refs] = useState(() => [menuButton, nav, backdrop, cover]);
  const [close] = useState(() => () => setOpen(false));
  useDismiss(open, close, refs, menuButton);
  useMenuCovers(open);
  const pathname = useRouterState({ select: state => state.location.pathname });
  // The banner and React Query's reads follow the same answer.
  const update = useCallback(() => { setOnline(navigator.onLine); onlineManager.setOnline(navigator.onLine); }, []);
  useEffect(() => setOpen(false), [pathname]);
  // Navigation checks again, in case an event was missed. A layout effect runs before the new page's reads start.
  useLayoutEffect(update, [pathname, update]);
  useEffect(() => {
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, [update]);
  // The desktop sidebar starts below the docked header. The phone menu starts where the header ends on screen (below
  // anything above the portal, until the header docks). Content above the portal moves it, so the page is observed too.
  useLayoutEffect(() => {
    const measure = () => {
      const element = header.current;
      // On a short screen the header scrolls away with the page, so it takes no room at the top.
      setHeaderHeight(element && getComputedStyle(element).position === 'sticky' ? element.offsetHeight : 0);
      const top = open ? Math.max(0, element?.getBoundingClientRect().bottom ?? 0) : undefined;
      setMenuTop(top);
      // The lowest the panel can start and still show one link: its height floor above the screen's bottom.
      const lowest = window.innerHeight - (parseFloat(getComputedStyle(document.documentElement).fontSize) * 4.25 + 1);
      setCapTop(top !== undefined && top > lowest ? lowest : undefined);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    for (const element of [header.current, root.current, document.body]) if (element) observer?.observe(element);
    window.addEventListener('resize', measure);
    if (open) window.addEventListener('scroll', measure, { passive: true });
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure); };
  }, [open]);
  // A control focused while scrolling up stops below the docked header instead of under it.
  useLayoutEffect(() => {
    const style = document.documentElement.style, previous = style.scrollPaddingTop;
    if (headerHeight > 0) style.scrollPaddingTop = `${headerHeight + 8}px`;
    return () => { style.scrollPaddingTop = previous; };
  }, [headerHeight]);
  // Tailwind's `md` breakpoint shows the sidebar, so the phone menu is no longer open.
  useEffect(() => {
    if (!open) return;
    const desktop = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 48rem)') : null;
    const closeOnDesktop = () => { if (desktop?.matches) setOpen(false); };
    closeOnDesktop();
    desktop?.addEventListener('change', closeOnDesktop);
    return () => desktop?.removeEventListener('change', closeOnDesktop);
  }, [open]);
  // The page behind the menu must not scroll. Clip the body instead of hiding it: hiding it makes the body a scroll
  // container, which breaks the sticky header.
  useLayoutEffect(() => {
    if (!open) return;
    const body = document.body, previousBodyOverflow = body.style.overflow;
    const release = lockPageScroll();
    body.style.overflow = 'clip';
    return () => { body.style.overflow = previousBodyOverflow; release(); };
  }, [open]);
  useEffect(() => { if (open) nav.current?.querySelector<HTMLElement>('a')?.focus(); }, [open]);
  return <div ref={root} className="flex min-h-dvh min-w-0 flex-col" style={{ '--portal-header-height': `${headerHeight}px` } as CSSProperties}>
    {/* A docked header would take too much of a screen 500 px tall or less (a phone in landscape). */}
    <header ref={header} className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] [@media(max-height:500px)]:static">
      {entries.length > 0 && <Button ref={menuButton} variant="outline" className="md:hidden" aria-expanded={open} aria-controls="portal-navigation" onClick={() => setOpen(!open)}>{text('menu')}</Button>}
      {/* Reserve space for the gym and the person before the household switcher. */}
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate font-semibold" title={name}>{name}</p>
        {/* A long name gives way to its ellipsis; the scope stays. */}
        {person && <p className="flex min-w-0 text-xs text-muted-foreground" data-testid="signed-in-identity">
          <span className="truncate font-medium text-foreground">{person}</span>{scope && <span className="shrink-0 whitespace-pre"> · {scopeLabel(scope)}</span>}
        </p>}
      </div>
      {switcher && <div className="order-last flex w-full min-w-0 sm:order-none sm:w-auto">{switcher}</div>}
      <AccountMenu accountPath={account ? '/portal/account' : undefined} onSignOut={onSignOut} signingOut={signingOut} />
    </header>
    <div className="flex min-w-0 flex-1 flex-col md:flex-row">
      {open && <div ref={backdrop} aria-hidden="true" className="fixed inset-x-0 bottom-0 z-10 bg-foreground/20 md:hidden" style={{ top: menuTop }} onClick={close} />}
      {/* Takes the presses above the menu, under the header: the demo rows there are inert, so a tap would close the menu on the press and then click them. */}
      {open && menuTop !== undefined && <div ref={cover} aria-hidden="true" className="fixed inset-x-0 top-0 z-10 md:hidden" style={{ height: menuTop }} onClick={close} />}
      {/* The open panel is as tall as its links, but stops 3rem short of the screen's bottom so a strip of backdrop shows. It never gets shorter than one link,
          and when one wouldn't fit below its top, it starts higher, over the header's lower edge if need be. */}
      {entries.length > 0 && <nav ref={nav} id="portal-navigation" aria-label={text('navigation')} style={open && menuTop !== undefined ? { top: capTop ?? menuTop, maxHeight: `max(calc(100dvh - ${menuTop}px - 3rem), calc(4.25rem + 1px))` } : undefined}
        className={`${open ? `fixed inset-x-0 ${capTop === undefined ? 'z-20' : 'z-40'} block overflow-y-auto overscroll-contain bg-background shadow-lg` : 'hidden'} border-b border-border p-3
          md:sticky md:top-[var(--portal-header-height)] md:bottom-auto md:block md:max-h-[calc(100dvh-var(--portal-header-height))] md:w-56 md:shrink-0 md:self-start md:overflow-y-auto md:border-b-0 md:border-r md:shadow-none`}>
        <ul className="space-y-1">{entries.map(entry => <li key={entry.id}><Link to={entry.href} onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-md px-3 hover:bg-muted" activeOptions={{ exact: true }} activeProps={{ className: 'bg-muted font-semibold', 'aria-current': 'page' }}>{t(entry.labelKey)}</Link></li>)}</ul>
      </nav>}
      {/* The page the open panel covers takes no focus or presses. */}
      <main id="main-content" inert={open} className="min-w-0 flex-1 px-4 py-6 sm:px-6">{!online && <Alert>{text('offline')}</Alert>}{notices}{failure}{children}</main>
    </div>
  </div>;
}
/** The loading state before the portal can open. Its reads wait while the browser says it is offline, so it says why. */
function PortalLoading() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    // The browser may have changed between the first render and this listener.
    update();
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return <>{!online && <div className="px-4 pt-6 sm:px-6"><Alert>{text('offline')}</Alert></div>}<div className="px-4 py-6 sm:px-6"><LoadingState /></div></>;
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
  const signOut = useMutation({ mutationFn: async () => { await services.signOut(); await cache.cancelQueries(); cache.clear(); location.assign('/login'); } });
  // While a sign-out is being sent, a failed view isn't read again under it, so its status stays.
  const unheld = (query: { state: { data: unknown } }) => !(signOut.isPending && query.state.data === undefined);
  const households = useQuery({ ...portalHouseholdsOptions(login, member), refetchOnWindowFocus: unheld, refetchOnReconnect: unheld });
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
    retry: false, staleTime: 0, refetchOnWindowFocus: unheld, refetchOnReconnect: unheld });
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
  useEffect(() => {
    const manifest = document.createElement('link'); manifest.rel = 'manifest'; manifest.href = '/portal/manifest.webmanifest'; document.head.append(manifest);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/portal/sw.js', { scope: '/portal' }).catch(() => undefined);
    return () => manifest.remove();
  }, []);
  // The failed-load view's status, present only while that view is on screen.
  const failedStatus = useRef<HTMLParagraphElement>(null);
  // A refetch that fails keeps the portal up: only a first load with nothing to show is an error page.
  if (!bootstrap.data) return bootstrap.isError ? <div className="px-4 py-6 sm:px-6"><ErrorState onRetry={() => void bootstrap.refetch()} /></div> : <PortalLoading />;
  if (session?.roles.length) return <Navigate to="/admin" replace />;
  if (!session?.member) return <Navigate to="/login" replace />;
  // While the refetch after a change is pending, and after one that failed, the name is the previous household's (or an older
  // load's), so the generic label stands in until one succeeds.
  // The same holds for the one render in which the lists first name another household, before the effect above has marked it.
  const settledFor = userId === undefined ? undefined : readOpenHousehold(cache, userId);
  const changed = loaded && settledFor !== undefined && settledFor !== current;
  const person = sessionName(bootstrap.isRefetchError || nameStale || changed ? { displayName: null } : session);
  // A sign-out that fails says so on whichever view asked for it.
  const signOutError = signOut.isError && <Alert variant="error" focusOnReveal className="mb-4">{text('signOutFailed')}</Alert>;
  // A retry or a household choice puts that message away. A sign-out still being sent is left alone, so its failure is told.
  const clearSignOutError = () => { if (signOut.isError) signOut.reset(); };
  // The status is mounted with the view, so a sign-out sent from here is announced, and a retry waits for it. Empty, it takes no room.
  const failed = (retry: () => void) => <Page className="px-4 py-6 sm:px-6"><ErrorState message={text('failed')} onRetry={() => { clearSignOutError(); retry(); }} retryDisabled={signOut.isPending} /><Button onClick={() => signOut.mutate()} disabled={signOut.isPending}>{text('signOut')}</Button><p ref={failedStatus} role="status" className={signOut.isPending ? 'text-sm text-muted-foreground' : 'sr-only'}>{signOut.isPending && t('shell/shell:signingOut')}</p>{signOutError}</Page>;
  // A loading step keeps the portal layout while a sign-out is being sent or after it failed, so the account menu and its status
  // stay mounted and the failure is told above the loading state.
  const loading = () => signOut.isPending || signOut.isError
    ? <PortalLayout name={bootstrap.data!.gym.name} person={person} entries={[]} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending} account={!!current} failure={signOutError}><LoadingState /></PortalLayout>
    : <PortalLoading />;
  if (households.isPending || choose.isPending) return loading();
  // A list load that fails while the portal has lists to show keeps it up, like the bootstrap: every key follows the lists.
  if (households.isError && !households.data) return failed(() => void households.refetch());
  if (!current) {
    if (!households.data.households.length) return failed(() => void households.refetch());
    return <PortalLayout name={bootstrap.data.gym.name} person={person} entries={[]} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending} notices={<PortalRecoveryNotice />} failure={signOutError}>
      <HouseholdPicker households={households.data.households} onChoose={id => { clearSignOutError(); choose.mutate(id); }} pending={choose.isPending || signOut.isPending} failed={choose.isError} />
    </PortalLayout>;
  }
  if (!context.data) {
    // A context read that failed waits for the lists being read again. During a sign-out only a failed view already on
    // screen stays while the lists are read again, with its status. If the lists still name this household, it is an error.
    if (context.isPending || (households.isFetching && !(signOut.isPending && failedStatus.current))) return loading();
    return failed(() => { void households.refetch(); void context.refetch(); });
  }
  const switcher = households.data.households.length > 1
    ? <HouseholdSwitcher households={households.data.households} current={current} onChoose={id => { if (id !== current) { clearSignOutError(); choose.mutate(id); } }} disabled={choose.isPending || signOut.isPending} /> : undefined;
  const notices = <>
    {context.isError && !households.isFetching && <ErrorState message={text('failed')} onRetry={() => { clearSignOutError(); void households.refetch(); void context.refetch(); }} />}
    <PortalRecoveryNotice />
  </>;
  return <PortalLayout name={bootstrap.data.gym.name} person={person} scope={context.data.role} entries={portalNavigation(createRegistries().portalNav.all(), context.data.role, bootstrap.data.gym.enabledModules)} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending} switcher={switcher} notices={notices} failure={signOutError} account>
    {choose.isError && <Alert variant="error">{text('chooseFailed')}</Alert>}<Outlet key={current} />
  </PortalLayout>;
}
export function PortalShell() {
  const pathname = useRouterState({ select: state => state.location.pathname });
  return pathname === '/portal/claim' ? <Outlet /> : <AuthenticatedPortal />;
}
export { PortalHome } from './home.js';
