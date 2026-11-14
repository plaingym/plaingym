// SPDX-License-Identifier: AGPL-3.0-only
import { instantLabel } from '../../lib/instant.js';
import { useEffect, useId, useRef, useState } from 'react';
import { leadContactChannelSchema, type LeadContact, type LeadContactChannel } from '@plaingym/shared/contracts';
import { ApiError } from '../../lib/api.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select, Textarea } from '../../components/ui/select.js';
import { userNames } from '../../components/ui/page.js';
import { LoadingState } from '../../components/ui/states.js';
import type { Lead, LeadClient } from './api.js';
import { changedOutcome, leadName, type Outcome } from './dialogs.js';
import { text } from './text.js';

const contactText = (key: string, values?: Record<string, string | number>) => text('contacts.' + key, values);
type Logged = Awaited<ReturnType<LeadClient['logContact']>>;
interface FormProps { lead: Lead; client: LeadClient; onSaved(result: Logged): void; onDone(outcome: Outcome): void; onCancel?(): void; onBusy?(busy: boolean): void }

/** Logs a contact now. A new lead becomes contacted; an empty follow-up keeps the lead's current date. */
export function ContactForm({ lead, client, onSaved, onDone, onCancel, onBusy }: FormProps) {
  const id = useId(), [channel, setChannel] = useState<LeadContactChannel>('call'), [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  function busy(value: boolean) { setSaving(value); onBusy?.(value); }
  async function submit(form: HTMLFormElement) {
    if (saving) return;
    if ([...note.trim()].length > 2000) { setError(contactText('noteTooLong')); return; }
    const date = form.elements.namedItem('nextFollowUpOn') as HTMLInputElement;
    if (date.validity.badInput) { setError(contactText('badDate')); return; }
    busy(true); setError('');
    try {
      const result = await client.logContact(lead, { channel, ...(note.trim() ? { note: note.trim() } : {}), ...(followUp ? { nextFollowUpOn: followUp } : {}) });
      setNote(''); setFollowUp(''); busy(false);
      onSaved(result);
    } catch (logError) {
      busy(false);
      if (logError instanceof ApiError && logError.status === 409) { onDone(changedOutcome()); return; }
      setError(text('error'));
    }
  }
  return <form className="min-w-0 space-y-4" aria-label={contactText('formLabel', { name: leadName(lead) })} onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}>
    {error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <div className="min-w-0 space-y-2"><Label htmlFor={id + '-channel'}>{contactText('channel')}</Label>
        <Select id={id + '-channel'} value={channel} disabled={saving} onChange={event => setChannel(event.target.value as LeadContactChannel)}>
          {leadContactChannelSchema.options.map(option => <option key={option} value={option}>{contactText('channel.' + option)}</option>)}
        </Select></div>
      <div className="min-w-0 space-y-2"><Label htmlFor={id + '-follow-up'}>{contactText('nextFollowUp')}</Label>
        <Input id={id + '-follow-up'} name="nextFollowUpOn" type="date" value={followUp} disabled={saving} aria-describedby={id + '-follow-up-help'}
          onChange={event => setFollowUp(event.target.value)} />
        <p id={id + '-follow-up-help'} className="text-sm text-muted-foreground">{contactText('nextFollowUpHelp')}</p></div>
    </div>
    <div className="min-w-0 space-y-2"><Label htmlFor={id + '-note'}>{contactText('note')}</Label>
      <Textarea id={id + '-note'} value={note} disabled={saving} onChange={event => setNote(event.target.value)} /></div>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" className="w-full sm:w-auto" disabled={saving}>{contactText('save')}</Button>
      {onCancel && <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={saving} onClick={onCancel}>{text('cancel')}</Button>}
    </div>
  </form>;
}

/** The list's log-a-contact action. */
export function ContactDialog({ lead, client, onClose, onDone }: { lead: Lead; client: LeadClient; onClose(): void; onDone(outcome: Outcome): void }) {
  const [saving, setSaving] = useState(false);
  return <Dialog title={<span className={userNames}>{contactText('title', { name: leadName(lead) })}</span>} closeLabel={text('close')} onClose={onClose} dismissible={!saving}>
    <ContactForm lead={lead} client={client} onBusy={setSaving} onCancel={onClose} onDone={onDone}
      onSaved={result => onDone({ message: contactText('saved'), reload: true, lead: result.lead })} />
  </Dialog>;
}

const pageSize = 20;
/** The lead's contacts, newest first, in pages; `version` reloads from the first page. */
export function ContactLog({ memberId, client, timezone, version }: { memberId: string; client: LeadClient; timezone: string; version: number }) {
  const [rows, setRows] = useState<LeadContact[]>([]), [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true), [more, setMore] = useState(false), [failed, setFailed] = useState(false);
  // Bumped by every first-page load, so a "Show more" page from before a reload is dropped.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    client.contacts(memberId, { limit: pageSize, offset: 0 }, controller.signal)
      .then(page => { if (controller.signal.aborted) return; setRows(page.data); setTotal(page.pagination.total); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, memberId, version]);
  async function loadMore() {
    const started = generation.current;
    setMore(true); setFailed(false);
    try {
      const page = await client.contacts(memberId, { limit: pageSize, offset: rows.length });
      if (started !== generation.current) return;
      setRows(current => [...current, ...page.data.filter(row => !current.some(have => have.id === row.id))]); setTotal(page.pagination.total);
    } catch { if (started === generation.current) setFailed(true); } finally { setMore(false); }
  }
  if (loading) return <LoadingState />;
  return <div className="min-w-0 space-y-3">
    {failed && <Alert variant="error" role="alert">{contactText('loadError')}</Alert>}
    {rows.length === 0 && !failed ? <p className="text-sm text-muted-foreground">{contactText('empty')}</p>
      : <ol className="divide-y divide-border rounded-lg border border-border">{rows.map(row => <li key={row.id} className="min-w-0 space-y-1 p-3">
        <p className="text-sm font-medium">{contactText('channel.' + row.channel)} · <time dateTime={row.occurredAt}>{instantLabel(row.occurredAt, timezone)}</time></p>
        <p className={'text-sm text-muted-foreground ' + userNames}>{contactText('by', { name: row.createdByName ?? contactText('unknownStaff') })}</p>
        {row.note && <p className={'whitespace-pre-wrap text-sm ' + userNames}>{row.note}</p>}
      </li>)}</ol>}
    {rows.length < total && <Button variant="outline" className="w-full sm:w-auto" disabled={more} onClick={() => void loadMore()}>{text('more')}</Button>}
  </div>;
}
