// SPDX-License-Identifier: AGPL-3.0-only
import { PortalRecovery } from '../household/recovery.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qrDataUrl } from '../../../lib/qr.js';
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
  const url = useMemo(() => { try { return qrDataUrl(code); } catch { return null; } }, [code]);
  if (!url) return <Alert variant="error" role="alert">{text('drawError')}</Alert>;
  return <img src={url} width="288" height="288" alt={text('codeImage', { name })} className="mx-auto h-auto w-full max-w-72 rounded-lg bg-white p-2" />;
}
export function PortalCheckinPage({ client = portalClient }: { client?: PortalClient }) {
  const cache = useQueryClient(), { scope, members, memberId, member, choose } = usePortalMembers(client);
  const code = useQuery({ queryKey: [...scope.key, 'checkin-code', memberId], queryFn: async () => scope.own(await scope.run(() => client.checkinCode(memberId, scope.key[4]!))).data, enabled: !!memberId, staleTime: 0, gcTime: 0, retry: false });
  // The member the open confirmation is for.
  const [confirming, setConfirming] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // The members whose code is being read again after a replacement or a creation failed.
  const [rereading, setRereading] = useState<ReadonlySet<string>>(() => new Set());
  const waiting = rereading.has(memberId);
  const locked = useRef(false), selected = useRef(memberId);
  selected.current = memberId;
  // A failure is told only on its own member's page. It is cleared during the render that moves to another one, so that it is
  // never drawn there, or given focus.
  const [shown, setShown] = useState(memberId);
  if (shown !== memberId) { setShown(memberId); setError(''); }
  // The page can move to another member by itself, when a list read drops the chosen one. The confirmation closes then; while
  // a replacement is being sent, it waits for the answer.
  useEffect(() => { if (confirming !== null && confirming !== memberId && !busy) setConfirming(null); }, [confirming, memberId, busy]);
  async function regenerate() {
    if (!code.data || code.isError || rereading.has(memberId) || locked.current) return;
    const id = memberId, creating = !code.data.code;
    locked.current = true; setBusy(true); setError('');
    try {
      // A code regenerated in another household than this page's is never shown.
      cache.setQueryData([...scope.key, 'checkin-code', id], scope.own(await scope.run(() => client.regenerateCheckin(id, code.data!.revision, scope.key[4]!))).data);
      setConfirming(null);
    } catch (cause) {
      // The member can be changed while a first code is being created, or leave the list while a replacement is being sent.
      // Nothing is then said about the failure on the other member's page, a confirmation left open is closed so that it can't
      // replace that member's code, and the failed member's code is dropped, so it is read afresh when shown again.
      if (selected.current !== id) { setConfirming(null); cache.removeQueries({ queryKey: [...scope.key, 'checkin-code', id], exact: true }); return; }
      setError(cause instanceof ApiError && cause.status === 409 ? 'conflict' : creating ? 'createError' : 'replaceError');
      // A stale revision must be read again before another attempt for this member. The read waits while offline, so only that
      // attempt waits for it: the dialog can be closed meanwhile. A read that fails leaves the query in error, which also waits.
      setRereading(current => new Set(current).add(id));
      void code.refetch().finally(() => setRereading(current => { const next = new Set(current); next.delete(id); return next; }));
    } finally { locked.current = false; setBusy(false); }
  }
  if (!members.data) return members.isPending || scope.settling ? <LoadingState /> : <ErrorState message={text('error')} onRetry={() => void members.refetch()} />;
  const active = code.data?.code;
  // Until the code has been read again, no message may say the latest one is shown.
  const unread = waiting || code.isError;
  const errorText = error && text(error === 'conflict' && unread ? 'conflictReading' : error);
  return <Page className="max-w-3xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text('title')} description={text('description')} />
    <MemberPicker label={text('member')} members={members.data} value={memberId} onChange={id => { setError(''); setConfirming(null); choose(id); }} />
    {code.isPending || (!code.data && scope.settling) ? <LoadingState label={text('loading')} />
      : code.isError ? <ErrorState message={text(code.error instanceof ApiError && code.error.status === 503 ? 'unavailable' : 'error')} onRetry={() => void code.refetch()} />
        : <section className="space-y-4" aria-label={text('codeFor', { name: member?.name ?? '' })}>
          {member && members.data.length > 1 && <h2 className="text-lg font-semibold">{member.name}</h2>}
          {active ? waiting ? <Alert>{text('rereading')}</Alert>
            : <><CodeImage code={active} name={member?.name ?? ''} /><p className="text-center text-sm text-muted-foreground">{text('help')}</p></>
            : <Alert>{text(waiting ? 'createRereading' : 'inactive')}</Alert>}
          {error && confirming !== memberId && <Alert variant="error" focusOnReveal role="alert">{errorText}</Alert>}
          <Button variant={active ? 'outline' : 'default'} className="w-full sm:w-auto" disabled={busy || waiting} onClick={() => { setError(''); if (active) setConfirming(memberId); else void regenerate(); }}>
            {text(active ? 'regenerate' : 'create')}</Button>
        </section>}
    {confirming !== null && confirming === memberId && <Dialog title={text('confirmTitle')} closeLabel={text('keep')} onClose={() => setConfirming(null)} dismissible={!busy}>
      <div className="space-y-4"><p>{text('confirmBody')}</p>{error && <Alert variant="error" focusOnReveal role="alert">{errorText}</Alert>}
        {unread && <p className="text-sm text-muted-foreground">{text('waiting')}</p>}
        {/* The dialog covers the page's own retry. */}
        {code.isError && <Button variant="outline" className="w-full sm:w-auto" disabled={code.isFetching} onClick={() => void code.refetch()}>{text('retry')}</Button>}
        <div className="flex flex-col gap-3 sm:flex-row"><Button disabled={busy || unread} onClick={() => void regenerate()}>{text(busy ? 'saving' : 'confirm')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>{text('keep')}</Button></div></div>
    </Dialog>}
  </PortalRecovery></Page>;
}
/** The registered portal page, with the production client. */
export function PortalCheckinView() { return <PortalCheckinPage />; }
