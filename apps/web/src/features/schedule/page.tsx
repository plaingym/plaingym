// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { classSessionListResponseSchema, classSessionResponseSchema, classTagListResponseSchema, classTemplateListResponseSchema, createClassSessionRequestSchema, createClassTemplateRequestSchema, type ClassSession, type ClassTag, type ClassTemplate } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { useBootstrap } from '../../app/context.js';
import { createRegistries } from '../../lib/registries.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { calendarDate, calendarInstant, shiftDate, weekStart } from './calendar.js';

const text = (key: string) => t('schedule/schedule:' + key);
export interface ScheduleOptions { timezone: string; programs: { id: string; name: string }[]; coaches: { id: string; name: string }[] }
function check(response: Response) {
  if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'error');
}
function message(error: unknown): string { return text(error instanceof Error && error.message === 'conflict' ? 'conflict' : 'error'); }
const fields = 'block w-full rounded border border-input bg-background px-3 py-2';
export function SessionPanels({ sessionId, roles, enabledModules = [], registries = createRegistries() }:
  { sessionId: string; roles: readonly StaffRole[]; enabledModules?: readonly string[]; registries?: ReturnType<typeof createRegistries> }) {
  return <>{registries.sessionPanels.forModules(new Set(enabledModules)).filter((entry) => entry.enabled && entry.permission.kind === 'staff' && canStaff(roles, entry.permission.capability)).map((entry) => {
    const Panel = entry.component;
    return <section key={entry.id} aria-labelledby={entry.id}><h3 id={entry.id}>{t(entry.labelKey)}</h3><Panel sessionId={sessionId}/></section>;
  })}</>;
}
export function SessionDetail({ session, options, roles, enabledModules, onSaved }:
  { session: ClassSession; options: ScheduleOptions; roles: readonly StaffRole[]; enabledModules: readonly string[]; onSaved: (session: ClassSession) => void }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const manage = canStaff(roles, 'schedule.manage'), notes = canStaff(roles, 'class_notes.manage');
  async function change(kind: 'coach' | 'notes' | 'capacity' | 'cancel', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const form = event ? new FormData(event.currentTarget) : null;
    const id = session.id, revision = session.revision;
    setBusy(true); setNotice('');
    try {
      const params = { path: { id } };
      const result = kind === 'cancel' ? await api.POST('/api/schedule/sessions/{id}/cancel', { params, body: { revision } })
        : kind === 'coach' ? await api.POST('/api/schedule/sessions/{id}/coach', { params, body: { revision, coachId: String(form?.get('coachId') ?? '') || null } })
        : kind === 'capacity' ? await api.PATCH('/api/schedule/sessions/{id}/capacity', { params, body: { revision, capacity: form?.get('capacity') ? Number(form.get('capacity')) : null } })
        : await api.PATCH('/api/schedule/sessions/{id}/notes', { params, body: { revision, notes: String(form?.get('notes') ?? '') || null } });
      check(result.response); onSaved(classSessionResponseSchema.parse(result.data).data); setNotice(text('saved'));
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  return <article className="space-y-4 rounded border p-4">
    <h2 className="text-xl font-semibold">{session.name}</h2>
    <p>{new Intl.DateTimeFormat(undefined, { timeZone: options.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(session.startsAt))} · {options.timezone}</p>
    <p>{text(session.status)} · {text(session.kind)}</p>
    <p>{options.coaches.find((coach) => coach.id === session.coachId)?.name ?? text('unassigned')}</p>
    <p>{text('capacity')}: {session.capacity ?? text('unlimited')}</p>
    <p className="whitespace-pre-wrap">{session.notes}</p>
    {notice && <p role="status">{notice}</p>}
    {manage && <><form onSubmit={(event) => void change('coach', event)} className="flex flex-wrap items-end gap-2">
      <Label className="block">{text('coach')}<select name="coachId" defaultValue={session.coachId ?? ''} disabled={busy} className={fields}><option value="">{text('unassigned')}</option>{options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</select></Label>
      <Button type="submit" disabled={busy}>{text('swapCoach')}</Button></form>
      <form onSubmit={(event) => void change('capacity', event)} className="flex items-end gap-2"><Label>{text('capacity')}<Input name="capacity" type="number" min={1} step={1} defaultValue={session.capacity ?? ''} disabled={busy}/></Label><Button type="submit" disabled={busy}>{text('saveCapacity')}</Button></form>
      <Button variant="outline" disabled={busy || session.status === 'cancelled'} onClick={() => void change('cancel')}>{text('cancelSession')}</Button></>}
    {notes && <form onSubmit={(event) => void change('notes', event)} className="space-y-2"><Label className="block">{text('notes')}<textarea name="notes" defaultValue={session.notes ?? ''} disabled={busy} className={fields}/></Label><Button type="submit" disabled={busy}>{text('saveNotes')}</Button></form>}
    <SessionPanels sessionId={session.id} roles={roles} enabledModules={enabledModules}/>
  </article>;
}
function ClassEditor({ template, options, tags, onSaved, onClose, standalone = false }:
  { template?: ClassTemplate; options: ScheduleOptions; tags: readonly ClassTag[]; onSaved: () => Promise<void>; onClose: () => void; standalone?: boolean }) {
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '');
    const common = { name: value('name'), coachId: value('coachId') || null, capacity: value('capacity') ? Number(value('capacity')) : null,
      notes: value('notes') || null, kind: value('kind') || 'class', programIds: form.getAll('programIds').map(String), tagIds: form.getAll('tagIds').map(String) };
    setBusy(true); setNotice('');
    try {
      let result;
      if (standalone) {
        const body = createClassSessionRequestSchema.parse({ ...common, startsAt: calendarInstant(value('startsAt'), options.timezone), endsAt: calendarInstant(value('endsAt'), options.timezone) });
        result = await api.POST('/api/schedule/sessions', { body });
      } else {
        const body = createClassTemplateRequestSchema.parse({ ...common, weekday: Number(value('weekday')), localStartTime: value('localStartTime'), durationMinutes: Number(value('durationMinutes')) });
        result = template ? await api.PUT('/api/schedule/templates/{id}', { params: { path: { id: template.id } }, body: { ...body, revision: template.revision } })
          : await api.POST('/api/schedule/templates', { body });
      }
      check(result.response); await onSaved(); onClose();
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  return <form onSubmit={(event) => void save(event)} className="space-y-3 rounded border p-4">
    <h2>{text(standalone ? 'newSession' : template ? 'editTemplate' : 'newTemplate')}</h2>
    {notice && <p role="alert">{notice}</p>}
    <fieldset disabled={busy} className="grid gap-3 md:grid-cols-2">
      <Label className="block">{text('name')}<Input name="name" required defaultValue={template?.name}/></Label>
      {standalone ? <><Label className="block">{text('startsAt')}<Input name="startsAt" type="datetime-local" required/></Label><Label className="block">{text('endsAt')}<Input name="endsAt" type="datetime-local" required/></Label></> : <>
        <Label className="block">{text('weekday')}<select name="weekday" defaultValue={template?.weekday ?? 1} className={fields}>{Array.from({ length: 7 }, (_, day) => <option value={day} key={day}>{text('day' + day)}</option>)}</select></Label>
        <Label className="block">{text('localStartTime')}<Input name="localStartTime" type="time" required defaultValue={template?.localStartTime ?? '18:00'}/></Label>
        <Label className="block">{text('duration')}<Input name="durationMinutes" type="number" min={1} step={1} required defaultValue={template?.durationMinutes ?? 60}/></Label></>}
      <Label className="block">{text('coach')}<select name="coachId" defaultValue={template?.coachId ?? ''} className={fields}><option value="">{text('unassigned')}</option>{options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</select></Label>
      <Label className="block">{text('capacity')}<Input name="capacity" type="number" min={1} step={1} defaultValue={template?.capacity ?? ''}/></Label>
      <Label className="block">{text('kind')}<select name="kind" defaultValue={template?.kind ?? 'class'} className={fields}><option value="class">{text('class')}</option><option value="open_mat">{text('open_mat')}</option></select></Label>
      <fieldset><legend>{text('programs')}</legend>{options.programs.map((program) => <label className="block" key={program.id}><input type="checkbox" name="programIds" value={program.id} defaultChecked={template?.programIds.includes(program.id)}/> {program.name}</label>)}</fieldset>
      <fieldset><legend>{text('tags')}</legend>{tags.map((tag) => <label className="block" key={tag.id}><input type="checkbox" name="tagIds" value={tag.id} defaultChecked={template?.tagIds.includes(tag.id)}/> {tag.name}</label>)}</fieldset>
      <Label className="block">{text('notes')}<textarea name="notes" defaultValue={template?.notes ?? ''} className={fields}/></Label>
    </fieldset>
    <p>{options.timezone} · {text('timeHelp')}</p>
    <Button type="submit" disabled={busy}>{text('save')}</Button> <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{text('close')}</Button>
  </form>;
}
export function SchedulePage() {
  const bootstrap = useBootstrap();
  const roles = bootstrap.data?.session?.roles ?? [], enabledModules = bootstrap.data?.gym.enabledModules ?? [];
  return <ScheduleContent key={bootstrap.data?.gym.id ?? 'pending'} gymId={bootstrap.data?.gym.id} roles={roles} enabledModules={enabledModules}/>;
}
function ScheduleContent({ gymId, roles, enabledModules }: { gymId: string | undefined; roles: readonly StaffRole[]; enabledModules: readonly string[] }) {
  const allowed = canStaff(roles, 'bookings.manage'), manage = canStaff(roles, 'schedule.manage');
  const [options, setOptions] = useState<ScheduleOptions>(), [week, setWeek] = useState('');
  const [sessions, setSessions] = useState<ClassSession[]>([]), [templates, setTemplates] = useState<ClassTemplate[]>([]), [tags, setTags] = useState<ClassTag[]>([]);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [selectedId, setSelectedId] = useState<string>();
  const [editor, setEditor] = useState<ClassTemplate | 'new' | 'session'>(), [refresh, setRefresh] = useState(0);
  const [programId, setProgramId] = useState(''), [tagId, setTagId] = useState(''), [coachId, setCoachId] = useState('');
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    setNotice('');
    void api.GET('/api/schedule/options', { signal: controller.signal }).then((result) => {
      check(result.response); if (!result.data || controller.signal.aborted) return;
      setOptions(result.data.data); setWeek((current) => current || weekStart(calendarDate(new Date(), result.data.data.timezone)));
    }).catch(() => { if (!controller.signal.aborted) setNotice(text('error')); });
    return () => controller.abort();
  }, [allowed, gymId, refresh]);
  useEffect(() => {
    if (!allowed || !options || !week) return;
    const controller = new AbortController();
    setBusy(true); setNotice(''); setSessions([]);
    async function load() {
      const query = { from: calendarInstant(week + 'T00:00', options!.timezone), until: calendarInstant(shiftDate(week, 7) + 'T00:00', options!.timezone),
        limit: 100, ...(programId ? { programId } : {}), ...(tagId ? { tagId } : {}), ...(coachId ? { coachId } : {}) };
      const rows: ClassSession[] = [], templateRows: ClassTemplate[] = [], tagRows: ClassTag[] = [];
      for (let offset = 0; ; offset += 100) {
        const result = await api.GET('/api/schedule/sessions', { params: { query: { ...query, offset } }, signal: controller.signal }); check(result.response);
        const page = classSessionListResponseSchema.parse(result.data); rows.push(...page.data);
        if (offset + page.data.length >= page.pagination.total || !page.data.length) break;
      }
      for (let offset = 0; ; offset += 100) {
        const result = await api.GET('/api/schedule/templates', { params: { query: { offset, limit: 100 } }, signal: controller.signal }); check(result.response);
        const page = classTemplateListResponseSchema.parse(result.data); templateRows.push(...page.data);
        if (offset + page.data.length >= page.pagination.total || !page.data.length) break;
      }
      for (let offset = 0; ; offset += 100) {
        const result = await api.GET('/api/schedule/tags', { params: { query: { offset, limit: 100 } }, signal: controller.signal }); check(result.response);
        const page = classTagListResponseSchema.parse(result.data); tagRows.push(...page.data);
        if (offset + page.data.length >= page.pagination.total || !page.data.length) break;
      }
      if (!controller.signal.aborted) { setSessions(rows); setTemplates(templateRows); setTags(tagRows); }
    }
    void load().catch(() => { if (!controller.signal.aborted) setNotice(text('error')); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [allowed, options, week, programId, tagId, coachId, refresh]);
  async function reload() { setRefresh((value) => value + 1); }
  async function removeTemplate(template: ClassTemplate) {
    if (!window.confirm(text('deleteTemplateConfirm'))) return;
    setBusy(true);
    try { const result = await api.DELETE('/api/schedule/templates/{id}', { params: { path: { id: template.id } }, body: { revision: template.revision } }); check(result.response); await reload(); }
    catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  async function saveTag(event: FormEvent<HTMLFormElement>, tag?: ClassTag) {
    event.preventDefault(); const form = new FormData(event.currentTarget), name = String(form.get('name') ?? '').trim();
    setBusy(true);
    try {
      const result = tag ? await api.PUT('/api/schedule/tags/{id}', { params: { path: { id: tag.id } }, body: { revision: tag.revision, name } }) : await api.POST('/api/schedule/tags', { body: { name } });
      check(result.response); await reload();
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  async function removeTag(tag: ClassTag) {
    setBusy(true);
    try { const result = await api.DELETE('/api/schedule/tags/{id}', { params: { path: { id: tag.id } }, body: { revision: tag.revision } }); check(result.response); await reload(); }
    catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  if (!allowed) return <p role="alert">{text('forbidden')}</p>;
  const selected = sessions.find((session) => session.id === selectedId);
  return <div className="space-y-6"><h1 className="text-2xl font-semibold">{text('title')}</h1>
    {notice && <p role="alert">{notice}</p>}
    <Button variant="outline" onClick={() => void reload()} disabled={busy}>{text('reload')}</Button>
    {options && <><p>{options.timezone}</p><div className="flex flex-wrap items-end gap-3">
      <Button variant="outline" onClick={() => setWeek(shiftDate(week, -7))}>{text('previous')}</Button>
      <Label>{text('week')}<Input type="date" value={week} onChange={(event) => { if (event.target.value) setWeek(weekStart(event.target.value)); }}/></Label>
      <Button variant="outline" onClick={() => setWeek(shiftDate(week, 7))}>{text('next')}</Button>
      <Label>{text('programs')}<select className={fields} value={programId} onChange={(event) => setProgramId(event.target.value)}><option value="">{text('all')}</option>{options.programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}</select></Label>
      <Label>{text('tags')}<select className={fields} value={tagId} onChange={(event) => setTagId(event.target.value)}><option value="">{text('all')}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></Label>
      <Label>{text('coach')}<select className={fields} value={coachId} onChange={(event) => setCoachId(event.target.value)}><option value="">{text('all')}</option>{options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</select></Label>
    </div>
    {busy && <p role="status">{text('loading')}</p>}
    <div className="grid gap-2 md:grid-cols-7">{Array.from({ length: 7 }, (_, day) => shiftDate(week, day)).map((date) => <section key={date} className="min-w-0 rounded border p-2"><h2>{date}</h2>
      {sessions.filter((session) => calendarDate(new Date(session.startsAt), options.timezone) === date).map((session) => <Button key={session.id} variant="outline" className="my-1 h-auto w-full whitespace-normal" onClick={() => setSelectedId(session.id)}>
        {new Intl.DateTimeFormat(undefined, { timeZone: options.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(session.startsAt))} {session.name} · {text(session.status)}
      </Button>)}</section>)}</div>
    {!busy && sessions.length === 0 && <p>{text('empty')}</p>}
    {selected && <SessionDetail key={selected.id + ':' + selected.revision} session={selected} options={options} roles={roles} enabledModules={enabledModules} onSaved={(next) => setSessions((rows) => rows.map((row) => row.id === next.id ? next : row))}/>}
    {manage && <><div className="flex gap-2"><Button onClick={() => setEditor('new')}>{text('newTemplate')}</Button><Button onClick={() => setEditor('session')}>{text('newSession')}</Button></div>
      {editor && <ClassEditor key={typeof editor === 'string' ? editor : editor.id} {...(typeof editor === 'object' ? { template: editor } : {})} standalone={editor === 'session'} options={options} tags={tags} onSaved={reload} onClose={() => setEditor(undefined)}/>}
      <section><h2>{text('templates')}</h2><p>{text('templateHelp')}</p><ul>{templates.map((template) => <li className="my-2 flex flex-wrap items-center gap-2" key={template.id}>
        <span>{template.name} · {text('day' + template.weekday)} {template.localStartTime}</span>
        <Button variant="outline" onClick={() => setEditor(template)}>{text('edit')}</Button><Button variant="outline" onClick={() => void removeTemplate(template)} disabled={busy}>{text('delete')}</Button>
      </li>)}</ul></section>
      <section><h2>{text('tags')}</h2><form onSubmit={(event) => void saveTag(event)} className="flex items-end gap-2"><Label>{text('newTag')}<Input name="name" required/></Label><Button type="submit" disabled={busy}>{text('create')}</Button></form>
        {tags.map((tag) => <form key={tag.id + ':' + tag.revision} onSubmit={(event) => void saveTag(event, tag)} className="my-2 flex items-end gap-2"><Label>{text('name')}<Input name="name" required defaultValue={tag.name}/></Label><Button type="submit" disabled={busy}>{text('save')}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void removeTag(tag)}>{text('delete')}</Button></form>)}</section>
    </>}</>}
  </div>;
}
