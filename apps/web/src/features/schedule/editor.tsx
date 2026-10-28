// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { createClassSessionRequestSchema, createClassTemplateRequestSchema, type ClassTag, type ClassTemplate } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Select, Textarea } from '../../components/ui/select.js';
import { calendarInstant } from './calendar.js';
import { Checkboxes, Field, check, message, text, type ScheduleOptions } from './session.js';

/** Creates or edits a weekly class, or creates a one-off session (`standalone`), in a dialog. */
export function ClassEditor({ template, options, tags, onSaved, onClose, standalone = false }:
  { template?: ClassTemplate; options: ScheduleOptions; tags: readonly ClassTag[]; onSaved: () => Promise<void>; onClose: () => void; standalone?: boolean }) {
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '');
    const common = { name: value('name'), coachId: value('coachId') || null, capacity: value('capacity') ? Number(value('capacity')) : null,
      notes: value('notes') || null, kind: value('kind') || 'class', programIds: form.getAll('programIds').map(String), tagIds: form.getAll('tagIds').map(String) };
    if (!common.programIds.length) { setNotice(text('programRequired')); return; }
    setBusy(true); setNotice('');
    try {
      let result;
      if (standalone) {
        let startsAt: string, endsAt: string;
        try { startsAt = calendarInstant(value('startsAt'), options.timezone); endsAt = calendarInstant(value('endsAt'), options.timezone); }
        catch { setNotice(text('invalidTime')); return; }
        result = await api.POST('/api/schedule/sessions', { body: createClassSessionRequestSchema.parse({ ...common, startsAt, endsAt }) });
      } else {
        const body = createClassTemplateRequestSchema.parse({ ...common, weekday: Number(value('weekday')), localStartTime: value('localStartTime'), durationMinutes: Number(value('durationMinutes')) });
        result = template ? await api.PUT('/api/schedule/templates/{id}', { params: { path: { id: template.id } }, body: { ...body, revision: template.revision } })
          : await api.POST('/api/schedule/templates', { body });
      }
      check(result.response); await onSaved(); onClose();
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  const title = text(standalone ? 'newSession' : template ? 'editTemplate' : 'newTemplate');
  return <Dialog title={title} closeLabel={text('closeDialog')} dismissible={!busy} onClose={onClose}>
    <form onSubmit={(event) => void save(event)} className="space-y-4" aria-label={title}>
      {notice && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{notice}</p>}
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label={text('name')}><Input name="name" required defaultValue={template?.name}/></Field></div>
        {standalone ? <>
          <Field label={text('startsAt')}><Input name="startsAt" type="datetime-local" required/></Field>
          <Field label={text('endsAt')}><Input name="endsAt" type="datetime-local" required/></Field>
        </> : <>
          <Field label={text('weekday')}><Select name="weekday" defaultValue={template?.weekday ?? 1}>{Array.from({ length: 7 }, (_, day) => <option value={day} key={day}>{text('day' + day)}</option>)}</Select></Field>
          <Field label={text('localStartTime')}><Input name="localStartTime" type="time" required defaultValue={template?.localStartTime ?? '18:00'}/></Field>
          <Field label={text('duration')}><Input name="durationMinutes" type="number" min={1} step={1} required defaultValue={template?.durationMinutes ?? 60}/></Field>
        </>}
        <Field label={text('coach')}><Select name="coachId" defaultValue={template?.coachId ?? ''}><option value="">{text('unassigned')}</option>{options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</Select></Field>
        <Field label={text('capacity')}><Input name="capacity" type="number" min={1} step={1} defaultValue={template?.capacity ?? ''}/></Field>
        <Field label={text('kind')}><Select name="kind" defaultValue={template?.kind ?? 'class'}><option value="class">{text('class')}</option><option value="open_mat">{text('open_mat')}</option></Select></Field>
        <Checkboxes legend={text('programs')} name="programIds" items={options.programs} {...(template ? { checked: template.programIds } : {})}/>
        <Checkboxes legend={text('tags')} name="tagIds" items={tags} {...(template ? { checked: template.tagIds } : {})}/>
        <div className="sm:col-span-2"><Field label={text('notes')}><Textarea name="notes" defaultValue={template?.notes ?? ''}/></Field></div>
      </fieldset>
      <p className="text-sm text-muted-foreground">{options.timezone} · {text('timeHelp')}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={busy}>{text('save')}</Button>
        <Button variant="outline" onClick={onClose} disabled={busy}>{text('close')}</Button>
      </div>
    </form>
  </Dialog>;
}
