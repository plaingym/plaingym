// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KioskCheckinResult } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { KioskAuthError } from './api.js';
import { playTone } from './feedback.js';
import { qrCheckin } from './qr.api.js';
import { scanQrCamera, type CameraScan } from './qr.scanner.js';

const text = (key: string) => t('kiosk/qr:' + key);
const big = 'h-auto min-h-12 whitespace-normal break-words p-3 text-lg sm:min-h-16 sm:text-xl';
/** Mount alongside name/PIN check-in; its device token grants only check-in endpoints. */
export function QrCheckin({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [open, setOpen] = useState(false), [scanning, setScanning] = useState(false), [busy, setBusy] = useState(false), [result, setResult] = useState<KioskCheckinResult>(), [message, setMessage] = useState('');
  const video = useRef<HTMLVideoElement>(null), camera = useRef<CameraScan | undefined>(undefined);
  const code = useRef<string | undefined>(undefined), generation = useRef(0), pending = useRef<number | undefined>(undefined);
  const reset = useCallback(() => {
    generation.current++; camera.current?.stop(); camera.current = undefined; code.current = undefined;
    setOpen(false); setScanning(false); setBusy(false); setResult(undefined); setMessage('');
  }, []);
  const submit = useCallback(async (value: string, sessionId?: string | null) => {
    if (pending.current === generation.current) return;
    const started = generation.current; pending.current = started; setBusy(true);
    try {
      const response = await qrCheckin(token, value, sessionId);
      if (started !== generation.current) return;
      setResult(response); setMessage('');
      playTone(response.status === 'see_front_desk' ? 'attention' : response.status === 'select_session' ? 'attention' : 'success');
      if (response.status !== 'select_session') code.current = undefined;
    } catch (error) {
      if (started !== generation.current) return;
      code.current = undefined;
      if (error instanceof KioskAuthError) { reset(); onUnauthorized(); }
      else setMessage('requestError');
    } finally { if (pending.current === started) { pending.current = undefined; setBusy(false); } }
  }, [token, onUnauthorized, reset]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(reset, result && result.status !== 'select_session' ? 8_000 : 60_000);
    return () => clearTimeout(timer);
  }, [open, result, reset]);
  useEffect(() => {
    if (!scanning || !video.current) return;
    let cancelled = false;
    const started = generation.current;
    void scanQrCamera(video.current, (value) => {
      if (cancelled || started !== generation.current) return;
      code.current = value; setScanning(false); void submit(value);
    }, () => { if (!cancelled) { setScanning(false); setMessage('cameraError'); } }).then((active) => {
      if (cancelled) active.stop(); else camera.current = active;
    }).catch(() => { if (!cancelled) { setScanning(false); setMessage('cameraError'); } });
    return () => { cancelled = true; camera.current?.stop(); camera.current = undefined; };
  }, [scanning, submit]);
  useEffect(() => () => { generation.current++; camera.current?.stop(); code.current = undefined; }, []);
  if (!open) return <Button variant="outline" className={big + ' w-full'} onClick={() => { setOpen(true); setScanning(true); }}>{text('scan')}</Button>;
  return <section className="min-w-0 space-y-4 rounded-xl border p-4 sm:p-6" aria-label={text('scan')} aria-busy={busy}>
    <h2 className="text-xl font-semibold sm:text-2xl">{text('scan')}</h2>
    {scanning && <><p>{text('cameraHelp')}</p><video ref={video} aria-label={text('camera')} muted playsInline className="aspect-[4/3] w-full rounded-lg bg-muted object-cover"/></>}
    {!scanning && !result && !message && <p role="status">{text('checking')}</p>}
    {message && <Alert role="status">{text(message)}</Alert>}
    {result && <div aria-live="polite" className="space-y-4">
      {result.status !== 'see_front_desk' && <p className="break-words text-2xl">{result.member.firstName} {result.member.lastInitial}.</p>}
      <p className="text-xl font-semibold">{text(result.status)}</p>
      {result.status === 'select_session' && <div className="grid gap-3 sm:grid-cols-2">{result.sessions.map((session) =>
        <Button className={big} disabled={busy} key={session.id} onClick={() => { if (code.current) void submit(code.current, session.id); }}>{session.name} · {new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(session.startsAt))}</Button>)}
        <Button variant="outline" className={big} disabled={busy} onClick={() => { if (code.current) void submit(code.current, null); }}>{text('openMat')}</Button>
      </div>}
    </div>}
    <Button variant="outline" className={big + ' w-full'} onClick={reset}>{text('done')}</Button>
  </section>;
}
