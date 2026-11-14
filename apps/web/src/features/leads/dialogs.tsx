// SPDX-License-Identifier: AGPL-3.0-only
import { instantLabel } from '../../lib/instant.js';
import { useEffect, useId, useState } from 'react';
import type { ClassSession, LeadStage } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { ApiError } from '../../lib/api.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select, Textarea } from '../../components/ui/select.js';
import { userNames } from '../../components/ui/page.js';
import type { Lead, LeadClient } from './api.js';
import { text } from './text.js';

/** What a finished action tells the screen: a message and whether the lists must reload. */
export interface Outcome { message: string; error?: boolean; reload: boolean; lead?: Lead; stages?: readonly LeadStage[] | undefined }
export const leadName = (lead: Lead) => `${lead.firstName} ${lead.lastName}`.trim();
const conflict = (error: unknown) => error instanceof ApiError && error.status === 409;
export const changedOutcome = (): Outcome => ({ message: text('changed'), error: true, reload: true });
const sessionLabel = (session: ClassSession, timezone: string) => `${session.name} · ${instantLabel(session.startsAt, timezone)}`;

interface DialogProps { lead: Lead; client: LeadClient; onClose(): void; onDone(outcome: Outcome): void }

/** Books through the staff booking route; the stage moves only after the booking succeeded. */
export function BookDialog({ lead, client, timezone, onClose, onDone }: DialogProps & { timezone: string }) {
  const id = useId(), [today] = useState(() => localDate(new Date(), timezone)), [date, setDate] = useState(today);
  const [sessions, setSessions] = useState<ClassSession[]>([]), [session, setSession] = useState('');
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!date) return;
    let active = true; setLoading(true); setSession(''); setError(''); setSessions([]);
    // The booking route refuses a class that has started, so only later ones are offered.
    client.sessions(date, timezone).then(rows => { if (active) setSessions(rows.filter(row => Date.parse(row.startsAt) > Date.now())); })
      .catch(() => { if (active) setError(text('sessionError')); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, date, timezone]);
  async function submit() {
    if (saving || !session) return;
    setSaving(true); setError('');
    try { await client.book({ memberId: lead.memberId, sessionId: session, allowWaitlist: false }); }
    catch (error) {
      const reason = error instanceof ApiError && error.status === 409 ? error.reason[0] : undefined;
      const messages: Record<string, string> = { full: 'bookingFull', alreadyBooked: 'bookingExists', sessionClosed: 'bookingClosed',
        noReservation: 'bookingNoReservation', windowClosed: 'bookingWindowClosed' };
      setError(text(reason && messages[reason] || 'bookingFailed')); setSaving(false); return;
    }
    // The class is booked; from here the dialog closes whatever happens to the stage.
    if (lead.stage !== 'new' && lead.stage !== 'contacted') { onDone({ message: text('booked'), reload: true, lead }); return; }
    try { const updated = await client.edit(lead, { stage: 'trial_booked' }); onDone({ message: text('booked'), reload: true, lead: updated }); }
    catch (stageError) {
      onDone({ message: text(conflict(stageError) ? 'bookedStageChanged' : 'bookedStageFailed'), error: true, reload: true });
    }
  }
  return <Dialog title={<span className={userNames}>{text('bookTitle', { name: leadName(lead) })}</span>} closeLabel={text('close')} onClose={onClose} dismissible={!saving}>
    <form className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
      <p className="text-sm text-muted-foreground">{text('bookHelp', { timezone })}</p>
      <div className="space-y-2"><Label htmlFor={id + '-date'}>{text('date')}</Label>
        <Input id={id + '-date'} type="date" min={today} value={date} disabled={saving} onChange={event => setDate(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor={id + '-session'}>{text('session')}</Label>
        <Select id={id + '-session'} value={session} disabled={saving || loading} onChange={event => setSession(event.target.value)}>
          <option value="">{text('chooseSession')}</option>
          {sessions.map(row => <option key={row.id} value={row.id}>{sessionLabel(row, timezone)}</option>)}
        </Select></div>
      {!loading && !error && sessions.length === 0 && <p className="text-sm">{text('noSessions')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="w-full sm:w-auto" disabled={saving || loading || !session}>{text('book')}</Button>
        <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={saving} onClick={onClose}>{text('cancel')}</Button>
      </div>
    </form>
  </Dialog>;
}

export function LostDialog({ lead, client, onClose, onDone }: DialogProps) {
  const id = useId(), [reason, setReason] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  async function submit() {
    if (saving || !reason.trim()) return;
    if ([...reason.trim()].length > 500) { setError(text('reasonTooLong')); return; }
    setSaving(true); setError('');
    try { const updated = await client.lost(lead, reason.trim()); onDone({ message: text('lostSaved'), reload: true, lead: updated }); }
    catch (lostError) {
      if (conflict(lostError)) { onDone(changedOutcome()); return; }
      setError(text('error')); setSaving(false);
    }
  }
  return <Dialog title={<span className={userNames}>{text('lostTitle', { name: leadName(lead) })}</span>} closeLabel={text('close')} onClose={onClose} dismissible={!saving} unsavedChanges={reason !== ''}>
    <form className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
      <div className="space-y-2"><Label htmlFor={id + '-reason'}>{text('reason')}</Label>
        <Textarea id={id + '-reason'} required value={reason} disabled={saving} onChange={event => setReason(event.target.value)} /></div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" className="w-full sm:w-auto" disabled={saving || !reason.trim()}>{text('lost')}</Button>
        <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={saving} onClick={onClose}>{text('cancel')}</Button>
      </div>
    </form>
  </Dialog>;
}
