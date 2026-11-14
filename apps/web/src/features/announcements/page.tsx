// SPDX-License-Identifier: AGPL-3.0-only
import { instantLabel } from '../../lib/instant.js';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { useBootstrap } from '../../app/context.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { LoadingState, EmptyState, ErrorState } from '../../components/ui/states.js';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Card } from '../../components/ui/card.js';
import { Alert } from '../../components/ui/alert.js';
import { announcementClient, type AnnouncementClient } from './api.js';
import { AnnouncementEditor, type AnnouncementAttempt } from './editor.js';
import { text } from './messages.js';

export function AnnouncementWorkspace({ gymId, gymName, timezone, owner = false, client = announcementClient }: {
  gymId: string; gymName: string; timezone: string; owner?: boolean; client?: AnnouncementClient;
}) {
  const cache = useQueryClient(), key = ['announcements', gymId];
  const [editing, setEditing] = useState(false), [offset, setOffset] = useState(0), [sent, setSent] = useState(false);
  const [attempt, setAttempt] = useState<AnnouncementAttempt>();
  // Poll only while a shown announcement is still being delivered.
  const history = useQuery({ queryKey: [...key, 'history', offset], queryFn: () => client.list(offset),
    refetchInterval: query => query.state.data?.data.some(item => item.status === 'sending') ? 5000 : false });
  const programs = useQuery({ queryKey: [...key, 'programs'], queryFn: () => client.programs() });
  const senders = useQuery({ queryKey: [...key, 'senders'], queryFn: () => client.senders() });
  const names = new Map(senders.data?.filter(profile => profile.userId).map(profile => [profile.userId, profile.displayName]));
  return <Page>
    <PageHeader title={text('title')} description={text('help')}
      actions={<Button disabled={!programs.data} onClick={() => { setEditing(true); setSent(false); }}>{text('compose')}</Button>} />
    {sent && <Alert role="status">{text('queued')}</Alert>}
    {programs.isPending && <LoadingState />}
    {programs.isError && <ErrorState message={text('programError')} onRetry={() => void programs.refetch()} />}
    {senders.isError && <ErrorState message={text('senderError')} onRetry={() => void senders.refetch()} />}
    <PageSection title={text('history')}>
      {history.isPending && <LoadingState />}
      {history.isError && <ErrorState onRetry={() => void history.refetch()} />}
      {history.data && <div className="space-y-4">
        {history.data.data.length === 0 && <EmptyState title={text('empty')} description={text('help')} />}
        <ul className="space-y-3">{history.data.data.map(item => <li key={item.id}><Card className="min-w-0 space-y-3">
          <h3 className="text-lg font-medium">{item.subject}</h3>
          <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div><dt className="text-sm text-muted-foreground">{text('date')}</dt><dd>{instantLabel(item.createdAt, timezone)}</dd></div>
            <div className="min-w-0 lg:col-span-2"><dt className="text-sm text-muted-foreground">{text('sender')}</dt><dd>{names.get(item.createdBy) ?? text('senderId', { id: item.createdBy })}</dd></div>
            {(['sent', 'failed', 'skipped'] as const).map(count => <div key={count}><dt className="text-sm text-muted-foreground">{text(count)}</dt><dd>{item[count]}</dd></div>)}
          </dl>
          <p className="text-sm text-muted-foreground">{text(item.status + 'Status')}</p>
        </Card></li>)}</ul>
        <Pager offset={offset} total={history.data.pagination.total} onChange={setOffset} label={text('pages')} previousLabel={text('previous')} nextLabel={text('next')}/>
      </div>}
    </PageSection>
    {editing && programs.data && <AnnouncementEditor gymName={gymName} programs={programs.data} client={client} owner={owner}
      attempt={attempt} rememberAttempt={setAttempt} close={() => setEditing(false)} sent={() => {
      setEditing(false); setSent(true); setOffset(0); void cache.invalidateQueries({ queryKey: [...key, 'history'] });
    }} />}
  </Page>;
}
export function AnnouncementPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <LoadingState />;
  if (bootstrap.isError) return <ErrorState onRetry={() => void bootstrap.refetch()} />;
  if (!bootstrap.data.session || !canStaff(bootstrap.data.session.roles, 'announcements.send')) return <Alert variant="error">{text('noAccess')}</Alert>;
  return <AnnouncementWorkspace key={bootstrap.data.gym.id} gymId={bootstrap.data.gym.id} gymName={bootstrap.data.gym.name} timezone={bootstrap.data.gym.timezone}
    owner={bootstrap.data.session.roles.includes('owner')} />;
}
