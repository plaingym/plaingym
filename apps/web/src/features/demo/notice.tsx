// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { demoEntryResponse, sandboxResponse } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { Dialog } from '../../components/ui/dialog.js';
import { LoadingState } from '../../components/ui/states.js';
import { saveToken } from '../kiosk/api.js';
import { ApiError, createJsonTransport } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
const request = createJsonTransport();
type DemoDiscovery = ReturnType<typeof demoEntryResponse.parse>['data'];
const DemoContext = createContext<DemoDiscovery | undefined>(undefined);
export const useDemoMode = () => useContext(DemoContext)?.mode;
export const useDemoSandbox = () => useDemoMode() === 'sandbox';
export function DemoShell({ children }: { children: ReactNode }) {
  // Capture before a child route's login guard can redirect and discard the fragment.
  const [kioskToken, setKioskToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('kioskToken'));
  const discovery = useQuery({
    queryKey: ['demo', 'discovery', window.location.origin],
    // Let an in-flight discovery finish across a StrictMode/root remount, so it
    // can be shared by the next observer rather than cancelled and requested twice.
    queryFn: async () => demoEntryResponse.parse(await request('/api/demo')),
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
    saveToken(kioskToken);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (fragment.has('kioskToken')) {
      fragment.delete('kioskToken');
      const remaining = fragment.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (remaining ? '#' + remaining : ''));
    }
    setKioskToken(null);
  }, [activeSandbox, kioskToken]);
  return <DemoContext.Provider value={discovery.isError || expired ? undefined : mode}><LoginContext.Provider value={login}>
    {(discovery.isError || expired) && <div className="p-4" role="alert">
      <p>{t('demo/demo:error')}</p><Button type="button" onClick={() => { void refetch(); }}>{t('shell/shell:retry')}</Button>
    </div>}
    <DemoNotice /><DemoEntry />{kioskToken && (discovery.isPending || activeSandbox) ? <LoadingState /> : children}
  </LoginContext.Provider></DemoContext.Provider>;
}
export function DemoEntry() {
  return useContext(DemoContext)?.mode === 'entry' ? <aside aria-label={t('demo/demo:entryTitle')} className="border-b border-border bg-secondary p-4 sm:p-6">
    <div className="mx-auto flex max-w-4xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1"><p className="font-semibold">{t('demo/demo:entryTitle')}</p><p>{t('demo/demo:entryHelp')}</p></div><TryDemoButton />
    </div></aside> : null;
}
/** Uses the root's discovery result; ordinary installs never fetch demo status. */
export function DemoKioskHint() {
  return useDemoSandbox() ? <div className="rounded-xl border border-border bg-secondary p-3 text-sm">
    <p className="font-semibold">{t('demo/demo:kioskTitle')}</p><p>{t('demo/demo:kioskHint')}</p>
  </div> : null;
}
interface DemoLogin {
  login(role: 'owner' | 'coach' | 'student', destination?: `/admin/${string}`): Promise<void>;
  readonly pending: boolean; readonly error: boolean;
}
const LoginContext = createContext<DemoLogin | undefined>(undefined);
/** One-click sign-in as a sandbox identity. The shell shares one state, so every sign-in control waits for the same request. */
export function useDemoLogin(): DemoLogin {
  const local = useLoginState();
  return useContext(LoginContext) ?? local;
}
/** The page leaves for the role's home (or a page within it) on success. */
function useLoginState(): DemoLogin {
  const [error, setError] = useState(false), [pending, setPending] = useState(false);
  async function login(role: 'owner' | 'coach' | 'student', destination?: `/admin/${string}`) {
    if (pending) return;
    setPending(true); setError(false);
    try {
      const result = await request<{ data: { redirect: '/admin' | '/portal' } }>('/api/demo/login', { role });
      window.location.assign(destination && result.data.redirect === '/admin' ? destination : result.data.redirect);
    }
    catch { setError(true); setPending(false); }
  }
  return { login, pending, error };
}
/** The root shares discovery with every demo control and sandbox consumer. */
export function DemoNotice() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const atKiosk = pathname === '/kiosk' || pathname.startsWith('/kiosk/');
  const mode = useContext(DemoContext), expires = mode?.mode === 'sandbox' ? mode.expiresAt : undefined;
  const { login, pending, error } = useDemoLogin(), [help, setHelp] = useState(false);
  if (!expires) return null;
  return <aside className="border-b border-border bg-secondary px-4 py-3" aria-label={t('demo/demo:controls')}>
    <div className="mx-auto max-w-6xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{t('demo/demo:sandbox')}</p>
        <Button type="button" variant="outline" onClick={() => setHelp(true)}>{t('demo/demo:guide')}</Button></div>
      <div role="group" aria-label={t('demo/demo:roles')} className="grid grid-cols-3 gap-2 sm:max-w-md">
        {(['owner', 'coach', 'student'] as const).map((role) => <Button key={role} type="button" variant="outline" className="min-w-0 px-2" disabled={pending}
          aria-label={t(`demo/demo:${role}`)} onClick={() => { void login(role); }}>{t(`demo/demo:${role}Label`)}</Button>)}
      </div>
      <div className="flex flex-col gap-1 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
        {pathname !== '/demo' && <a className="inline-flex min-h-11 items-center underline" href="/demo">{t('demo/landing:startLink')}</a>}
        {!atKiosk && <><a className="inline-flex min-h-11 items-center underline" href="/kiosk">{t('demo/demo:kioskTitle')}</a>
          <p>{t('demo/demo:kioskHint')}</p></>}
        <p className="text-muted-foreground">{t('demo/demo:expires', { time: new Date(expires).toLocaleString() })}</p>
      </div>
      {error && <Alert>{t('demo/demo:error')}</Alert>}
    </div>
    {help && <Dialog title={t('demo/demo:guide')} closeLabel={t('demo/demo:close')} onClose={() => setHelp(false)}>
      <div className="space-y-4"><p>{t('demo/demo:banner')}</p><p>{t('demo/demo:roleHelp')}</p>{!atKiosk && <DemoKioskHint />}
        <a className="inline-flex min-h-11 items-center underline" href="/admin/outbox">{t('demo/demo:title')}</a>
        <Button type="button" className="w-full" onClick={() => setHelp(false)}>{t('demo/demo:explore')}</Button>
      </div>
    </Dialog>}
  </aside>;
}
export function TryDemoButton({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void } = {}) {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const active = useRef(false), button = useRef<HTMLButtonElement>(null);
  async function start() {
    if (active.current) return;
    active.current = true;
    setPending(true); setError('');
    try {
      const { data } = sandboxResponse.parse(await request('/api/demo/sandboxes', {}));
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
