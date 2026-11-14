// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { demoCopyPage, demoCreationResponse, demoRoleSchema } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { Dialog } from '../../components/ui/dialog.js';
import { createJsonTransport } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

const request = createJsonTransport();
export function rememberDemoRole(role: string) {
  try { sessionStorage.setItem('demo-role', role); } catch { /* A copy can still open as the owner. */ }
}
function copyTarget() {
  let saved: string | null = null;
  try { saved = sessionStorage.getItem('demo-role'); } catch { /* Storage is optional. */ }
  const role = demoRoleSchema.safeParse(saved).data ?? 'owner';
  return { role, page: demoCopyPage.safeParse(location.pathname.replace(/\/$/, '') || '/').data ?? (role === 'student' ? '/portal' : '/admin') };
}
/** All browser API clients use the current fetch; observe only this specific refusal and leave their response intact. */
export function CopyPrompt({ showcase }: { showcase: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!showcase) return;
    const original = window.fetch;
    const observing: typeof fetch = async (...args) => {
      const response = await original(...args);
      if (response.status === 403) {
        const body = await response.clone().json().catch(() => undefined) as { error?: { code?: string; details?: { reason?: string[] } } } | undefined;
        if (body?.error?.code === 'forbidden' && body.error.details?.reason?.includes('demo_showcase_read_only')) setOpen(true);
      }
      return response;
    };
    window.fetch = observing;
    return () => { if (window.fetch === observing) window.fetch = original; };
  }, [showcase]);
  return open ? <Dialog title={t('demo/demo:sharedTitle')} closeLabel={t('demo/demo:closeMenu')} onClose={() => setOpen(false)}>
    <div className="space-y-4"><p>{t('demo/demo:copyHelp')}</p><CreateCopyButton /></div>
  </Dialog> : null;
}
export function CreateCopyButton({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void } = {}) {
  const [pending, setPending] = useState(false), [position, setPosition] = useState<number>(), [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function copy() {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setPending(true); setError(false);
    try {
      let data = demoCreationResponse.parse(await request('/api/demo/sandboxes', copyTarget(), abort.signal)).data;
      // A queue ticket remains on this origin. Polling never consumes the client creation budget.
      const deadline = Date.now() + 3_600_000;
      while ('pending' in data) {
        const queued = data;
        if (Date.now() >= deadline) throw new Error('Creation timed out');
        setPosition(data.position);
        await new Promise<void>((resolve, reject) => {
          const stop = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
          const timer = window.setTimeout(() => { abort.signal.removeEventListener('abort', stop); resolve(); }, queued.retryAfterSeconds * 1000);
          abort.signal.addEventListener('abort', stop, { once: true });
        });
        data = demoCreationResponse.parse(await request('/api/demo/creations/' + data.ticket, undefined, abort.signal)).data;
      }
      const destination = new URL('/demo', data.origin);
      destination.hash = new URLSearchParams(data.handoffToken ? { copyToken: data.handoffToken } : { kioskToken: data.kioskToken }).toString();
      navigate(destination.href);
    } catch {
      if (!abort.signal.aborted) { setError(true); setPending(false); controller.current = null; }
    }
  }
  return <div className="space-y-2"><Button type="button" disabled={pending} className="min-h-11 w-full sm:w-auto" onClick={() => { void copy(); }}>{t(pending ? 'demo/demo:starting' : 'demo/demo:copy')}</Button>
    <p role="status" aria-live="polite">{pending && t(position ? 'demo/demo:queuePosition' : 'demo/demo:creationProgress', position ? { position } : {})}</p>
    {error && <Alert variant="error">{t('demo/demo:creationError')}</Alert>}
  </div>;
}
