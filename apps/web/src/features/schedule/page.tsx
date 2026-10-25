// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { classSessionListResponseSchema, classTagListResponseSchema, classTemplateListResponseSchema, type ClassSession, type ClassTag, type ClassTemplate } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { useBootstrap } from '../../app/context.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { Select } from '../../components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states.js';
import { StackedItem, StackedList } from '../../components/ui/table.js';
import { calendarDate, calendarInstant, shiftDate, weekStart } from './calendar.js';
import { ClassEditor } from './editor.js';
import { Field, SessionDetail, check, message, text, type ScheduleOptions } from './session.js';
import { AgendaView, WeekView, dayLabel, useWideScreen } from './views.js';

export { SessionDetail, SessionForm, SessionPanels, type ScheduleOptions } from './session.js';
export function SchedulePage() {
  const bootstrap = useBootstrap();
  const roles = bootstrap.data?.session?.roles ?? [], enabledModules = bootstrap.data?.gym.enabledModules ?? [];
  return <ScheduleContent key={bootstrap.data?.gym.id ?? 'pending'} gymId={bootstrap.data?.gym.id} roles={roles} enabledModules={enabledModules}/>;
}
async function allPages<T>(load: (offset: number) => Promise<{ data: T[]; pagination: { total: number } }>) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await load(offset); rows.push(...page.data);
    if (offset + page.data.length >= page.pagination.total || !page.data.length) return rows;
  }
}
function ScheduleContent({ gymId, roles, enabledModules }: { gymId: string | undefined; roles: readonly StaffRole[]; enabledModules: readonly string[] }) {
  const allowed = canStaff(roles, 'bookings.manage'), manage = canStaff(roles, 'schedule.manage');
  const [options, setOptions] = useState<ScheduleOptions>(), [week, setWeek] = useState('');
  const [sessions, setSessions] = useState<ClassSession[]>([]), [templates, setTemplates] = useState<ClassTemplate[]>([]), [tags, setTags] = useState<ClassTag[]>([]);
  const [notice, setNotice] = useState(''), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [selected, setSelected] = useState<ClassSession>();
  const [editor, setEditor] = useState<ClassTemplate | 'new' | 'session'>(), [removing, setRemoving] = useState<ClassTemplate>(), [refresh, setRefresh] = useState(0);
  const [programId, setProgramId] = useState(''), [tagId, setTagId] = useState(''), [coachId, setCoachId] = useState('');
  const wideScreen = useWideScreen(), [layout, setLayout] = useState<'week' | 'agenda'>('week'), [filtersOpen, setFiltersOpen] = useState(false);
  const view = wideScreen ? layout : 'agenda';
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    setFailed(false);
    void api.GET('/api/schedule/options', { signal: controller.signal }).then((result) => {
      check(result.response); if (!result.data || controller.signal.aborted) return;
      setOptions(result.data.data); setWeek((current) => current || weekStart(calendarDate(new Date(), result.data.data.timezone)));
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [allowed, gymId, refresh]);
  useEffect(() => {
    if (!allowed || !options || !week) return;
    const controller = new AbortController(), signal = controller.signal;
    setBusy(true); setFailed(false); setSessions([]);
    async function load() {
      const query = { from: calendarInstant(week + 'T00:00', options!.timezone), until: calendarInstant(shiftDate(week, 7) + 'T00:00', options!.timezone),
        limit: 100, ...(programId ? { programId } : {}), ...(tagId ? { tagId } : {}), ...(coachId ? { coachId } : {}) };
      const rows = await allPages(async (offset) => {
        const result = await api.GET('/api/schedule/sessions', { params: { query: { ...query, offset } }, signal }); check(result.response);
        return classSessionListResponseSchema.parse(result.data);
      });
      const templateRows = await allPages(async (offset) => {
        const result = await api.GET('/api/schedule/templates', { params: { query: { offset, limit: 100 } }, signal }); check(result.response);
        return classTemplateListResponseSchema.parse(result.data);
      });
      const tagRows = await allPages(async (offset) => {
        const result = await api.GET('/api/schedule/tags', { params: { query: { offset, limit: 100 } }, signal }); check(result.response);
        return classTagListResponseSchema.parse(result.data);
      });
      if (!signal.aborted) { setSessions(rows); setTemplates(templateRows); setTags(tagRows); }
    }
    void load().catch(() => { if (!signal.aborted) setFailed(true); }).finally(() => { if (!signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [allowed, options, week, programId, tagId, coachId, refresh]);
  async function reload() { setNotice(''); setRefresh((value) => value + 1); }
  async function run(work: () => Promise<{ response: Response }>) {
    setBusy(true); setNotice('');
    try { check((await work()).response); await reload(); return true; }
    catch (error) { setNotice(message(error)); return false; } finally { setBusy(false); }
  }
  function saveTag(event: FormEvent<HTMLFormElement>, tag?: ClassTag) {
    event.preventDefault(); const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    void run(() => tag ? api.PUT('/api/schedule/tags/{id}', { params: { path: { id: tag.id } }, body: { revision: tag.revision, name } }) : api.POST('/api/schedule/tags', { body: { name } }));
  }
  if (!allowed) return <Page><Alert>{text('forbidden')}</Alert></Page>;
  const today = options ? calendarDate(new Date(), options.timezone) : '';
  const filtered = !!(programId || tagId || coachId);
  const actions = <>{manage && options && <><Button onClick={() => setEditor('new')}>{text('newTemplate')}</Button>
    <Button variant="secondary" onClick={() => setEditor('session')}>{text('newSession')}</Button></>}
    <Button variant="outline" onClick={() => void reload()} disabled={busy}>{text('reload')}</Button></>;
  return <Page>
    <PageHeader title={text('title')} description={options?.timezone} actions={actions}/>
    {notice && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{notice}</p>}
    {failed && <ErrorState message={text('loadFailed')} onRetry={() => void reload()}/>}
    {!options ? !failed && <LoadingState label={text('loading')}/> : <>
      <div className="space-y-3">
        <div className="grid grid-cols-[auto_1fr_auto] items-end gap-2 sm:flex sm:flex-wrap">
          <Button variant="outline" onClick={() => setWeek(shiftDate(week, -7))} aria-label={text('previous')}><span aria-hidden="true">‹</span><span className="hidden sm:inline">{text('previous')}</span></Button>
          <Field label={text('week')}><Input type="date" value={week} onChange={(event) => { if (event.target.value) setWeek(weekStart(event.target.value)); }}/></Field>
          <Button variant="outline" onClick={() => setWeek(shiftDate(week, 7))} aria-label={text('next')}><span className="hidden sm:inline">{text('next')}</span><span aria-hidden="true">›</span></Button>
          <Button variant="ghost" className="col-span-3 sm:col-span-1" disabled={week === weekStart(today)} onClick={() => setWeek(weekStart(today))}>{text('thisWeek')}</Button>
          {wideScreen && <div role="group" aria-label={text('view')} className="ml-auto flex gap-1">
            {(['week', 'agenda'] as const).map((value) => <Button key={value} variant={layout === value ? 'secondary' : 'ghost'} aria-pressed={layout === value} onClick={() => setLayout(value)}>{text('view.' + value)}</Button>)}
          </div>}
        </div>
        <details className="rounded-xl border border-border" open={filtersOpen} onToggle={(event) => setFiltersOpen(event.currentTarget.open)}>
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">{text('filters')}{filtered && ` · ${text('filtersOn')}`}</summary>
          <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-3">
            <Field label={text('programs')}><Select value={programId} onChange={(event) => setProgramId(event.target.value)}><option value="">{text('all')}</option>{options.programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}</Select></Field>
            <Field label={text('tags')}><Select value={tagId} onChange={(event) => setTagId(event.target.value)}><option value="">{text('all')}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</Select></Field>
            <Field label={text('coach')}><Select value={coachId} onChange={(event) => setCoachId(event.target.value)}><option value="">{text('all')}</option>{options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</Select></Field>
          </div>
        </details>
      </div>
      <PageSection title={text('weekOf') + ' ' + (week ? dayLabel(week) : '')}>
        {busy ? <LoadingState label={text('loading')}/> : failed ? null : sessions.length === 0
          ? <EmptyState title={text(filtered ? 'emptyFiltered' : 'empty')} description={text(manage && !filtered ? 'emptyHelp' : 'emptyOtherWeek')}
            action={filtered ? <Button variant="outline" onClick={() => { setProgramId(''); setTagId(''); setCoachId(''); }}>{text('clearFilters')}</Button>
              : manage ? <Button onClick={() => setEditor('new')}>{text('newTemplate')}</Button> : undefined}/>
          : view === 'week' ? <WeekView week={week} today={today} sessions={sessions} options={options} onOpen={setSelected}/>
          : <AgendaView week={week} today={today} sessions={sessions} options={options} onOpen={setSelected}/>}
      </PageSection>
      {selected && <Dialog title={selected.name} description={dayLabel(calendarDate(new Date(selected.startsAt), options.timezone))} closeLabel={text('closeDialog')} size="wide" onClose={() => setSelected(undefined)}>
        <SessionDetail key={selected.id} session={selected} options={options} roles={roles} enabledModules={enabledModules} tags={tags} siblings={sessions}
          onSaved={(next) => {
            setSelected(next); setSessions((rows) => rows.map((row) => row.id === next.id ? next : row));
            // A move can change the day or the week; reload the calendar behind the dialog.
            if (Date.parse(next.startsAt) !== Date.parse(selected.startsAt)) void reload();
          }}/>
      </Dialog>}
      {manage && <>
        {editor && <ClassEditor key={typeof editor === 'string' ? editor : editor.id} {...(typeof editor === 'object' ? { template: editor } : {})} standalone={editor === 'session'} options={options} tags={tags} onSaved={reload} onClose={() => setEditor(undefined)}/>}
        {removing && <Dialog title={text('deleteTemplate')} description={removing.name} closeLabel={text('closeDialog')} onClose={() => setRemoving(undefined)}>
          <p>{text('deleteTemplateConfirm')}</p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <Button variant="destructive" disabled={busy} onClick={() => void run(() => api.DELETE('/api/schedule/templates/{id}', { params: { path: { id: removing.id } }, body: { revision: removing.revision } })).then(() => setRemoving(undefined))}>{text('delete')}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(undefined)}>{text('close')}</Button>
          </div>
        </Dialog>}
        <PageSection title={text('templates')} description={text('templateHelp')}>
          {templates.length === 0 ? <EmptyState title={text('noTemplates')} description={text('noTemplatesHelp')}/>
            : <StackedList>{templates.map((template) => <StackedItem key={template.id} className="sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0"><p className="break-words font-medium">{template.name}</p>
                <p className="text-sm text-muted-foreground">{text('day' + template.weekday)} {template.localStartTime} · {template.durationMinutes} {text('minutes')}
                  {template.coachId && ' · ' + (options.coaches.find((coach) => coach.id === template.coachId)?.name ?? '')}</p></div>
              <div className="grid grid-cols-2 gap-2 pt-2 sm:flex sm:pt-0">
                <Button variant="outline" onClick={() => setEditor(template)} aria-label={text('edit') + ' ' + template.name}>{text('edit')}</Button>
                <Button variant="outline" disabled={busy} onClick={() => setRemoving(template)} aria-label={text('delete') + ' ' + template.name}>{text('delete')}</Button>
              </div>
            </StackedItem>)}</StackedList>}
        </PageSection>
        <PageSection title={text('tags')}>
          <form onSubmit={(event) => saveTag(event)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1"><Field label={text('newTag')}><Input name="name" required/></Field></div><Button type="submit" disabled={busy}>{text('create')}</Button></form>
          {tags.length > 0 && <StackedList>{tags.map((tag) => <StackedItem key={tag.id + ':' + tag.revision}>
            <form onSubmit={(event) => saveTag(event, tag)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1"><Field label={text('tagName')}><Input name="name" required defaultValue={tag.name}/></Field></div>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button type="submit" variant="outline" disabled={busy}>{text('save')}</Button>
                <Button variant="outline" disabled={busy} onClick={() => void run(() => api.DELETE('/api/schedule/tags/{id}', { params: { path: { id: tag.id } }, body: { revision: tag.revision } }))}>{text('delete')}</Button>
              </div>
            </form>
          </StackedItem>)}</StackedList>}
        </PageSection>
      </>}
    </>}
  </Page>;
}
