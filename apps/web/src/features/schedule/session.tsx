// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { classSessionResponseSchema, updateClassSessionRequestSchema, type ClassSession, type ClassTag } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { createRegistries } from '../../lib/registries.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Select, Textarea } from '../../components/ui/select.js';
import { Badge } from '../../components/ui/table.js';
import { useDialogOperation, useDialogSaved } from '../../components/ui/dialog.js';
import { calendarDate, calendarInstant, localTime } from './calendar.js';

export const text = (key: string) => t('schedule/schedule:' + key);
export interface ScheduleOptions { timezone: string; programs: { id: string; name: string }[]; coaches: { id: string; name: string }[] }
export function check(response: Response) {
  if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'error');
}
export function message(error: unknown): string { return text(error instanceof Error && error.message === 'conflict' ? 'conflict' : 'error'); }
export function sessionTimes(session: ClassSession, timezone: string) {
  return `${localTime(new Date(session.startsAt), timezone)}–${localTime(new Date(session.endsAt), timezone)}`;
}
export function SessionPanels({ sessionId, roles, enabledModules = [], registries = createRegistries() }:
  { sessionId: string; roles: readonly StaffRole[]; enabledModules?: readonly string[]; registries?: ReturnType<typeof createRegistries> }) {
  return <>{registries.sessionPanels.forModules(new Set(enabledModules)).filter((entry) => entry.enabled && entry.permission.kind === 'staff' && canStaff(roles, entry.permission.capability)).map((entry) => {
    const Panel = entry.component;
    return <section key={entry.id} aria-labelledby={entry.id} className="space-y-3 border-t border-border pt-6">
      <h3 id={entry.id} className="sr-only">{t(entry.labelKey)}</h3><Panel sessionId={sessionId}/>
    </section>;
  })}</>;
}
/** A label above its control, full width: one column on phones. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <Label className="grid min-w-0 gap-2">{label}{children}</Label>;
}
/** Session detail with its staff actions. `siblings` are the loaded sessions, used to warn before a move collides. */
export function SessionDetail({ session, options, roles, enabledModules, onSaved, tags = [], siblings = [] }:
  { session: ClassSession; options: ScheduleOptions; roles: readonly StaffRole[]; enabledModules: readonly string[]; onSaved: (session: ClassSession) => void;
    tags?: readonly ClassTag[]; siblings?: readonly ClassSession[] }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [editing, setEditing] = useState(false);
  useDialogOperation(busy);
  const markSaved = useDialogSaved();
  const manage = canStaff(roles, 'schedule.manage'), notes = canStaff(roles, 'class_notes.manage');
  async function change(kind: 'coach' | 'notes' | 'capacity' | 'cancel', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const formElement = event?.currentTarget, form = formElement ? new FormData(formElement) : null;
    const id = session.id, revision = session.revision;
    setBusy(true); setNotice('');
    try {
      const params = { path: { id } };
      const result = kind === 'cancel' ? await api.POST('/api/schedule/sessions/{id}/cancel', { params, body: { revision } })
        : kind === 'coach' ? await api.POST('/api/schedule/sessions/{id}/coach', { params, body: { revision, coachId: String(form?.get('coachId') ?? '') || null } })
        : kind === 'capacity' ? await api.PATCH('/api/schedule/sessions/{id}/capacity', { params, body: { revision, capacity: form?.get('capacity') ? Number(form.get('capacity')) : null } })
        : await api.PATCH('/api/schedule/sessions/{id}/notes', { params, body: { revision, notes: String(form?.get('notes') ?? '') || null } });
      check(result.response); if (formElement) markSaved(formElement);
      onSaved(classSessionResponseSchema.parse(result.data).data); setNotice(text('saved'));
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  const when = new Intl.DateTimeFormat(undefined, { timeZone: options.timezone, dateStyle: 'full' }).format(new Date(session.startsAt));
  if (editing) return <SessionForm session={session} options={options} tags={tags} siblings={siblings}
    onCancel={() => setEditing(false)} onSaved={(next) => { setEditing(false); setNotice(text(Date.parse(next.startsAt) === Date.parse(session.startsAt) ? 'saved' : 'moved')); onSaved(next); }}/>;
  return <div className="space-y-6">
    <dl className="grid gap-4 sm:grid-cols-2">
      <div><dt className="text-sm text-muted-foreground">{text('when')}</dt><dd className="font-medium">{when}</dd>
        <dd>{sessionTimes(session, options.timezone)} · {options.timezone}</dd></div>
      <div><dt className="text-sm text-muted-foreground">{text('status')}</dt><dd className="flex flex-wrap gap-2 pt-1">
        <Badge tone={session.status === 'cancelled' ? 'destructive' : 'success'}>{text(session.status)}</Badge><Badge tone="muted">{text(session.kind)}</Badge></dd></div>
      <div><dt className="text-sm text-muted-foreground">{text('coach')}</dt><dd>{options.coaches.find((coach) => coach.id === session.coachId)?.name ?? text('unassigned')}</dd></div>
      <div><dt className="text-sm text-muted-foreground">{text('capacity')}</dt><dd>{session.capacity ?? text('unlimited')}</dd></div>
      {session.notes && <div className="sm:col-span-2"><dt className="text-sm text-muted-foreground">{text('notes')}</dt><dd><p className="whitespace-pre-wrap break-words">{session.notes}</p></dd></div>}
    </dl>
    {notice && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{notice}</p>}
    {manage && <div className="space-y-4">
      <Button variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={() => { setNotice(''); setEditing(true); }}>{text('editSession')}</Button>
      <form key={'coach-' + session.revision} onSubmit={(event) => void change('coach', event)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1"><Field label={text('coach')}><Select name="coachId" defaultValue={session.coachId ?? ''} disabled={busy}>
          <option value="">{text('unassigned')}</option>{options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</Select></Field></div>
        <Button type="submit" disabled={busy}>{text('swapCoach')}</Button></form>
      <form key={'capacity-' + session.revision} onSubmit={(event) => void change('capacity', event)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1"><Field label={text('capacity')}><Input name="capacity" type="number" min={1} step={1} defaultValue={session.capacity ?? ''} disabled={busy}/></Field></div>
        <Button type="submit" disabled={busy}>{text('saveCapacity')}</Button></form>
      <Button variant="outline" className="w-full border-destructive text-destructive sm:w-auto" disabled={busy || session.status === 'cancelled'} onClick={() => void change('cancel')}>{text('cancelSession')}</Button>
    </div>}
    {notes && <form key={'notes-' + session.revision} onSubmit={(event) => void change('notes', event)} className="space-y-2">
      <Field label={text('notes')}><Textarea name="notes" defaultValue={session.notes ?? ''} disabled={busy}/></Field>
      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{text('saveNotes')}</Button></form>}
    <SessionPanels sessionId={session.id} roles={roles} enabledModules={enabledModules}/>
  </div>;
}
/** Edits or moves one session through the full, revision-checked session update. Notes keep their own form. */
export function SessionForm({ session, options, tags, siblings, onSaved, onCancel }:
  { session: ClassSession; options: ScheduleOptions; tags: readonly ClassTag[]; siblings: readonly ClassSession[];
    onSaved: (session: ClassSession) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  useDialogOperation(busy);
  const zone = options.timezone, start = new Date(session.startsAt);
  const duration = Math.max(1, Math.round((Date.parse(session.endsAt) - Date.parse(session.startsAt)) / 60_000));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '');
    setBusy(true); setNotice('');
    try {
      let startsAt: string;
      try { startsAt = calendarInstant(value('date') + 'T' + value('time'), zone); } catch { setNotice(text('invalidTime')); return; }
      const programIds = form.getAll('programIds').map(String);
      if (!programIds.length) { setNotice(text('programRequired')); return; }
      const endsAt = new Date(Date.parse(startsAt) + Number(value('durationMinutes')) * 60_000).toISOString();
      const moved = Date.parse(startsAt) !== Date.parse(session.startsAt);
      // Another session of the same weekly class may not start at exactly the same instant (409 from the server).
      const taken = (instant: string) => siblings.some((other) => other.id !== session.id && other.templateId === session.templateId && Date.parse(other.startsAt) === Date.parse(instant));
      if (moved && session.templateId && taken(startsAt)) { setNotice(text('occupied')); return; }
      const body = updateClassSessionRequestSchema.parse({ name: value('name'), startsAt, endsAt, coachId: value('coachId') || null,
        capacity: value('capacity') ? Number(value('capacity')) : null, notes: session.notes, kind: value('kind') || 'class',
        programIds, tagIds: form.getAll('tagIds').map(String), revision: session.revision });
      const params = { path: { id: session.id } };
      const result = await api.PUT('/api/schedule/sessions/{id}', { params, body });
      if (result.response.status === 409) {
        const error: unknown = result.error;
        const code = typeof error === 'object' && error !== null && 'error' in error
          && typeof error.error === 'object' && error.error !== null && 'code' in error.error ? error.error.code : undefined;
        setNotice(text(code === 'session_start_taken' ? 'occupied' : 'conflict'));
        return;
      }
      check(result.response); onSaved(classSessionResponseSchema.parse(result.data).data);
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  return <form onSubmit={(event) => void save(event)} className="space-y-4" aria-label={text('editSession')}>
    <h3 className="text-base font-semibold">{text('editSession')}</h3>
    <p className="text-sm text-muted-foreground">{text(session.templateId ? 'moveHelp' : 'editHelp')}</p>
    {notice && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{notice}</p>}
    <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label={text('name')}><Input name="name" required defaultValue={session.name}/></Field></div>
      <Field label={text('date')}><Input name="date" type="date" required defaultValue={calendarDate(start, zone)}/></Field>
      <Field label={text('localStartTime')}><Input name="time" type="time" required defaultValue={localTime(start, zone)}/></Field>
      <Field label={text('duration')}><Input name="durationMinutes" type="number" min={1} step={1} required defaultValue={duration}/></Field>
      <Field label={text('coach')}><Select name="coachId" defaultValue={session.coachId ?? ''}><option value="">{text('unassigned')}</option>
        {options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</Select></Field>
      <Field label={text('capacity')}><Input name="capacity" type="number" min={1} step={1} defaultValue={session.capacity ?? ''}/></Field>
      <Field label={text('kind')}><Select name="kind" defaultValue={session.kind}><option value="class">{text('class')}</option><option value="open_mat">{text('open_mat')}</option></Select></Field>
      <Checkboxes legend={text('programs')} name="programIds" items={options.programs} checked={session.programIds}/>
      <Checkboxes legend={text('tags')} name="tagIds" items={tags} checked={session.tagIds}/>
    </fieldset>
    <p className="text-sm text-muted-foreground">{zone} · {text('timeHelp')}</p>
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button type="submit" disabled={busy}>{text('saveSession')}</Button>
      <Button variant="outline" disabled={busy} onClick={onCancel}>{text('back')}</Button>
    </div>
  </form>;
}
export function Checkboxes({ legend, name, items, checked = [] }: { legend: string; name: string; items: readonly { id: string; name: string }[]; checked?: readonly string[] }) {
  return <fieldset className="min-w-0 sm:col-span-2"><legend className="text-sm font-medium">{legend}</legend>
    {items.length ? <div className="grid sm:grid-cols-2">{items.map((item) => <CheckboxField key={item.id} name={name} value={item.id} defaultChecked={checked.includes(item.id)} label={item.name}/>)}</div>
      : <p className="py-2 text-sm text-muted-foreground">{text('none')}</p>}
  </fieldset>;
}
