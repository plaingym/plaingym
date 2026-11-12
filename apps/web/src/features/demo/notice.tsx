// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { demoEntryResponse, demoMenuResponse, sandboxResponse, type DemoLoginTarget, type DemoRole } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { Dialog } from '../../components/ui/dialog.js';
import { LoadingState } from '../../components/ui/states.js';
import { saveToken } from '../kiosk/api.js';
import { ApiError, createJsonTransport } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { cn } from '../../lib/utils.js';
const request = createJsonTransport();
type DemoDiscovery = ReturnType<typeof demoEntryResponse.parse>['data'];
const DemoContext = createContext<DemoDiscovery | undefined>(undefined);
export const useDemoMode = () => useContext(DemoContext)?.mode;
/** Whether this sandbox takes test-card joins (the shared Stripe test account is configured). */
export const useDemoJoin = () => { const discovery = useContext(DemoContext); return discovery?.mode === 'sandbox' && discovery.join; };
export const useDemoSandbox = () => useDemoMode() === 'sandbox';
export function DemoShell({ children }: { children: ReactNode }) {
  // Capture before a child route's login guard can redirect and discard the fragment.
  const [kioskToken, setKioskToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('kioskToken'));
  const [tokenSaveFailed, setTokenSaveFailed] = useState(false);
  const discovery = useQuery({
    queryKey: ['demo', 'discovery', window.location.origin],
    // Let an in-flight discovery finish across a StrictMode/root remount, so it
    // can be shared by the next observer rather than cancelled and requested twice.
    queryFn: async () => parseResponse(demoEntryResponse, await request('/api/demo')),
    staleTime: Infinity, gcTime: Infinity, retry: false,
    refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const mode = discovery.data?.data;
  const expires = mode?.mode === 'sandbox' ? mode.expiresAt : undefined;
  const [expiredAt, setExpiredAt] = useState<string>();
  const login = useLoginState();
  const { refetch } = discovery;
  useEffect(() => {
    if (!expires) return;
    let checked = false;
    const checkExpiry = () => {
      if (checked || Date.parse(expires) > Date.now()) return;
      checked = true;
      setExpiredAt(expires);
      void refetch();
    };
    const timer = window.setTimeout(checkExpiry, Math.max(0, Date.parse(expires) - Date.now()));
    // Background tabs can throttle timers; recheck expiry when they return.
    window.addEventListener('focus', checkExpiry);
    window.addEventListener('online', checkExpiry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', checkExpiry);
      window.removeEventListener('online', checkExpiry);
    };
  }, [expires, refetch]);
  const expired = expires !== undefined && (expiredAt === expires || Date.parse(expires) <= Date.now());
  const activeSandbox = mode?.mode === 'sandbox' && !discovery.isError && !expired;
  useEffect(() => {
    if (!activeSandbox || !kioskToken) return;
    if (!saveToken(kioskToken)) { setTokenSaveFailed(true); return; }
    setTokenSaveFailed(false);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (fragment.has('kioskToken')) {
      fragment.delete('kioskToken');
      const remaining = fragment.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (remaining ? '#' + remaining : ''));
    }
    setKioskToken(null);
  }, [activeSandbox, kioskToken]);
  return <DemoContext.Provider value={discovery.isError || expired ? undefined : mode}><LoginContext.Provider value={login}>
    {tokenSaveFailed && <div className="p-4"><Alert role="alert">{t('kiosk/kiosk:setupSaveError')}</Alert></div>}
    {(discovery.isError || expired) && <div className="p-4" role="alert">
      <p>{t('demo/demo:error')}</p><Button type="button" onClick={() => { void refetch(); }}>{t('shell/shell:retry')}</Button>
    </div>}
    <DemoNotice /><DemoEntry />{kioskToken && (discovery.isPending || activeSandbox) ? (tokenSaveFailed ? null : <LoadingState />) : children}
  </LoginContext.Provider></DemoContext.Provider>;
}
export function DemoEntry() {
  return useContext(DemoContext)?.mode === 'entry' ? <aside aria-label={t('demo/demo:entryTitle')} className="border-b border-border bg-secondary p-4 sm:p-6">
    <div className="mx-auto flex max-w-4xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1"><p className="font-semibold">{t('demo/demo:entryTitle')}</p><p>{t('demo/demo:entryHelp')}</p></div><TryDemoButton />
    </div></aside> : null;
}
/** The sample household to search for at the kiosk. The kiosk shows it only on its Name and PIN search, and only in a sandbox. */
export function DemoKioskHint() {
  return useDemoSandbox() ? <div className="rounded-xl border border-border bg-secondary p-3 text-sm">
    <p className="font-semibold">{t('demo/demo:kioskTitle')}</p><p>{t('demo/demo:kioskHint')}</p>
  </div> : null;
}
/** Whom a sign-in control signs in as: a seeded role, or a member who joined in this sandbox (by the ID the demo menu lists). */
export type DemoSignInAs = DemoRole | { member: string };
interface DemoLogin {
  login(target: DemoSignInAs, destination?: `/admin/${string}`): Promise<void>;
  readonly pending: boolean; readonly error: boolean;
}
const LoginContext = createContext<DemoLogin | undefined>(undefined);
/** One-click sign-in as a sandbox identity. The shell shares one state, so every sign-in control waits for the same request. */
export function useDemoLogin(): DemoLogin {
  const local = useLoginState();
  return useContext(LoginContext) ?? local;
}
/** The page leaves for the login's home (or a page within the admin) on success. */
function useLoginState(): DemoLogin {
  const [error, setError] = useState(false), [pending, setPending] = useState(false);
  async function login(target: DemoSignInAs, destination?: `/admin/${string}`) {
    if (pending) return;
    setPending(true); setError(false);
    try {
      const body: DemoLoginTarget = typeof target === 'string' ? { role: target } : target;
      const result = await request<{ data: { redirect: '/admin' | '/portal' } }>('/api/demo/login', body);
      window.location.assign(destination && result.data.redirect === '/admin' ? destination : result.data.redirect);
    }
    catch { setError(true); setPending(false); }
  }
  return { login, pending, error };
}
/** The sandbox's joined members and whether its website is on. Fetched only where they are shown: the open menu and the start page. */
export function useDemoMenu(enabled = true) {
  const sandbox = useDemoSandbox();
  return useQuery({ queryKey: ['demo', 'menu'], enabled: sandbox && enabled, retry: false,
    queryFn: async ({ signal }) => parseResponse(demoMenuResponse, await request('/api/demo/menu', undefined, signal)).data });
}
/** The demo's one navigation style, in the menu and on the start page alike: a full-width link with a forward arrow. */
export function DemoMenuLink({ href, children, current = false }: { href: string; children: ReactNode; current?: boolean }) {
  return <a href={href} {...(current ? { 'aria-current': 'page' as const } : {})}
    className={cn('flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium',
      'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', current && 'bg-muted')}>
    <span className="min-w-0">{children}</span><span aria-hidden="true">→</span>
  </a>;
}
const roles = ['owner', 'coach', 'student'] as const;
/** The seeded roles and joined members as sign-in buttons, one style wherever they appear. */
export function DemoSignInButtons({ members = [], className }: { members?: readonly { id: string; name: string }[]; className?: string }) {
  const { login, pending } = useDemoLogin();
  return <div className={cn('grid gap-2', className)}>
    {roles.map((role) => <Button key={role} type="button" variant="outline" className="w-full justify-start" disabled={pending}
      aria-label={t(`demo/demo:${role}`)} onClick={() => { void login(role); }}>{t(`demo/demo:${role}Label`)}</Button>)}
    {members.map((member) => <Button key={member.id} type="button" variant="outline" className="w-full justify-start" disabled={pending}
      aria-label={t('demo/demo:member', { name: member.name })} onClick={() => { void login({ member: member.id }); }}>
      <span className="min-w-0 truncate">{member.name}</span></Button>)}
  </div>;
}
const shortTime = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
/** One slim row above every page of a sandbox: what this is, when it ends, and the demo menu. A role-login error shows in the row. */
export function DemoNotice() {
  const mode = useContext(DemoContext), expires = mode?.mode === 'sandbox' ? mode.expiresAt : undefined;
  const { error } = useDemoLogin(), [open, setOpen] = useState(false);
  if (!expires) return null;
  return <aside className="border-b border-border bg-secondary px-4" aria-label={t('demo/demo:controls')}>
    <div className="mx-auto flex min-h-11 max-w-6xl items-center justify-between gap-3">
      <p className="min-w-0 text-sm leading-tight"><span className="font-semibold">{t('demo/demo:sandbox')}</span>
        {' · '}<span className="text-muted-foreground">{t('demo/demo:barExpires', { time: shortTime(expires) })}</span></p>
      <Button type="button" variant="outline" size="sm" className="shrink-0 whitespace-nowrap" aria-haspopup="dialog" onClick={() => setOpen(true)}>{t('demo/demo:menu')}</Button>
    </div>
    {error && !open && <div className="mx-auto max-w-6xl pb-2"><Alert>{t('demo/demo:error')}</Alert></div>}
    {open && <DemoMenu expires={expires} onClose={() => setOpen(false)} />}
  </aside>;
}
/** The demo's navigation: a bottom sheet on phones and a side panel on wider screens, on the shared dialog. */
function DemoMenu({ expires, onClose }: { expires: string; onClose: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const menu = useDemoMenu(), join = useDemoJoin(), { error } = useDemoLogin();
  const within = (path: string) => pathname === path || pathname.startsWith(path + '/');
  const destinations: [string, string, boolean][] = [
    ['/demo', 'startPage', pathname === '/demo'], ['/admin', 'admin', within('/admin') && !within('/admin/outbox')], ['/portal', 'portal', within('/portal')],
    ['/kiosk', 'kiosk', within('/kiosk')], ...join ? [['/join', 'join', false] as [string, string, boolean]] : [],
    ...menu.data?.website ? [['/', 'website', false] as [string, string, boolean]] : [], ['/admin/outbox', 'outbox', within('/admin/outbox')],
  ];
  const section = 'space-y-2', heading = 'text-sm font-semibold text-muted-foreground';
  return <Dialog title={t('demo/demo:menu')} closeLabel={t('demo/demo:closeMenu')} onClose={onClose}
    className={cn('mt-auto h-auto max-h-[85dvh] rounded-t-xl border-t border-border',
      'sm:m-0 sm:ml-auto sm:h-dvh sm:max-h-none sm:w-96 sm:max-w-[calc(100%-2rem)] sm:rounded-none sm:rounded-l-xl sm:border-0 sm:border-l')}>
    <div className="space-y-6">
      <section className={section} aria-labelledby="demo-menu-sign-in"><h3 id="demo-menu-sign-in" className={heading}>{t('demo/demo:signInAs')}</h3>
        {error && <Alert>{t('demo/demo:error')}</Alert>}
        <DemoSignInButtons members={menu.data?.members ?? []} />
      </section>
      <nav className={section} aria-labelledby="demo-menu-go-to"><h3 id="demo-menu-go-to" className={heading}>{t('demo/demo:goTo')}</h3>
        <ul className="space-y-2">{destinations.map(([href, key, current]) => <li key={href}>
          <DemoMenuLink href={href} current={current}>{t(`demo/demo:${key}`)}</DemoMenuLink></li>)}</ul>
      </nav>
      <section className={section} aria-labelledby="demo-menu-about"><h3 id="demo-menu-about" className={heading}>{t('demo/demo:about')}</h3>
        <p className="text-sm">{t('demo/demo:expires', { time: new Date(expires).toLocaleString() })}</p>
        <p className="text-sm">{t('demo/demo:banner')}</p><p className="text-sm">{t('demo/demo:roleHelp')}</p>
      </section>
    </div>
  </Dialog>;
}
export function TryDemoButton({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void } = {}) {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const active = useRef(false), button = useRef<HTMLButtonElement>(null);
  async function start() {
    if (active.current) return;
    active.current = true;
    setPending(true); setError('');
    try {
      const { data } = parseResponse(sandboxResponse, await request('/api/demo/sandboxes', {}));
      // The sandbox's start page offers every role, the join walkthrough and the kiosk.
      const destination = new URL('/demo', data.origin);
      destination.hash = new URLSearchParams({ kioskToken: data.kioskToken }).toString();
      navigate(destination.href);
    } catch (error) {
      setError(t(error instanceof ApiError && error.status === 429 ? 'demo/demo:capacityError' : 'demo/demo:creationError'));
      active.current = false; setPending(false);
      button.current?.focus();
    }
  }
  return <div className="space-y-2 sm:max-w-sm"><Button ref={button} type="button" className="w-full" aria-disabled={pending} onClick={() => { void start(); }}>{t(pending ? 'demo/demo:starting' : error ? 'demo/demo:retryCreation' : 'demo/demo:try')}</Button>
    <div role="status" aria-live="polite" aria-atomic="true">{pending && <div className="flex items-start gap-2 rounded-lg border border-border bg-background p-3 text-sm">
      <span aria-hidden="true" className="mt-0.5 size-5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />
      <p>{t('demo/demo:creationProgress')}</p>
    </div>}</div>{error && <Alert>{error}</Alert>}</div>;
}
