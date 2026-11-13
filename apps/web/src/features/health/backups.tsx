// SPDX-License-Identifier: AGPL-3.0-only
import { instantLabel } from '../../lib/instant.js';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backupControlContracts, backupControlResponseSchema } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { parseResponse } from '../../lib/response.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { CheckboxField } from '../../components/ui/select.js';
import { Dialog } from '../../components/ui/dialog.js';

const label = (key: string, values?: Record<string, string | number>) => t('health/backups:' + key, values);
/** Shared by Settings and the Last backup tile; cache and pending requests belong to this gym. */
export function BackupActions({ gymId, owner, onConfirmed }: { gymId: string; owner: boolean; onConfirmed?: () => void }) {
  const cache = useQueryClient(), key = ['health', gymId, 'backups'];
  const [confirming, setConfirming] = useState<number | null>(null), [checked, setChecked] = useState(false);
  // Retain the ID across an uncertain response: retrying the same click must not take another snapshot.
  const [requestId, setRequestId] = useState<string | null>(null);
  const query = useQuery({ queryKey: key, retry: false, queryFn: async ({ signal }) => {
    const result = await api.GET(backupControlContracts.get.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('Backup state failed');
    return parseResponse(backupControlResponseSchema, result.data).data;
  }, refetchInterval: query => ['queued', 'running'].includes(query.state.data?.manual?.status ?? '') ? 2_000 : 60_000 });
  const acknowledged = query.data?.manual?.requestId;
  useEffect(() => { if (requestId && acknowledged === requestId) setRequestId(null); }, [acknowledged, requestId]);
  const refresh = () => cache.invalidateQueries({ queryKey: ['health', gymId] });
  const now = useMutation({ mutationFn: async () => {
    const id = requestId ?? crypto.randomUUID(); setRequestId(id);
    const result = await api.POST(backupControlContracts.now.path, { body: { requestId: id } });
    if (!result.response.ok) throw new Error('Backup request failed');
    cache.setQueryData(key, parseResponse(backupControlResponseSchema, result.data).data);
    setRequestId(null);
  }, onSettled: refresh });
  const confirm = useMutation({ mutationFn: async () => {
    if (confirming === null) return;
    const result = await api.POST(backupControlContracts.confirm.path, { body: { revision: confirming, confirmed: true } });
    if (!result.response.ok) throw new Error('Confirmation failed');
    cache.setQueryData(key, parseResponse(backupControlResponseSchema, result.data).data);
    setConfirming(null); onConfirmed?.();
  }, onSettled: refresh });
  if (query.isPending) return <p role="status" className="text-sm">{label('loading')}</p>;
  if (query.isError) return <p role="status" className="text-sm">{label('loadFailed')}</p>;
  const state = query.data;
  if (!state.available) return null;
  const busy = now.isPending || ['queued', 'running'].includes(state.manual?.status ?? '');
  return <section aria-label={label('title')} className="mt-4 min-w-0 space-y-3">
    {state.pruningHeld && <Alert>
      <p>{label('hold')}</p>
      {owner ? <Button type="button" className="mt-3 w-full sm:w-auto" variant="outline" onClick={() => { setChecked(false); confirm.reset(); setConfirming(state.revision); }}>{label('review')}</Button>
        : <p className="mt-2">{label('ownerOnly')}</p>}
    </Alert>}
    {state.manual && <p role="status" className="text-sm [overflow-wrap:anywhere]">{state.manual.status === 'succeeded'
      ? label('succeeded', { time: instantLabel(state.manual.completedAt!), id: state.manual.snapshotId! })
      : label(state.manual.status)}</p>}
    {now.isError && <Alert>{label('requestFailed')}</Alert>}
    <Button type="button" variant="outline" disabled={busy || !state.configured} onClick={() => now.mutate()}>{label(busy ? 'busy' : 'now')}</Button>
    {!state.configured && <p className="text-sm text-muted-foreground">{label('notConfigured')}</p>}
    {confirming !== null && <Dialog title={label('review')} description={label('confirmDescription')} closeLabel={label('cancel')}
      dismissible={!confirm.isPending} onClose={() => setConfirming(null)}>
      <div className="space-y-4 p-4 sm:p-6">
        <CheckboxField label={label('confirmCheck')} checked={checked} onChange={event => setChecked(event.target.checked)}/>
        {confirm.isError && <Alert>{label('confirmFailed')}</Alert>}
        <Button type="button" className="w-full sm:w-auto" disabled={!checked || confirm.isPending} onClick={() => confirm.mutate()}>{label('confirm')}</Button>
      </div>
    </Dialog>}
  </section>;
}
