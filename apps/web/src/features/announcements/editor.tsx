// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { announcementDraftSchema, type AnnouncementDraft, type Program } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Textarea } from '../../components/ui/select.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import type { Announcement, AnnouncementClient } from './api.js';
import { Failure, text } from './messages.js';

const statuses = ['active', 'trial', 'frozen'] as const;
export function AnnouncementEditor({ gymName, programs, client, close, sent }: {
  gymName: string; programs: Program[]; client: AnnouncementClient; close(): void; sent(announcement: Announcement): void;
}) {
  const [subject, setSubject] = useState(''), [body, setBody] = useState('');
  const [selectedStatuses, setStatuses] = useState<AnnouncementDraft['audience']['statuses']>([...statuses]);
  const [programIds, setPrograms] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ draft: AnnouncementDraft; count: number } | null>(null);
  const [confirming, setConfirming] = useState(false), [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<'previewError' | 'testError' | 'sendError' | null>(null);
  const [error, setError] = useState<{ cause: unknown; fallback: string } | null>(null);
  const busy = pending !== null;
  const [testSent, setTestSent] = useState(false);
  const inFlight = useRef(false), generation = useRef<string | null>(null);
  async function run(operation: () => Promise<void>, fallback: 'previewError' | 'testError' | 'sendError') {
    if (inFlight.current) return;
    inFlight.current = true; setPending(fallback); setError(null); setTestSent(false);
    try { await operation(); } catch (cause) { setError({ cause, fallback }); }
    finally { inFlight.current = false; setPending(null); }
  }
  function toggle<T>(values: T[], value: T, checked: boolean) { return checked ? [...values, value] : values.filter(item => item !== value); }
  return <Dialog title={text(confirming ? 'confirmTitle' : preview ? 'previewTitle' : 'compose')} closeLabel={text('close')}
    onClose={close} dismissible={!busy} unsavedChanges={!!subject || !!body}>
    <div className="min-w-0 space-y-4 wrap-anywhere">
      {!preview ? <form className="space-y-4" onSubmit={event => {
        event.preventDefault();
        const parsed = announcementDraftSchema.safeParse({ subject, body, audience: { statuses: selectedStatuses, programIds } });
        if (!parsed.success) { setError({ cause: null, fallback: 'invalid' }); return; }
        void run(async () => {
          const result = await client.preview(parsed.data);
          generation.current = crypto.randomUUID();
          setPreview({ draft: parsed.data, count: result.recipientCount });
        }, 'previewError');
      }}>
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <div><Label htmlFor="announcement-subject">{text('subject')}</Label>
            <Input id="announcement-subject" value={subject} maxLength={150} required aria-describedby="subject-count" onChange={event => setSubject(event.target.value)} />
            <p id="subject-count" className="text-sm text-muted-foreground">{text('characters', { count: subject.length, max: 150 })}</p></div>
          <div><Label htmlFor="announcement-body">{text('body')}</Label>
            <Textarea id="announcement-body" rows={8} value={body} maxLength={10000} required aria-describedby="body-count" onChange={event => setBody(event.target.value)} />
            <p id="body-count" className="text-sm text-muted-foreground">{text('characters', { count: body.length, max: 10000 })}</p></div>
          <fieldset className="space-y-2"><legend className="font-medium">{text('statuses')}</legend>
            <p className="text-sm text-muted-foreground">{text('statusHelp')}</p>
            {statuses.map(status => <CheckboxField key={status} label={text(status)} checked={selectedStatuses.includes(status)}
              onChange={event => setStatuses(toggle(selectedStatuses, status, event.target.checked))} />)}</fieldset>
          <fieldset className="min-w-0 space-y-2"><legend className="font-medium">{text('programs')}</legend>
            <p className="text-sm text-muted-foreground">{text('programHelp')}</p>
            <div className="max-h-64 overflow-y-auto">{programs.map(program => <CheckboxField key={program.id}
              label={program.name} checked={programIds.includes(program.id)} disabled={programIds.length >= 100 && !programIds.includes(program.id)}
              onChange={event => setPrograms(toggle(programIds, program.id, event.target.checked))} />)}</div></fieldset>
          <Button type="submit" className="w-full sm:w-auto">{text(busy ? 'working' : 'preview')}</Button>
        </fieldset>
      </form> : <>
        <p className="font-medium">{text('recipients', { count: preview.count })}</p>
        <p className="text-sm text-muted-foreground">{text('audienceHelp')}</p>
        <section aria-label={text('messagePreview')} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          <h3 className="font-semibold">{preview.draft.subject}</h3>
          <p>{gymName}</p>
          <p className="whitespace-pre-wrap">{preview.draft.body}</p>
          <p className="border-t border-border pt-4 text-sm text-muted-foreground">{t('announcements/send:unsubscribe')}</p>
        </section>
        <p className="text-sm text-muted-foreground">{text('testHelp')}</p>
        {confirming && <Alert role="note">{text('confirmHelp')}</Alert>}
        {preview.count === 0 && <Alert role="note">{text('noRecipients')}</Alert>}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {!attempted && <Button variant="outline" disabled={busy} onClick={() => { setPreview(null); setConfirming(false); setError(null); setTestSent(false); }}>{text('edit')}</Button>}
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await client.test(preview.draft); setTestSent(true); }, 'testError')}>{text('test')}</Button>
          {!confirming ? <Button disabled={busy || preview.count === 0} onClick={() => { setConfirming(true); setError(null); setTestSent(false); }}>{text('continue')}</Button>
            : <Button disabled={busy || preview.count === 0} onClick={() => void run(async () => {
              setAttempted(true);
              const result = await client.send({ ...preview.draft, sendGeneration: generation.current!, confirm: true });
              sent(result);
            }, 'sendError')}>{text(pending === 'sendError' ? 'sending' : 'confirm', { count: preview.count })}</Button>}
        </div>
      </>}
      {testSent && <Alert role="status">{text('testSent')}</Alert>}
      {error && <Failure error={error.cause} fallback={error.fallback} />}
    </div>
  </Dialog>;
}
