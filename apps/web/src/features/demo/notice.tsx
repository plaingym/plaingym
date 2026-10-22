// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { createJsonTransport } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
const request = createJsonTransport();
/** Mount in the shell; a normal gym's 404 leaves no demo controls visible. */
export function DemoNotice() {
  const [expires, setExpires] = useState<string | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void request<{ data: { expiresAt: string } }>('/api/demo/status', undefined, abort.signal)
      .then((response) => setExpires(response.data.expiresAt)).catch(() => {});
    return () => abort.abort();
  }, []);
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
