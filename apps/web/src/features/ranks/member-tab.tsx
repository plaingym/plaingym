// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { useBootstrap } from '../../app/context.js';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { ApiError } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { Badge } from '../../components/ui/table.js';
import { ranksClient, type RanksClient } from './api.js';
import { Criteria, Field } from './page.js';
import { text } from './rank-editor.js';

export function MemberRanksPanel({ gymId, memberId, promote, client = ranksClient }: {
  gymId: string; memberId: string; promote: boolean; client?: RanksClient;
}) {
  const cache = useQueryClient(), key = ['ranks', gymId];
  const [programChoice, setProgram] = useState(''), [rankChoice, setRank] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const catalog = useQuery({ queryKey: [...key, 'profile-catalog'], queryFn: async () => {
    const [programs, systems] = await Promise.all([client.programs(), client.systems()]);
    const ranks = (await Promise.all(systems.map((system) => client.ranks(system.id)))).flat();
    return { programs, systems, ranks };
  } });
  const history = useQuery({ queryKey: [...key, 'history', memberId], queryFn: () => client.history(memberId) });
  const programs = catalog.data?.programs.filter((program) => program.rankSystemId && program.active) ?? [];
  const programId = programs.some((program) => program.id === programChoice) ? programChoice : programs[0]?.id ?? '';
  const program = programs.find((item) => item.id === programId);
  const ranks = catalog.data?.ranks.filter((rank) => rank.rankSystemId === program?.rankSystemId) ?? [];
  const rankId = ranks.some((rank) => rank.id === rankChoice) ? rankChoice : ranks[0]?.id ?? '';
  const rank = ranks.find((item) => item.id === rankId);
  const progress = useQuery({ queryKey: [...key, 'profile-eligibility', memberId, programId, rankId], enabled: promote && !!programId && !!rankId,
    queryFn: async () => (await client.eligibility(programId, rankId, false)).find((item) => item.memberId === memberId) ?? null });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!program?.rankSystemId || !rank) return;
    const form = new FormData(event.currentTarget); setBusy(true); setMessage('');
    try {
      await client.call('promote', { memberId, programId, rankId, rankSystemId: program.rankSystemId,
        subRank: Number(form.get('subRank')), promotedAt: new Date(String(form.get('promotedAt'))).toISOString(), notes: String(form.get('notes') ?? '').trim() || null });
      await cache.invalidateQueries({ queryKey: key }); setMessage(text('saved'));
    } catch (error) { setMessage(text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error')); }
    finally { setBusy(false); }
  }
  const retry = () => void cache.invalidateQueries({ queryKey: key });
  if (history.isPending || catalog.isPending) return <LoadingState label={text('loading')}/>;
  if (history.isError || catalog.isError) return <ErrorState message={text('loadFailed')} onRetry={retry}/>;
  return <section className="grid items-start gap-6 lg:grid-cols-2">
    <div className="min-w-0 space-y-4">
      <h2 className="text-lg font-semibold">{text('history')}</h2>
      {!history.data.length && <p className="text-sm text-muted-foreground">{text('noHistory')}</p>}
      <ol className="space-y-3">{history.data.map((entry) => {
        const rank = catalog.data.ranks.find((item) => item.id === entry.rankId);
        return <li key={entry.id} className="space-y-1 rounded-lg border border-border p-3" data-rank-system={entry.rankSystemId}>
          <p className="break-words font-medium">{catalog.data.programs.find((item) => item.id === entry.programId)?.name} — {rank?.name} {entry.subRank > 0 ? rank?.subRanks[entry.subRank - 1]?.name ?? entry.subRank : ''}</p>
          <p className="text-sm text-muted-foreground">{text('system')}: {catalog.data.systems.find((item) => item.id === entry.rankSystemId)?.name}</p>
          <p className="text-sm"><time dateTime={entry.promotedAt}>{new Date(entry.promotedAt).toLocaleString()}</time></p>
          {entry.notes && <p className="whitespace-pre-wrap break-words">{entry.notes}</p>}
        </li>;
      })}</ol>
    </div>
    {promote ? <form onSubmit={(event) => void submit(event)} className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
      <h3 className="text-lg font-semibold">{text('promote')}</h3><p className="text-sm text-muted-foreground">{text('manualHelp')}</p>
      {message && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{message}</p>}
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <Field label={text('program')}><Select value={programId} onChange={(event) => { setProgram(event.target.value); setRank(''); }}>
          {!programs.length && <option value="">{text('noPrograms')}</option>}{programs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={text('targetRank')}><Select value={rankId} onChange={(event) => setRank(event.target.value)}>
            {!ranks.length && <option value="">{text('noRanks')}</option>}{ranks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select></Field>
          <Field label={text('subRank')}><Select key={rankId} name="subRank" defaultValue="0">
            <option value="0">{text('baseRank')}</option>{rank?.subRanks.map((item, index) => <option key={item.id} value={index + 1}>{item.name}</option>)}
          </Select></Field>
        </div>
        {progress.isFetching && <LoadingState label={text('loading')}/>}{progress.isError && <ErrorState message={text('loadFailed')} onRetry={retry}/>}
        {progress.data && <div className="space-y-2"><Badge tone={progress.data.eligible ? 'success' : 'muted'}>{text(progress.data.eligible ? 'eligible' : 'notEligible')}</Badge>
          <Criteria criteria={progress.data.criteria}/></div>}
        <Field label={text('promotedAt')}><Input name="promotedAt" type="datetime-local" required/></Field>
        <Field label={text('notes')}><Input name="notes"/></Field>
        <Button type="submit" className="w-full sm:w-auto" disabled={!programId || !rankId}>{text('promote')}</Button>
      </fieldset>
    </form> : message && <p role="status">{message}</p>}
  </section>;
}
export function MemberRanksTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap();
  if (!memberId || !bootstrap.data?.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return null;
  return <MemberRanksPanel key={bootstrap.data.gym.id + ':' + memberId} gymId={bootstrap.data.gym.id} memberId={memberId}
    promote={canStaff(bootstrap.data.session.roles, 'promotions.manage')}/>;
}
