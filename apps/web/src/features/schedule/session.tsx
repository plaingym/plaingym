// SPDX-License-Identifier: AGPL-3.0-only
import { formatCount } from '../../lib/count.js';
import { dateFormatter, timeLabel } from '../../lib/instant.js';
import { parseResponse } from '../../lib/response.js';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { classSessionResponseSchema, restoreSessionResponseSchema, updateClassSessionRequestSchema, type ClassSession, type ClassTag } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { createRegistries } from '../../lib/registries.js';
import { SessionCountsProvider, type SessionCounts } from '../../lib/session-summary.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Select, Textarea } from '../../components/ui/select.js';
import { Badge } from '../../components/ui/table.js';
import { useDialogOperation, useDialogSaved } from '../../components/ui/dialog.js';
import { calendarDate, calendarInstant, localTime } from './calendar.js';
import { useBootstrap } from '../../app/context.js';

export const text = (key: string) => t('schedule/schedule:' + key);
export interface ScheduleOptions { timezone: string; programs: { id: string; name: string }[]; coaches: { id: string; name: string }[] }
export function check(response: Response) {
  if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'error');
}
export function message(error: unknown): string { return text(error instanceof Error && error.message === 'conflict' ? 'conflict' : 'error'); }
export function sessionTimes(session: ClassSession, timezone: string) {
  return `${timeLabel(session.startsAt, timezone)}–${timeLabel(session.endsAt, timezone)}`;
}
/** "Booked 4 of 5 · 2 waitlisted · 3 checked in"; without a capacity, "Booked 4 · …". */
function countsSummary(counts: SessionCounts, capacity: number | null) {
  const text = (key: string, values: Record<string, string>) => t('schedule/schedule:' + key, values);
  const booked = capacity === null ? text('bookedOnly', { booked: formatCount(counts.booked) }) : text('bookedOf', { booked: formatCount(counts.booked), capacity: formatCount(capacity) });
  return [booked, text('waitlistedCount', { count: formatCount(counts.waitlisted) }), text('checkedInCount', { count: formatCount(counts.checkedIn) })].join(' · ');
}
const noticeKeys = {
  email: ['cancelNotifyNone', 'cancelNotifyOne', 'cancelNotify'],
  sms: ['cancelTextNone', 'cancelTextOne', 'cancelText'],
} as const;
/** "Email the 3 booked and waitlisted members", or its one or none variant. */
function noticeLabel(channel: keyof typeof noticeKeys, count: number) {
  return t('schedule/schedule:' + noticeKeys[channel][Math.min(count, 2)], { count: formatCount(count) });
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
/**
 * Under a Coach select with no coaches to offer: where coaches come from, with a link to Staff for those who can
 * manage it. Renders nothing once the gym has a coach. The link opens a new tab, so a half-filled form survives.
 */
export function CoachHint({ id, coaches }: { id: string; coaches: readonly unknown[] }) {
  const roles = useBootstrap().data?.session?.roles;
  if (coaches.length) return null;
  if (!roles) {
    return <div id={id} className="text-sm text-muted-foreground"><p>{text('coachesHelpPending')}</p></div>;
  }
  const canManageStaff = canStaff(roles, 'staff.manage');
  return <div id={id} className="text-sm text-muted-foreground">
    <p>{text(canManageStaff ? 'coachesHelp' : 'coachesHelpAsk')}</p>
    {canManageStaff && <a href="/admin/staff" target="_blank" rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">{text('coachesLink')}</a>}
  </div>;
}
/** Session detail with its staff actions. `siblings` are the loaded sessions, used to warn before a move collides. */
export function SessionDetail({ session, options, roles, enabledModules, onSaved, tags = [], siblings = [], registries }:
  { session: ClassSession; options: ScheduleOptions; roles: readonly StaffRole[]; enabledModules: readonly string[]; onSaved: (session: ClassSession) => void;
    tags?: readonly ClassTag[]; siblings?: readonly ClassSession[]; registries?: ReturnType<typeof createRegistries> }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [editing, setEditing] = useState(false);
  const [emailMembers, setEmailMembers] = useState(false), [textMembers, setTextMembers] = useState(false);
  const [note, setNote] = useState('');
  const [restoreEmail, setRestoreEmail] = useState(false), [restoreText, setRestoreText] = useState(false);
  const textHintId = useId(), restoreHintId = useId(), coachHintId = useId();
  const [now, setNow] = useState(Date.now);
  // The start the server refused a cancel for; a session moved since then (here or elsewhere) is judged afresh.
  const [serverStartedAt, setServerStartedAt] = useState<string | null>(null);
  const startsAt = Date.parse(session.startsAt);
  const started = serverStartedAt === session.startsAt || startsAt <= now;
  const staffProfileId = useBootstrap().data?.session?.staffProfileId;
  // Booking numbers come from whichever session panel publishes them (the bookings panel), not from an import.
  const [counts, setCounts] = useState<SessionCounts | null>(null), [changed, setChanged] = useState(0);
  useDialogOperation(busy);
  const markSaved = useDialogSaved();
  const notify = useCallback(() => setChanged((value) => value + 1), []);
  const manage = canStaff(roles, 'schedule.manage'), notes = canStaff(roles, 'class_notes.manage');
  const mayNotify = roles.some(role => role === 'owner' || role === 'admin')
    || (roles.includes('coach') && !!staffProfileId && staffProfileId === session.coachId);
  const offerNotice = mayNotify && !started && session.status !== 'cancelled' && counts !== null;
  // With nobody left to notify both boxes are off and locked, whatever was ticked before the counts changed.
  const reachable = offerNotice && counts.booked + counts.waitlisted > 0;
  const emailing = reachable && emailMembers, texting = reachable && textMembers, notifying = emailing || texting;
  const channels: ('email' | 'sms')[] = [...(emailing ? ['email' as const] : []), ...(texting ? ['sms' as const] : [])];
  // A cancelled session that hasn't started can be restored; its notice goes only to the members whose places come back.
  const restorable = manage && session.status === 'cancelled' && !started;
  const restoreChannels: ('email' | 'sms')[] = mayNotify ? [...(restoreEmail ? ['email' as const] : []), ...(restoreText ? ['sms' as const] : [])] : [];
  // Only someone who could see the cancel or restore form is told why it went away. Read through a ref so ticking
  // a notice box doesn't re-arm the start timer.
  const startNotice = useRef('');
  useEffect(() => {
    startNotice.current = manage ? text(session.status === 'cancelled' ? 'restoreStarted' : emailing ? 'sessionStartedNoteLost' : 'sessionStarted') : '';
  }, [manage, emailing, session.status]);
  useEffect(() => {
    if (started) return;
    // The timer catches the start while the page is awake; focus and visibility do it after a sleep,
    // when the timer's own deadline may already be in the past.
    const showStarted = (instant: number) => {
      setNow(instant);
      if (startNotice.current) setNotice(startNotice.current);
    };
    const refresh = () => {
      const instant = Date.now();
      if (instant >= startsAt) showStarted(instant);
    };
    const visible = () => { if (!document.hidden) refresh(); };
    let timer: number;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        const instant = Date.now();
        if (instant < startsAt) schedule(startsAt - instant);
        else showStarted(instant);
      }, Math.min(2_147_483_647, delay));
    };
    schedule(Math.max(0, startsAt - Date.now()));
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [started, startsAt, session.status]);
  async function change(kind: 'coach' | 'notes' | 'capacity' | 'cancel', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const formElement = event?.currentTarget, form = formElement ? new FormData(formElement) : null;
    const id = session.id, revision = session.revision;
    setBusy(true); setNotice('');
    try {
      const params = { path: { id } };
      const result = kind === 'cancel' ? await api.POST('/api/schedule/sessions/{id}/cancel', { params,
        body: { revision, ...(notifying ? { notify: true, channels, ...(emailing ? { note } : {}) } : {}) } })
        : kind === 'coach' ? await api.POST('/api/schedule/sessions/{id}/coach', { params, body: { revision, coachId: String(form?.get('coachId') ?? '') || null } })
        : kind === 'capacity' ? await api.PATCH('/api/schedule/sessions/{id}/capacity', { params, body: { revision, capacity: form?.get('capacity') ? Number(form.get('capacity')) : null } })
        : await api.PATCH('/api/schedule/sessions/{id}/notes', { params, body: { revision, notes: String(form?.get('notes') ?? '') || null } });
      const error = result.error as { error?: { details?: { reason?: unknown } } } | undefined;
      const reasons = error?.error?.details?.reason;
      if (kind === 'cancel' && result.response.status === 409 && Array.isArray(reasons) && reasons.includes('session_started')) {
        setServerStartedAt(session.startsAt); setNotice(text(emailing ? 'sessionStartedNoteLost' : 'sessionStarted')); return;
      }
      if (kind === 'cancel' && result.response.status === 409 && Array.isArray(reasons) && reasons.includes('already_cancelled')) {
        setNotice(text('alreadyCancelled'));
        const refreshed = await api.GET('/api/schedule/sessions/{id}', { params });
        check(refreshed.response); onSaved(parseResponse(classSessionResponseSchema, refreshed.data).data);
        setChanged(value => value + 1); return;
      }
      check(result.response); if (formElement) markSaved(formElement);
      onSaved(parseResponse(classSessionResponseSchema, result.data).data); setNotice(text('saved'));
      // The note belongs to this cancellation: a later cancel of the same session (after a restore) starts with an empty box.
      if (kind === 'cancel') setNote('');
      // A new capacity can promote or move bookings, and cancelling a session cancels its bookings, so the panels that show counts reload.
      if (kind === 'capacity' || kind === 'cancel') setChanged((value) => value + 1);
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  async function restore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget, params = { path: { id: session.id } };
    setBusy(true); setNotice('');
    try {
      const result = await api.POST('/api/schedule/sessions/{id}/restore', { params,
        body: { revision: session.revision, ...(restoreChannels.length ? { notify: true, channels: restoreChannels } : {}) } });
      const error = result.error as { error?: { details?: { reason?: unknown } } } | undefined;
      const reasons = result.response.status === 409 ? error?.error?.details?.reason : undefined;
      if (Array.isArray(reasons) && reasons.includes('session_started')) {
        setServerStartedAt(session.startsAt); setNotice(text('restoreStarted')); return;
      }
      if (Array.isArray(reasons) && reasons.includes('not_cancelled')) {
        setNotice(text('notCancelled'));
        const refreshed = await api.GET('/api/schedule/sessions/{id}', { params });
        check(refreshed.response); onSaved(parseResponse(classSessionResponseSchema, refreshed.data).data);
        setChanged(value => value + 1); return;
      }
      check(result.response); markSaved(formElement);
      const restored = parseResponse(restoreSessionResponseSchema, result.data);
      onSaved(restored.data);
      setNotice(text(restored.restoredBookings === 0 ? (restoreChannels.length > 0 ? 'restoredNoneNoNotice' : 'restoredNone') : 'restored'));
      setRestoreEmail(false); setRestoreText(false);
      // Restoring brings bookings back and can promote the waitlist, so the panels that show counts reload.
      setChanged(value => value + 1);
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }
  const when = dateFormatter('fullDate', options.timezone).format(new Date(session.startsAt));
  if (editing) return <SessionForm session={session} options={options} tags={tags} siblings={siblings}
    onCancel={() => setEditing(false)} onSaved={(next) => {
      const moved = Date.parse(next.startsAt) !== Date.parse(session.startsAt);
      setEditing(false); if (moved) setNow(Date.now());
      setNotice(text(moved ? 'moved' : 'saved')); onSaved(next);
    }}/>;
  return <div className="space-y-6">
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div><dt className="text-sm text-muted-foreground">{text('when')}</dt><dd className="font-medium">{when}</dd>
        <dd>{sessionTimes(session, options.timezone)} · {options.timezone}</dd></div>
      <div><dt className="text-sm text-muted-foreground">{text('status')}</dt><dd className="flex flex-wrap gap-2 pt-1">
        <Badge tone={session.status === 'cancelled' ? 'destructive' : 'success'}>{text(session.status)}</Badge><Badge tone="muted">{text(session.kind)}</Badge></dd></div>
      <div><dt className="text-sm text-muted-foreground">{text('coach')}</dt><dd>{options.coaches.find((coach) => coach.id === session.coachId)?.name ?? text('unassigned')}</dd></div>
      <div><dt className="text-sm text-muted-foreground">{text('capacity')}</dt><dd>{session.capacity ?? text('unlimited')}</dd></div>
      {counts && <div className="sm:col-span-2"><dt className="text-sm text-muted-foreground">{text('bookings')}</dt>
        <dd className="font-medium" data-testid="session-counts">{countsSummary(counts, session.capacity)}</dd>
        {counts.stale && <dd className="text-sm text-muted-foreground"><p role="status">{text('staleCounts')}</p></dd>}</div>}
      {session.notes && <div className="sm:col-span-2"><dt className="text-sm text-muted-foreground">{text('notes')}</dt><dd><p className="whitespace-pre-wrap">{session.notes}</p></dd></div>}
    </dl>
    {notice && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{notice}</p>}
    {manage && <div className="space-y-4">
      <Button variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={() => { setNotice(''); setEditing(true); }}>{text('editSession')}</Button>
      <form key={'coach-' + session.revision} onSubmit={(event) => void change('coach', event)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1"><Field label={text('coach')}><Select name="coachId" defaultValue={session.coachId ?? ''} disabled={busy}
          aria-describedby={options.coaches.length ? undefined : coachHintId}>
          <option value="">{text('unassigned')}</option>{options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</Select></Field></div>
        <Button type="submit" disabled={busy}>{text('swapCoach')}</Button></form>
      <CoachHint id={coachHintId} coaches={options.coaches}/>
      <form key={'capacity-' + session.revision} onSubmit={(event) => void change('capacity', event)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1"><Field label={text('capacity')}><Input name="capacity" type="number" min={1} step={1} defaultValue={session.capacity ?? ''} disabled={busy}/></Field></div>
        <Button type="submit" disabled={busy}>{text('saveCapacity')}</Button></form>
      {!started && session.status !== 'cancelled' && <form onSubmit={(event) => void change('cancel', event)} className="space-y-3">
        {offerNotice && <>
          <CheckboxField name="notifyEmail" checked={emailing} disabled={busy || counts.stale || !reachable} onChange={event => setEmailMembers(event.target.checked)}
            label={noticeLabel('email', counts.booked + counts.waitlisted)}/>
          <div>
            <CheckboxField name="notifyText" checked={texting} disabled={busy || counts.stale || !reachable} onChange={event => setTextMembers(event.target.checked)}
              aria-describedby={textHintId} label={noticeLabel('sms', counts.booked + counts.waitlisted)}/>
            <p id={textHintId} className="text-sm text-muted-foreground">{text('cancelTextHint')}</p>
          </div>
          {emailing && <Field label={text('cancelNote')}><Textarea name="note" maxLength={1_000} disabled={busy} value={note} onChange={event => setNote(event.target.value)}/></Field>}
        </>}
        <Button type="submit" variant="outline" className="w-full border-destructive text-destructive sm:w-auto"
          disabled={busy || ((emailMembers || textMembers) && mayNotify && (!counts || counts.stale))}>{text('cancelSession')}</Button>
      </form>}
      {restorable && <form onSubmit={(event) => void restore(event)} className="space-y-3">
        <p className="text-sm text-muted-foreground">{text('restoreHelp')}</p>
        {mayNotify && <>
          <CheckboxField name="restoreEmail" checked={restoreEmail} disabled={busy} onChange={event => setRestoreEmail(event.target.checked)}
            label={text('restoreEmail')}/>
          <div>
            <CheckboxField name="restoreText" checked={restoreText} disabled={busy} onChange={event => setRestoreText(event.target.checked)}
              aria-describedby={restoreHintId} label={text('restoreText')}/>
            <p id={restoreHintId} className="text-sm text-muted-foreground">{text('cancelTextHint')}</p>
          </div>
        </>}
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{text('restoreSession')}</Button>
      </form>}
    </div>}
    {notes && <form key={'notes-' + session.revision} onSubmit={(event) => void change('notes', event)} className="space-y-2">
      <Field label={text('notes')}><Textarea name="notes" defaultValue={session.notes ?? ''} disabled={busy}/></Field>
      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{text('saveNotes')}</Button></form>}
    <SessionCountsProvider publish={setCounts} counts={counts} changed={changed} notify={notify}><SessionPanels sessionId={session.id} roles={roles} enabledModules={enabledModules} {...(registries ? { registries } : {})}/></SessionCountsProvider>
  </div>;
}
/** Edits or moves one session through the full, revision-checked session update. Notes keep their own form. */
export function SessionForm({ session, options, tags, siblings, onSaved, onCancel }:
  { session: ClassSession; options: ScheduleOptions; tags: readonly ClassTag[]; siblings: readonly ClassSession[];
    onSaved: (session: ClassSession) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), coachHintId = useId();
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
      check(result.response); onSaved(parseResponse(classSessionResponseSchema, result.data).data);
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
      <div className="grid min-w-0 gap-2"><Field label={text('coach')}><Select name="coachId" defaultValue={session.coachId ?? ''}
        aria-describedby={options.coaches.length ? undefined : coachHintId}><option value="">{text('unassigned')}</option>
        {options.coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}</Select></Field>
        <CoachHint id={coachHintId} coaches={options.coaches}/></div>
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
