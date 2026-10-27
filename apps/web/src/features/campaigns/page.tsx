// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import type { CampaignRecipientState, LinkCampaignDetail } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { LoadingState, EmptyState, ErrorState } from '../../components/ui/states.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Alert } from '../../components/ui/alert.js';
import { Select } from '../../components/ui/select.js';
import { Label } from '../../components/ui/label.js';
import { api } from '../../lib/api.js';
import { campaignClient, type CampaignClient } from './api.js';
import { CampaignEditor, text } from './editor.js';

function Progress({ detail }: { detail: LinkCampaignDetail }) {
  return <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">{(['pending', 'completed', 'expired', 'revoked', 'total'] as const).map(key =>
    <div key={key}><dt className="text-sm text-muted-foreground">{text(key)}</dt><dd className="font-semibold">{detail.progress[key]}</dd></div>)}</dl>;
}
function Pager({ offset, total, change }: { offset: number; total: number; change(value: number): void }) {
  return <nav className="flex flex-wrap gap-2" aria-label={text('pages')}>
    <Button variant="outline" disabled={offset === 0} onClick={() => change(Math.max(0, offset - 20))}>{text('previous')}</Button>
    <Button variant="outline" disabled={offset + 20 >= total} onClick={() => change(offset + 20)}>{text('next')}</Button>
  </nav>;
}
export function CampaignWorkspace({ gymId, timezone, client = campaignClient }: { gymId: string; timezone: string; client?: CampaignClient }) {
  const cache = useQueryClient(), key = ['campaigns', gymId];
  const [selected, setSelected] = useState<string | null>(null), [editing, setEditing] = useState(false);
  const [offset, setOffset] = useState(0), [recipientOffset, setRecipientOffset] = useState(0);
  const [filter, setFilter] = useState<CampaignRecipientState | 'all'>('pending');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const list = useQuery({ queryKey: [...key, 'list', offset], queryFn: () => client.list(offset), refetchInterval: 10000 });
  const households = useQuery({ queryKey: [...key, 'households'], queryFn: () => client.households() });
  const detail = useQuery({ queryKey: [...key, selected], queryFn: () => client.get(selected!), enabled: selected !== null, refetchInterval: 5000 });
  const recipients = useQuery({ queryKey: [...key, selected, filter, recipientOffset],
    queryFn: () => client.recipients(selected!, filter === 'all' ? undefined : filter, recipientOffset), enabled: selected !== null, refetchInterval: 5000 });
  const names = new Map(households.data?.map(h => [h.id, h.name]));
  async function remind() {
    if (!selected) return;
    setBusy(true); setMessage('');
    try { const result = await client.remind(selected); setMessage(text('queued') + ': ' + result.queued); await cache.invalidateQueries({ queryKey: key }); }
    catch { setMessage(text('saveError')); } finally { setBusy(false); }
  }
  return <Page>
    <PageHeader title={detail.data?.campaign.name ?? text('title')} description={text('help')}
      actions={<>{selected && <Button variant="outline" onClick={() => { setSelected(null); setMessage(''); }}>{text('back')}</Button>}
        <Button disabled={!households.data} onClick={() => setEditing(true)}>{text('create')}</Button></>} />
    {message && <Alert role="status">{message}</Alert>}
    {households.isError && <ErrorState message={text('householdsError')} onRetry={() => void households.refetch()} />}
    {!selected ? <>
      {list.isPending && <LoadingState />}
      {list.isError && <ErrorState onRetry={() => void list.refetch()} />}
      {list.data && <>
        {!list.data.data.length && <EmptyState title={text('empty')} description={text('help')} />}
        <ul className="space-y-3">{list.data.data.map(item => <li key={item.campaign.id}><Card className="min-w-0 space-y-3">
          <h2 className="break-words text-lg font-medium">{item.campaign.name}</h2><p>{text(item.campaign.purpose)}</p><Progress detail={item} />
          <Button variant="outline" onClick={() => { setSelected(item.campaign.id); setRecipientOffset(0); setFilter('pending'); setMessage(''); }}>{text('view')} {item.campaign.name}</Button>
        </Card></li>)}</ul><Pager offset={offset} total={list.data.pagination.total} change={setOffset} />
      </>}
    </> : <>
      {detail.isPending && <LoadingState />}
      {detail.isError && <ErrorState onRetry={() => void detail.refetch()} />}
      {detail.data && <Card className="space-y-4"><Progress detail={detail.data} />
        <p className="text-sm text-muted-foreground">{text('remindHelp')}</p>
        <Button disabled={busy || !detail.data.progress.pending} onClick={() => void remind()}>{text('remind')}</Button>
      </Card>}
      <div><Label htmlFor="recipient-state">{text('whoLeft')}</Label><Select id="recipient-state" value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setRecipientOffset(0); }}>
        {(['pending', 'completed', 'expired', 'revoked', 'all'] as const).map(state => <option key={state} value={state}>{text(state)}</option>)}
      </Select></div>
      {recipients.isPending && <LoadingState />}
      {recipients.isError && <ErrorState onRetry={() => void recipients.refetch()} />}
      {recipients.data && <>
        {!recipients.data.data.length && <EmptyState title={text('noRecipients')} />}
        <ul className="space-y-3">{recipients.data.data.map(r => <li key={r.link.id} className="min-w-0 space-y-2 rounded-xl border p-4">
          <h2 className="break-all font-medium">{names.get(r.link.householdId) ?? r.link.householdId}</h2><p>{text(r.state)}</p>
          <p className="break-words text-sm text-muted-foreground">{text('expires')}: {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(r.link.expiresAt))}</p>
        </li>)}</ul><Pager offset={recipientOffset} total={recipients.data.pagination.total} change={setRecipientOffset} />
      </>}
    </>}
    {editing && households.data && <CampaignEditor households={households.data} timezone={timezone} loadNeedsCard={client.needsCard} close={() => setEditing(false)} save={async input => {
      const created = await client.create(input); setEditing(false); setSelected(created.campaign.id); setRecipientOffset(0); setMessage(text('created'));
      await cache.invalidateQueries({ queryKey: key });
    }} />}
  </Page>;
}
export function CampaignPage() {
  const bootstrap = useBootstrap();
  const allowed = !!bootstrap.data?.session && canStaff(bootstrap.data.session.roles, 'links.send');
  const options = useQuery({ queryKey: ['campaigns', bootstrap.data?.gym.id, 'formatting'], enabled: allowed,
    queryFn: async () => {
      const response = await api.GET('/api/schedule/options');
      if (!response.response.ok || !response.data) throw new Error('Gym timezone unavailable');
      return response.data.data;
    } });
  if (bootstrap.isPending) return <LoadingState />;
  if (!allowed || !bootstrap.data) return <Alert>{text('noAccess')}</Alert>;
  if (options.isPending) return <LoadingState />;
  if (options.isError) return <ErrorState onRetry={() => void options.refetch()} />;
  return <CampaignWorkspace key={bootstrap.data.gym.id} gymId={bootstrap.data.gym.id} timezone={options.data.timezone} />;
}
