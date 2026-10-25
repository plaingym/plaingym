// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { demoEntryResponse } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { createJsonTransport } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
const request = createJsonTransport();
type DemoDiscovery = ReturnType<typeof demoEntryResponse.parse>['data'];
const DemoContext = createContext<DemoDiscovery | undefined>(undefined);
export const useDemoSandbox = () => useContext(DemoContext)?.mode === 'sandbox';
export function DemoShell({ children }: { children: ReactNode }) {
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
  return <DemoContext.Provider value={discovery.isError || expired ? undefined : mode}>
    {(discovery.isError || expired) && <div className="p-4" role="alert">
      <p>{t('demo/demo:error')}</p><Button type="button" onClick={() => { void refetch(); }}>{t('shell/shell:retry')}</Button>
    </div>}
    <DemoNotice /><DemoEntry />{children}
  </DemoContext.Provider>;
}
export function DemoEntry() {
  return useContext(DemoContext)?.mode === 'entry' ? <div className="p-6"><TryDemoButton /></div> : null;
}
/** The root shares discovery with every demo control and sandbox consumer. */
export function DemoNotice() {
  const mode = useContext(DemoContext), expires = mode?.mode === 'sandbox' ? mode.expiresAt : undefined;
  const [error, setError] = useState(false);
  if (!expires) return null;
  async function login(role: 'owner' | 'coach' | 'student') {
    setError(false);
    try { const result = await request<{ data: { redirect: '/admin' | '/portal' } }>('/api/demo/login', { role }); window.location.assign(result.data.redirect); }
    catch { setError(true); }
  }
  return <aside className="space-y-2 border-b bg-amber-50 p-4 text-slate-900" aria-label={t('demo/demo:title')}>
    <p>{t('demo/demo:banner')}</p><p>{t('demo/demo:expires', { time: new Date(expires).toLocaleString() })}</p>
    <div className="flex flex-wrap gap-2">{(['owner', 'coach', 'student'] as const).map((role) => <Button key={role} type="button" variant="outline" onClick={() => { void login(role); }}>{t(`demo/demo:${role}`)}</Button>)}</div>
    <a className="underline" href="/admin/outbox">{t('demo/demo:title')}</a>
    {error && <p role="alert">{t('demo/demo:error')}</p>}
  </aside>;
}
export function TryDemoButton() {
  const [pending, setPending] = useState(false), [error, setError] = useState(false);
  async function start() {
    setPending(true); setError(false);
    try {
      const response = await request<{ data: { origin: string } }>('/api/demo/sandboxes', {});
      window.location.assign(new URL('/admin', response.data.origin).href);
    } catch { setError(true); setPending(false); }
  }
  return <div><Button type="button" disabled={pending} onClick={() => { void start(); }}>{t(pending ? 'demo/demo:starting' : 'demo/demo:try')}</Button>{error && <p role="alert">{t('demo/demo:error')}</p>}</div>;
}
