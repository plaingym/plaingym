// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
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
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { CheckboxField, Select } from '../../components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states.js';
import { Badge, StackedItem, StackedList } from '../../components/ui/table.js';
import { RankEditor, text } from './rank-editor.js';
import { ranksClient, type RanksClient } from './api.js';

const value = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const card = 'space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6';
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <Label className={'grid min-w-0 gap-2 ' + (className ?? '')}>{label}{children}</Label>;
}
/** A belt-color swatch, announced by its color. */
export function Swatch({ color }: { color: string }) {
  return <span role="img" className="inline-block h-6 w-10 shrink-0 rounded border border-border" style={{ backgroundColor: color }} aria-label={text('color') + ': ' + color}/>;
}
export function Criteria({ criteria, name }: { criteria: { labelKey: string; current: number; target: number }[]; name?: string }) {
  return <div className="space-y-2">{criteria.map((criterion, index) => <div key={index} className="space-y-1">
    <p className="flex justify-between gap-3 text-sm"><span>{t(criterion.labelKey)}</span><span className="tabular-nums">{criterion.current} / {criterion.target}</span></p>
    <progress className="block h-2 w-full accent-primary" aria-label={t(criterion.labelKey) + (name ? ' ' + name : '')} max={criterion.target || 1} value={criterion.target === 0 ? 1 : Math.min(criterion.current, criterion.target)}/>
  </div>)}</div>;
}
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
  const refresh = () => void cache.invalidateQueries({ queryKey: key });
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
  const header = <PageHeader title={text('title')} actions={<Button variant="outline" disabled={busy} onClick={refresh}>{text('refresh')}</Button>}/>;
  if (systems.isPending || programs.isPending) return <Page>{header}<LoadingState label={text('loading')}/></Page>;
  if (systems.isError || programs.isError) return <Page>{header}<ErrorState message={text('loadFailed')} onRetry={refresh}/></Page>;
  const eligibleRows = eligibility.data?.filter((row) => row.eligible) ?? [];
  return <Page>
    {header}
    {message && !editor && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{message}</p>}
    {systems.data.length ? <Field label={text('system')} className="sm:max-w-sm"><Select value={systemId} onChange={(event) => changeSystem(event.target.value)}>
      {systems.data.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</Select></Field>
      : <EmptyState title={text('noSystemsTitle')} description={text(configure ? 'noSystems' : 'noSystemsReadOnly')}/>}
    {system && <PageSection title={text('ranks')} actions={configure && <Button disabled={busy} onClick={() => setEditor('new')}>{text('addRank')}</Button>}>
      {ranks.isPending ? <LoadingState label={text('loading')}/> : ranks.isError ? <ErrorState message={text('loadFailed')} onRetry={refresh}/>
        : !ranks.data.length ? <EmptyState title={text('noRanks')} description={configure ? text('noRanksHelp') : undefined}/>
        : <StackedList>{ranks.data.map((rank) => <StackedItem key={rank.id} className="flex-row items-center gap-3">
          {rank.color ? <Swatch color={rank.color}/> : <span className="w-10 shrink-0" aria-hidden="true"/>}
          <div className="min-w-0 flex-1"><p className="break-words font-medium">{rank.position}. {rank.name}</p>
            {rank.subRanks.length > 0 && <p className="break-words text-sm text-muted-foreground">{rank.subRanks.map((subRank) => subRank.name).join(', ')}</p>}</div>
          {configure && <Button variant="outline" className="shrink-0" aria-label={text('edit') + ' ' + rank.name} onClick={() => setEditor(rank)}>{text('edit')}</Button>}
        </StackedItem>)}</StackedList>}
    </PageSection>}
    {configure && editor && system && <RankEditor key={editor === 'new' ? 'new-' + systemId : editor.id + ':' + editor.revision}
      {...(editor === 'new' ? {} : { rank: editor })} rankSystemId={systemId} nextPosition={Math.max(-1, ...(ranks.data ?? []).map((rank) => rank.position)) + 1} busy={busy}
      message={message} save={async (body) => { const { rankSystemId, ...changes } = body; void rankSystemId;
        if (await run(() => editor === 'new' ? client.call('createRank', body) : client.call('updateRank', { ...changes, revision: editor.revision }, editor.id))) setEditor(null);
      }} cancel={() => setEditor(null)}/>}
    {promote && <PageSection title={text('ready')} description={text('readyHelp')}><div className={card}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={text('program')}><Select value={programId} onChange={(event) => { setProgram(event.target.value); setSelected([]); }}>
          {!matchingPrograms.length && <option value="">{text('noPrograms')}</option>}{matchingPrograms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select></Field>
        <Field label={text('targetRank')}><Select value={rankId} onChange={(event) => { setRank(event.target.value); setSelected([]); }}>
          {!ranks.data?.length && <option value="">{text('noRanks')}</option>}{ranks.data?.map((rank) => <option key={rank.id} value={rank.id}>{rank.name}</option>)}
        </Select></Field>
      </div>
      <CheckboxField label={text('readyOnly')} checked={readyOnly} onChange={(event) => { setReadyOnly(event.target.checked); setSelected([]); }}/>
      {eligibility.isFetching && <LoadingState label={text('loading')}/>}{eligibility.isError && <ErrorState message={text('loadFailed')} onRetry={refresh}/>}
      {roster.isError && <Alert>{text('namesUnavailable')}</Alert>}
      {eligibility.data?.length === 0 && <EmptyState title={text('noEligible')} description={text(readyOnly ? 'noEligibleReady' : 'noEligibleAll')}/>}
      <form onSubmit={(event) => void promoteSelected(event)} className="space-y-4"><fieldset disabled={busy || eligibility.isFetching} className="min-w-0 space-y-4">
        {!!eligibility.data?.length && <>
          {eligibleRows.length > 1 && <CheckboxField label={text('selectAll')} checked={eligibleRows.every((row) => selected.includes(row.memberId))}
            onChange={(event) => setSelected(event.target.checked ? eligibleRows.map((row) => row.memberId) : [])}/>}
          <ul className="space-y-3">{eligibility.data.map((row) => <li key={row.memberId} className="space-y-2 rounded-lg border border-border p-3">
            <CheckboxField className="font-medium" disabled={!row.eligible} checked={selected.includes(row.memberId)}
              onChange={(event) => setSelected(event.target.checked ? [...selected, row.memberId] : selected.filter((id) => id !== row.memberId))}
              label={`${memberName(row.memberId)} — ${text(row.eligible ? 'eligible' : 'notEligible')} (${text('subRank')} ${row.subRank})`}/>
            <Criteria criteria={row.criteria} name={memberName(row.memberId)}/>
          </li>)}</ul>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={text('promotedAt')}><Input name="promotedAt" type="datetime-local" required/></Field>
            <Field label={text('notes')}><Input name="notes"/></Field>
          </div>
          <p className="text-sm text-muted-foreground">{text('bulkHelp')}</p>
          <Button type="submit" className="w-full sm:w-auto" disabled={!selected.length || !programId || !rankId}>{text('bulkPromote')} ({selected.length})</Button>
        </>}
      </fieldset></form>
    </div></PageSection>}
    <PageSection title={text('programs')}><div className={card}>
      {programs.data.length === 0 && <p className="text-sm text-muted-foreground">{text('noProgramsYet')}</p>}
      {configure ? programs.data.map((program) => <ProgramForm key={program.id + ':' + program.revision} program={program} systems={systems.data} busy={busy}
        save={(form) => run(() => client.call('updateProgram', { revision: program.revision, name: value(form, 'name'), rankSystemId: value(form, 'system') || null, active: form.has('active') }, program.id))}/>)
        : programs.data.length > 0 && <ul className="divide-y divide-border">{programs.data.map((program) => <li key={program.id} className="flex items-center justify-between gap-3 py-3">
          <span className="break-words">{program.name}</span><Badge tone={program.active ? 'success' : 'muted'}>{text(program.active ? 'active' : 'inactive')}</Badge></li>)}</ul>}
      {configure && <form onSubmit={(event) => formAction(event, (form) => client.call('createProgram', {
        name: value(form, 'name'), rankSystemId: value(form, 'system') || null, active: true,
      }))} className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label={text('newProgram')}><Input name="name" required/></Field>
        <Field label={text('system')}><Select name="system" key={systemId} defaultValue={systemId}><option value="">{text('unranked')}</option>{systems.data.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</Select></Field>
        <Button type="submit" disabled={busy}>{text('create')}</Button>
      </form>}
    </div></PageSection>
    {configure && <PageSection title={text('configure')}><div className={card}>
      <form onSubmit={(event) => formAction(event, (form) => client.call('createRankSystem', { name: value(form, 'name') }))} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={text('newSystem')} className="flex-1"><Input name="name" required/></Field><Button type="submit" disabled={busy}>{text('create')}</Button>
      </form>
      {system && <form key={system.id + ':' + system.revision} onSubmit={(event) => formAction(event,
        (form) => client.call('updateRankSystem', { name: value(form, 'name'), revision: system.revision }, system.id))} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={text('systemName')} className="flex-1"><Input name="name" required defaultValue={system.name}/></Field><Button type="submit" variant="outline" disabled={busy}>{text('rename')}</Button>
      </form>}
      <div className="space-y-2"><Field label={text('applyPack')}><Input type="file" accept=".json,application/json" className="py-2" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; if (!file) return;
        void run(async () => { if (file.size > 1_048_576) throw new Error(); await client.call('applyPack', { pack: JSON.parse(await file.text()) }); });
        event.target.value = '';
      }}/></Field><p className="text-sm text-muted-foreground">{text('packHelp')}</p></div>
    </div></PageSection>}
  </Page>;
}
function ProgramForm({ program, systems, busy, save }: {
  program: Program; systems: { id: string; name: string }[]; busy: boolean; save: (form: FormData) => Promise<boolean>;
}) {
  return <form onSubmit={(event) => { event.preventDefault(); void save(new FormData(event.currentTarget)); }} className="border-b border-border pb-4 last-of-type:border-b-0">
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
      <Field label={text('programName')}><Input name="name" required defaultValue={program.name}/></Field>
      <Field label={text('system')}><Select name="system" defaultValue={program.rankSystemId ?? ''}><option value="">{text('unranked')}</option>{systems.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</Select></Field>
      <CheckboxField name="active" defaultChecked={program.active} label={text('active')}/>
      <Button type="submit" variant="outline" aria-label={text('save') + ' ' + program.name}>{text('save')}</Button>
    </fieldset>
  </form>;
}
export function RanksPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={text('loading')}/></Page>;
  if (!bootstrap.data?.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return <Page><Alert>{text('noAccess')}</Alert></Page>;
  const { gym, session } = bootstrap.data;
  return <RanksWorkspace key={gym.id} gymId={gym.id} configure={canStaff(session.roles, 'settings.manage')} promote={canStaff(session.roles, 'promotions.manage')}/>;
}
