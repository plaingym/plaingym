// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { t } from '../../lib/i18n.js';
import { useBootstrap } from '../../app/context.js';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { QrRequestError, staffCheckinCode } from './qr.api.js';

const text = (key: string) => t('kiosk/qr:' + key);
export function CheckinCodePanel({ gymId, memberId }: { gymId: string; memberId: string }) {
  const cache = useQueryClient(), key = ['checkin-code', gymId, memberId];
  const data = useQuery({ queryKey: key, queryFn: () => staffCheckinCode(memberId), staleTime: 0, gcTime: 0 });
  const [action, setAction] = useState<'regenerate' | 'revoke'>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [image, setImage] = useState<{ code: string; url: string }>();
  const locked = useRef(false), code = data.data?.code;
  useEffect(() => {
    let active = true; setImage(undefined);
    if (code) void QRCode.toDataURL(code, { width: 256, margin: 4, errorCorrectionLevel: 'M' })
      .then((url) => { if (active) setImage({ code, url }); }).catch(() => { if (active) setError('requestError'); });
    return () => { active = false; };
  }, [code]);
  async function mutate() {
    if (!action || !data.data || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const saved = await staffCheckinCode(memberId, action, data.data.revision);
      cache.setQueryData(key, saved); setAction(undefined);
      await cache.invalidateQueries({ queryKey: ['members', gymId] });
    } catch (cause) {
      setError(cause instanceof QrRequestError && cause.status === 409 ? 'conflict' : 'requestError');
      // A stale revision must be re-read before another reset can be attempted.
      await data.refetch();
    } finally { locked.current = false; setBusy(false); }
  }
  return <section className="min-w-0 space-y-4" aria-label={text('title')}>
    <h2 className="text-lg font-semibold">{text('title')}</h2><p>{text('staffHelp')}</p>
    {data.isPending && <p role="status">{text('loading')}</p>}
    {data.isError && <Alert role="alert">{text('requestError')} <Button variant="outline" onClick={() => void data.refetch()}>{text('retry')}</Button></Alert>}
    {data.data && <>
      {code ? image?.code === code && <img src={image.url} width="256" height="256" alt={text('codeImage')} className="mx-auto h-auto w-full max-w-64"/> : <p>{text('inactiveCode')}</p>}
      <div className="flex flex-col gap-3 sm:flex-row"><Button disabled={busy} onClick={() => { setError(''); setAction('regenerate'); }}>{text(code ? 'regenerate' : 'create')}</Button>
        {code && <Button variant="outline" disabled={busy} onClick={() => { setError(''); setAction('revoke'); }}>{text('revoke')}</Button>}</div>
    </>}
    {action && <Dialog title={text(action === 'regenerate' ? 'confirmRegenerate' : 'confirmRevoke')} closeLabel={text('cancel')} onClose={() => setAction(undefined)} dismissible={!busy}>
      <div className="space-y-4"><p>{text('revokeWarning')}</p>{error && <Alert role="alert">{text(error)}</Alert>}
        <div className="flex flex-col gap-3 sm:flex-row"><Button disabled={busy} onClick={() => void mutate()}>{text(busy ? 'saving' : 'confirm')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setAction(undefined)}>{text('cancel')}</Button></div></div>
    </Dialog>}
  </section>;
}
export function CheckinCodeTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap();
  return memberId && bootstrap.data ? <CheckinCodePanel key={bootstrap.data.gym.id + ':' + memberId} gymId={bootstrap.data.gym.id} memberId={memberId}/> : null;
}
