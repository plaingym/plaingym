// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { useBootstrap } from '../../app/context.js';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { ranksClient, type RanksClient } from './api.js';
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
  if (history.isPending || catalog.isPending) return <p role="status">{text('loading')}</p>;
  if (history.isError || catalog.isError) return <Alert>{text('error')}<Button onClick={() => void cache.invalidateQueries({ queryKey: key })}>{text('refresh')}</Button></Alert>;
  return <section className="space-y-4">
    <h2 className="text-lg font-semibold">{text('history')}</h2>
    {message && <p role="status">{message}</p>}
    {!history.data.length && <p>{text('noHistory')}</p>}
    <ol className="space-y-3">{history.data.map((entry) => {
      const rank = catalog.data.ranks.find((item) => item.id === entry.rankId);
      return <li key={entry.id} className="rounded border p-3" data-rank-system={entry.rankSystemId}>
        <p>{catalog.data.programs.find((item) => item.id === entry.programId)?.name} — {rank?.name} {entry.subRank > 0 ? rank?.subRanks[entry.subRank - 1]?.name ?? entry.subRank : ''}</p>
        <p className="text-sm">{text('system')}: {catalog.data.systems.find((item) => item.id === entry.rankSystemId)?.name}</p>
        <time dateTime={entry.promotedAt}>{new Date(entry.promotedAt).toLocaleString()}</time>{entry.notes && <p className="whitespace-pre-wrap">{entry.notes}</p>}
      </li>;
    })}</ol>
    {promote && <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <h3 className="font-semibold">{text('promote')}</h3><p className="text-sm text-muted-foreground">{text('manualHelp')}</p>
      <fieldset disabled={busy} className="space-y-4">
        <Label className="block">{text('program')}<select className="block min-h-11 w-full rounded border px-3" value={programId} onChange={(event) => { setProgram(event.target.value); setRank(''); }}>
          {!programs.length && <option value="">{text('noPrograms')}</option>}{programs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></Label>
        <Label className="block">{text('targetRank')}<select className="block min-h-11 w-full rounded border px-3" value={rankId} onChange={(event) => setRank(event.target.value)}>
          {!ranks.length && <option value="">{text('noRanks')}</option>}{ranks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></Label>
        <Label className="block">{text('subRank')}<select key={rankId} className="block min-h-11 w-full rounded border px-3" name="subRank" defaultValue="0">
          <option value="0">{text('baseRank')}</option>{rank?.subRanks.map((item, index) => <option key={item.id} value={index + 1}>{item.name}</option>)}
        </select></Label>
        {progress.isFetching && <p role="status">{text('loading')}</p>}{progress.isError && <Alert>{text('error')}</Alert>}
        {progress.data && <div><p>{text(progress.data.eligible ? 'eligible' : 'notEligible')}</p>{progress.data.criteria.map((criterion, index) => <div key={index}>
          <span>{t(criterion.labelKey)}: {criterion.current} / {criterion.target}</span>
          <progress className="block w-full" aria-label={t(criterion.labelKey)} max={criterion.target || 1} value={criterion.target === 0 ? 1 : Math.min(criterion.current, criterion.target)}/>
        </div>)}</div>}
        <Label className="block">{text('promotedAt')}<Input name="promotedAt" type="datetime-local" required/></Label>
        <Label className="block">{text('notes')}<Input name="notes"/></Label>
        <Button type="submit" disabled={!programId || !rankId}>{text('promote')}</Button>
      </fieldset>
    </form>}
  </section>;
}
export function MemberRanksTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap();
  if (!memberId || !bootstrap.data?.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return null;
  return <MemberRanksPanel key={bootstrap.data.gym.id + ':' + memberId} gymId={bootstrap.data.gym.id} memberId={memberId}
    promote={canStaff(bootstrap.data.session.roles, 'promotions.manage')}/>;
}
