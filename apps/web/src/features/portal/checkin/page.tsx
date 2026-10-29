// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { renderSVG } from 'uqr';
import { ApiError } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader } from '../../../components/ui/page.js';
import { portalClient, type PortalClient } from '../schedule/client.js';
import { MemberPicker, usePortalMembers } from '../schedule/members.js';

const text = (key: string, values?: Record<string, string>) => t('portal/checkin:' + key, values);
/** The code is derived on the server and only ever shown, never stored by the browser or service worker. */
function CodeImage({ code, name }: { code: string; name: string }) {
  const url = useMemo(() => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderSVG(code, { ecc: 'M', border: 4 })), [code]);
  return <img src={url} width="288" height="288" alt={text('codeImage', { name })} className="mx-auto h-auto w-full max-w-72 rounded-lg bg-white p-2" />;
}
export function PortalCheckinPage({ client = portalClient }: { client?: PortalClient }) {
  const cache = useQueryClient(), { key, members, memberId, member, choose } = usePortalMembers(client);
  const codeKey = [...key, 'checkin-code', memberId];
  const code = useQuery({ queryKey: codeKey, queryFn: () => client.checkinCode(memberId), enabled: !!memberId, staleTime: 0, gcTime: 0, retry: false });
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false);
  async function regenerate() {
    if (!code.data || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      cache.setQueryData(codeKey, await client.regenerateCheckin(memberId, code.data.revision));
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? 'conflict' : 'error');
      // A stale revision must be read again before another attempt.
      await code.refetch();
    } finally { locked.current = false; setBusy(false); }
  }
  if (members.isPending) return <LoadingState />;
  if (members.isError) return <ErrorState message={text('error')} onRetry={() => void members.refetch()} />;
  const active = code.data?.code;
  return <Page className="max-w-xl">
    <PageHeader title={text('title')} description={text('description')} />
    <MemberPicker label={text('member')} members={members.data} value={memberId} onChange={id => { setError(''); setConfirming(false); choose(id); }} />
    {code.isPending ? <LoadingState label={text('loading')} />
      : code.isError ? <ErrorState message={text(code.error instanceof ApiError && code.error.status === 503 ? 'unavailable' : 'error')} onRetry={() => void code.refetch()} />
        : <section className="space-y-4" aria-label={text('codeFor', { name: member?.name ?? '' })}>
          {member && members.data.length > 1 && <h2 className="break-words text-lg font-semibold">{member.name}</h2>}
          {active ? <><CodeImage code={active} name={member?.name ?? ''} /><p className="text-center text-sm text-muted-foreground">{text('help')}</p></>
            : <Alert>{text('inactive')}</Alert>}
          {error && !confirming && <Alert role="alert">{text(error)}</Alert>}
          <Button variant={active ? 'outline' : 'default'} className="w-full sm:w-auto" disabled={busy} onClick={() => { setError(''); if (active) setConfirming(true); else void regenerate(); }}>
            {text(active ? 'regenerate' : 'create')}</Button>
        </section>}
    {confirming && <Dialog title={text('confirmTitle')} closeLabel={text('keep')} onClose={() => setConfirming(false)} dismissible={!busy}>
      <div className="space-y-4"><p>{text('confirmBody')}</p>{error && <Alert role="alert">{text(error)}</Alert>}
        <div className="flex flex-col gap-3 sm:flex-row"><Button disabled={busy} onClick={() => void regenerate()}>{text(busy ? 'saving' : 'confirm')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>{text('keep')}</Button></div></div>
    </Dialog>}
  </Page>;
}
/** The registered portal page, with the production client. */
export function PortalCheckinView() { return <PortalCheckinPage />; }
