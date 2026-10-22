// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import type { Program, Rank } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { ApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Card } from '../../components/ui/card.js';
import { RankEditor, text } from './rank-editor.js';
import { ranksClient, type RanksClient } from './api.js';

const selectClass = 'block min-h-11 w-full rounded-md border border-input bg-background px-3';
const value = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
export function RanksWorkspace({ gymId, configure, promote, client = ranksClient }: {
  gymId: string; configure: boolean; promote: boolean; client?: RanksClient;
}) {
  const cache = useQueryClient(), key = ['ranks', gymId];
  const [systemChoice, setSystem] = useState(''), [programChoice, setProgram] = useState(''), [rankChoice, setRank] = useState('');
  const [editor, setEditor] = useState<Rank | 'new' | null>(null), [readyOnly, setReadyOnly] = useState(true);
  const [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const systems = useQuery({ queryKey: [...key, 'systems'], queryFn: () => client.systems() });
  const programs = useQuery({ queryKey: [...key, 'programs'], queryFn: () => client.programs() });
  const systemId = systemChoice || systems.data?.[0]?.id || '';
  const system = systems.data?.find((item) => item.id === systemId);
  const ranks = useQuery({ queryKey: [...key, 'list', systemId], queryFn: () => client.ranks(systemId), enabled: !!systemId });
  const matchingPrograms = programs.data?.filter((item) => item.rankSystemId === systemId && item.active) ?? [];
  const programId = matchingPrograms.some((item) => item.id === programChoice) ? programChoice : matchingPrograms[0]?.id ?? '';
  const rankId = ranks.data?.some((item) => item.id === rankChoice) ? rankChoice : ranks.data?.[0]?.id ?? '';
  const eligibility = useQuery({ queryKey: [...key, 'eligibility', programId, rankId, readyOnly],
    queryFn: () => client.eligibility(programId, rankId, readyOnly), enabled: promote && !!programId && !!rankId });
  const roster = useQuery({ queryKey: [...key, 'member-names'], queryFn: () => client.members(), enabled: promote });
  const memberName = (id: string) => { const member = roster.data?.find((item) => item.id === id); return member ? member.firstName + ' ' + member.lastName : id; };
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setMessage('');
    try { await action(); await cache.invalidateQueries({ queryKey: key }); setMessage(text('saved')); return true; }
    catch (error) {
      setMessage(text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error'));
      await cache.invalidateQueries({ queryKey: key }); return false;
    } finally { setBusy(false); }
  }
  function formAction(event: FormEvent<HTMLFormElement>, action: (form: FormData) => Promise<unknown>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); void run(() => action(form));
  }
  function changeSystem(id: string) { setSystem(id); setProgram(''); setRank(''); setSelected([]); setEditor(null); }
  async function promoteSelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const rows = eligibility.data?.filter((row) => row.eligible && selected.includes(row.memberId)) ?? [];
    if (!rows.length) return;
    const succeeded = await run(async () => {
      for (const subRank of new Set(rows.map((row) => row.subRank))) {
        const ids = rows.filter((row) => row.subRank === subRank).map((row) => row.memberId);
        for (let index = 0; index < ids.length; index += 100) await client.call('bulkPromote', {
          memberIds: ids.slice(index, index + 100), programId, rankId, rankSystemId: systemId, subRank,
          promotedAt: new Date(value(form, 'promotedAt')).toISOString(), notes: value(form, 'notes') || null,
        });
      }
    });
    if (succeeded) setSelected([]);
  }
  if (systems.isPending || programs.isPending) return <p role="status">{text('loading')}</p>;
  if (systems.isError || programs.isError) return <Alert>{text('error')}<Button onClick={() => void cache.invalidateQueries({ queryKey: key })}>{text('refresh')}</Button></Alert>;
  return <main className="mx-auto max-w-6xl space-y-6 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">{text('title')}</h1><Button variant="outline" disabled={busy} onClick={() => void cache.invalidateQueries({ queryKey: key })}>{text('refresh')}</Button></div>
    {message && <p role="status">{message}</p>}
    <Label className="block">{text('system')}<select className={selectClass} value={systemId} onChange={(event) => changeSystem(event.target.value)}>
      {!systems.data.length && <option value="">{text('noSystems')}</option>}{systems.data.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></Label>
    {configure && <Card className="space-y-4"><h2 className="text-lg font-semibold">{text('configure')}</h2>
      <form onSubmit={(event) => formAction(event, (form) => client.call('createRankSystem', { name: value(form, 'name') }))} className="flex flex-wrap items-end gap-2">
        <Label>{text('newSystem')}<Input name="name" required/></Label><Button type="submit" disabled={busy}>{text('create')}</Button>
      </form>
      {system && <form key={system.id + ':' + system.revision} onSubmit={(event) => formAction(event,
        (form) => client.call('updateRankSystem', { name: value(form, 'name'), revision: system.revision }, system.id))} className="flex flex-wrap items-end gap-2">
        <Label>{text('systemName')}<Input name="name" required defaultValue={system.name}/></Label><Button type="submit" disabled={busy}>{text('rename')}</Button>
      </form>}
      <Label className="block">{text('applyPack')}<Input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; if (!file) return;
        void run(async () => { if (file.size > 1_048_576) throw new Error(); await client.call('applyPack', { pack: JSON.parse(await file.text()) }); });
        event.target.value = '';
      }}/></Label><p className="text-sm text-muted-foreground">{text('packHelp')}</p>
    </Card>}
    <Card className="space-y-4"><h2 className="text-lg font-semibold">{text('programs')}</h2>
      {programs.data.map((program) => <ProgramForm key={program.id + ':' + program.revision} program={program} systems={systems.data} busy={busy} editable={configure}
        save={(form) => run(() => client.call('updateProgram', { revision: program.revision, name: value(form, 'name'), rankSystemId: value(form, 'system') || null, active: form.has('active') }, program.id))}/>) }
      {configure && <form onSubmit={(event) => formAction(event, (form) => client.call('createProgram', {
        name: value(form, 'name'), rankSystemId: value(form, 'system') || null, active: true,
      }))} className="flex flex-wrap items-end gap-2">
        <Label>{text('newProgram')}<Input name="name" required/></Label>
        <Label>{text('system')}<select className={selectClass} name="system" key={systemId} defaultValue={systemId}><option value="">{text('unranked')}</option>{systems.data.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Label>
        <Button type="submit" disabled={busy}>{text('create')}</Button>
      </form>}
    </Card>
    {system && <Card className="space-y-4"><h2 className="text-lg font-semibold">{text('ranks')}</h2>
      {ranks.isPending ? <p role="status">{text('loading')}</p> : ranks.isError ? <Alert>{text('error')}</Alert> : <ol className="space-y-3">{ranks.data.map((rank) => <li key={rank.id} className="flex flex-wrap items-center gap-3">
        {rank.color && <span className="inline-block h-6 w-12 rounded border" style={{ backgroundColor: rank.color }} aria-label={text('color') + ': ' + rank.color}/>}
        <span>{rank.position}. {rank.name}</span><span className="text-sm text-muted-foreground">{rank.subRanks.map((subRank) => subRank.name).join(', ')}</span>
        {configure && <Button variant="outline" onClick={() => setEditor(rank)}>{text('edit')} {rank.name}</Button>}
      </li>)}</ol>}
      {configure && <Button disabled={busy} onClick={() => setEditor('new')}>{text('addRank')}</Button>}
    </Card>}
    {configure && editor && system && <RankEditor key={editor === 'new' ? 'new-' + systemId : editor.id + ':' + editor.revision}
      {...(editor === 'new' ? {} : { rank: editor })} rankSystemId={systemId} nextPosition={Math.max(-1, ...(ranks.data ?? []).map((rank) => rank.position)) + 1} busy={busy}
      save={async (body) => { const { rankSystemId, ...changes } = body; void rankSystemId;
        if (await run(() => editor === 'new' ? client.call('createRank', body) : client.call('updateRank', { ...changes, revision: editor.revision }, editor.id))) setEditor(null);
      }} cancel={() => setEditor(null)}/>}
    {promote && <Card className="space-y-4"><h2 className="text-lg font-semibold">{text('ready')}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Label>{text('program')}<select className={selectClass} value={programId} onChange={(event) => { setProgram(event.target.value); setSelected([]); }}>
          {!matchingPrograms.length && <option value="">{text('noPrograms')}</option>}{matchingPrograms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></Label>
        <Label>{text('targetRank')}<select className={selectClass} value={rankId} onChange={(event) => { setRank(event.target.value); setSelected([]); }}>
          {!ranks.data?.length && <option value="">{text('noRanks')}</option>}{ranks.data?.map((rank) => <option key={rank.id} value={rank.id}>{rank.name}</option>)}
        </select></Label>
      </div>
      <Label className="flex items-center gap-2"><input type="checkbox" checked={readyOnly} onChange={(event) => { setReadyOnly(event.target.checked); setSelected([]); }}/>{text('readyOnly')}</Label>
      {eligibility.isFetching && <p role="status">{text('loading')}</p>}{eligibility.isError && <Alert>{text('error')}</Alert>}
      {roster.isError && <p>{text('namesUnavailable')}</p>}
      {eligibility.data?.length === 0 && <p>{text('noEligible')}</p>}
      <form onSubmit={(event) => void promoteSelected(event)} className="space-y-4"><fieldset disabled={busy || eligibility.isFetching} className="space-y-4">
        {eligibility.data?.map((row) => <div key={row.memberId} className="rounded border p-4">
          <Label className="flex items-center gap-2"><input type="checkbox" disabled={!row.eligible} checked={selected.includes(row.memberId)} onChange={(event) => setSelected(event.target.checked ? [...selected, row.memberId] : selected.filter((id) => id !== row.memberId))}/>{memberName(row.memberId)} — {text(row.eligible ? 'eligible' : 'notEligible')} ({text('subRank')} {row.subRank})</Label>
          {row.criteria.map((criterion, index) => <div key={index} className="mt-2">
            <span>{t(criterion.labelKey)}: {criterion.current} / {criterion.target}</span>
            <progress className="block w-full" aria-label={t(criterion.labelKey) + ' ' + memberName(row.memberId)} max={criterion.target || 1} value={criterion.target === 0 ? 1 : Math.min(criterion.current, criterion.target)}/>
          </div>)}
        </div>)}
        <Label className="block">{text('promotedAt')}<Input name="promotedAt" type="datetime-local" required/></Label>
        <Label className="block">{text('notes')}<Input name="notes"/></Label>
        <p className="text-sm text-muted-foreground">{text('bulkHelp')}</p>
        <Button type="submit" disabled={!selected.length || !programId || !rankId}>{text('bulkPromote')} ({selected.length})</Button>
      </fieldset></form>
    </Card>}
  </main>;
}
function ProgramForm({ program, systems, busy, editable, save }: {
  program: Program; systems: { id: string; name: string }[]; busy: boolean; editable: boolean; save: (form: FormData) => Promise<boolean>;
}) {
  if (!editable) return <p>{program.name} — {text(program.active ? 'active' : 'inactive')}</p>;
  return <form onSubmit={(event) => { event.preventDefault(); void save(new FormData(event.currentTarget)); }}>
    <fieldset disabled={busy} className="flex flex-wrap items-end gap-2">
      <Label>{text('programName')}<Input name="name" required defaultValue={program.name}/></Label>
      <Label>{text('system')}<select className={selectClass} name="system" defaultValue={program.rankSystemId ?? ''}><option value="">{text('unranked')}</option>{systems.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Label>
      <Label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="active" defaultChecked={program.active}/>{text('active')}</Label>
      <Button type="submit" variant="outline">{text('save')}</Button>
    </fieldset>
  </form>;
}
export function RanksPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{text('loading')}</p>;
  if (!bootstrap.data?.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return <Alert>{text('noAccess')}</Alert>;
  const { gym, session } = bootstrap.data;
  return <RanksWorkspace key={gym.id} gymId={gym.id} configure={canStaff(session!.roles, 'settings.manage')} promote={canStaff(session!.roles, 'promotions.manage')}/>;
}
