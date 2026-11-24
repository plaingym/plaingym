// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { demoCopyPage, demoCreationResponse, demoRoleSchema, shellBootstrapResponseSchema } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { Dialog } from '../../components/ui/dialog.js';
import { ApiError, createJsonTransport, onApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

const request = createJsonTransport();
export function rememberDemoRole(role: string) {
  try { sessionStorage.setItem('demo-role', role); } catch { /* A copy can still open as the owner. */ }
}
async function copyTarget(signal: AbortSignal) {
  let saved: string | null = null;
  try { saved = sessionStorage.getItem('demo-role'); } catch { /* Storage is optional. */ }
  let role = demoRoleSchema.safeParse(saved).data ?? 'owner';
  try {
    const { session } = shellBootstrapResponseSchema.parse(await request('/api/auth/bootstrap', undefined, signal)).data;
    if (session?.roles.includes('owner') || session?.roles.includes('admin')) role = 'owner';
    else if (session?.roles.includes('coach')) role = 'coach';
    else if (session?.member) role = 'student';
  } catch { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); }
  return { role, page: demoCopyPage.safeParse(location.pathname.replace(/\/$/, '') || '/').data ?? (role === 'student' ? '/portal' : '/admin') };
}
/** Shared API errors carry structured refusal reasons; the browser transport stays untouched. */
export function CopyPrompt({ showcase }: { showcase: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!showcase) return;
    return onApiError(error => {
      if (error.status === 403 && error.reason.includes('demo_showcase_read_only')) setOpen(true);
    });
  }, [showcase]);
  return open ? <Dialog title={t('demo/demo:sharedTitle')} closeLabel={t('demo/demo:closeMenu')} onClose={() => setOpen(false)}>
    <div className="space-y-4"><p>{t('demo/demo:copyHelp')}</p><CreateCopyButton /></div>
  </Dialog> : null;
}
type CopyError = { key: 'demo/demo:copyLimitError'; minutes: number } |
  { key: 'demo/demo:capacityError' | 'demo/demo:creationError'; minutes?: never };

export function CreateCopyButton({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void } = {}) {
  const [pending, setPending] = useState(false), [position, setPosition] = useState<number>();
  const [error, setError] = useState<CopyError>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function copy() {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setPending(true); setError(undefined);
    let retryAfter = '', copyLimited = false;
    const createCopy = createJsonTransport(async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 429) {
        retryAfter = response.headers.get('Retry-After') ?? '';
        try {
          const body = await response.clone().json() as { error?: { details?: { reason?: unknown } } };
          const reason = body?.error?.details?.reason;
          copyLimited = Array.isArray(reason) && reason.includes('demo_copy_limit');
        } catch {
          copyLimited = false;
        }
      }
      return response;
    });
    try {
      const target = await copyTarget(abort.signal);
      let data = demoCreationResponse.parse(await createCopy('/api/demo/sandboxes', target, abort.signal)).data;
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
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 429) {
        const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
        setError(copyLimited && Number.isSafeInteger(seconds) && seconds >= 1
          ? { key: 'demo/demo:copyLimitError', minutes: Math.max(1, Math.ceil(seconds / 60)) }
          : { key: 'demo/demo:capacityError' });
      } else {
        setError({ key: 'demo/demo:creationError' });
      }
      setPending(false);
      controller.current = null;
    }
  }
  return <div className="space-y-2"><Button type="button" disabled={pending} className="min-h-11 w-full sm:w-auto" onClick={() => { void copy(); }}>{t(pending ? 'demo/demo:starting' : 'demo/demo:copy')}</Button>
    <p role="status" aria-live="polite">{pending && t(position ? 'demo/demo:queuePosition' : 'demo/demo:creationProgress', position ? { position } : {})}</p>
    {error && <Alert variant="error">{t(error.key, error.minutes === undefined ? {} : { minutes: error.minutes })}</Alert>}
  </div>;
}
