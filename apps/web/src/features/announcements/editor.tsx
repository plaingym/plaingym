// SPDX-License-Identifier: AGPL-3.0-only
import { formatCount } from '../../lib/count.js';
import { useEffect, useRef, useState } from 'react';
import { announcementDraftSchema, type AnnouncementDraft, type Program } from '@plaingym/shared/contracts';
import { announcementSmsBody, smsSegments } from '@plaingym/shared';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Textarea } from '../../components/ui/select.js';
import { Dialog, DialogActions } from '../../components/ui/dialog.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import type { Announcement, AnnouncementClient } from './api.js';
import { definiteRefusal, Failure, text } from './messages.js';

const statuses = ['active', 'trial', 'frozen'] as const;
export interface AnnouncementAttempt { draft: AnnouncementDraft; count: number; smsCount?: number; segments?: number; generation: string; uncertain: boolean }
export function AnnouncementEditor({ gymName, programs, client, close, sent, owner = false, attempt, rememberAttempt }: {
  gymName: string; programs: Program[]; client: AnnouncementClient; close(): void; sent(announcement: Announcement): void;
  owner?: boolean; attempt?: AnnouncementAttempt | undefined; rememberAttempt?(attempt: AnnouncementAttempt | undefined): void;
}) {
  const [subject, setSubject] = useState(attempt?.draft.subject ?? ''), [body, setBody] = useState(attempt?.draft.body ?? '');
  const [smsEnabled, setSmsEnabled] = useState(!!attempt?.draft.sms), [smsBody, setSmsBody] = useState(attempt?.draft.sms?.body ?? '');
  const [testTo, setTestTo] = useState('');
  const composedText = announcementSmsBody(gymName, smsBody), segments = smsSegments(composedText).segments;
  const [selectedStatuses, setStatuses] = useState<AnnouncementDraft['audience']['statuses']>(attempt?.draft.audience.statuses ?? [...statuses]);
  const [programIds, setPrograms] = useState<string[]>(attempt?.draft.audience.programIds ?? []);
  const [preview, setPreview] = useState<{ draft: AnnouncementDraft; count: number; smsCount?: number; segments?: number } | null>(attempt ?? null);
  const [confirming, setConfirming] = useState(!!attempt), [attempted, setAttempted] = useState(!!attempt);
  const [pending, setPending] = useState<'previewError' | 'testError' | 'sendError' | null>(null);
  const [error, setError] = useState<{ cause: unknown; fallback: string } | null>(null);
  const busy = pending !== null;
  const [testSent, setTestSent] = useState(false);
  const [smsTestSent, setSmsTestSent] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  const subjectInput = useRef<HTMLInputElement>(null);
  const keepAttempt = useRef<HTMLButtonElement>(null), startOver = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (startingOver) keepAttempt.current?.focus(); }, [startingOver]);
  const inFlight = useRef(false), generation = useRef<string | null>(attempt?.generation ?? null);
  const uncertain = useRef(attempt?.uncertain ?? false);
  function draft() {
    if (smsEnabled && composedText.length > 480) { setError({ cause: null, fallback: 'smsTooLong' }); return; }
    const parsed = announcementDraftSchema.safeParse({ subject, body, ...(smsEnabled ? { sms: { body: smsBody } } : {}), audience: { statuses: selectedStatuses, programIds } });
    if (!parsed.success) { setError({ cause: null, fallback: 'invalid' }); return; }
    return parsed.data;
  }
  async function run(operation: () => Promise<void>, fallback: 'previewError' | 'testError' | 'sendError') {
    if (inFlight.current) return;
    inFlight.current = true; setPending(fallback); setError(null); setTestSent(false); setSmsTestSent(false);
    try { await operation(); } catch (cause) { setError({ cause, fallback }); }
    finally { inFlight.current = false; setPending(null); }
  }
  function toggle<T>(values: T[], value: T, checked: boolean) { return checked ? [...values, value] : values.filter(item => item !== value); }
  return <Dialog title={text(startingOver ? 'startOverTitle' : confirming ? 'confirmTitle' : preview ? 'previewTitle' : 'compose')} closeLabel={text('close')}
    onClose={close} dismissible={!busy} unsavedChanges={!!subject || !!body}>
    <div className="min-w-0 space-y-4 wrap-anywhere">
      {startingOver ? <>
        <Alert role="note">{text('startOverHelp')}</Alert>
        <DialogActions>
          <Button ref={keepAttempt} variant="outline" onClick={() => { setStartingOver(false); requestAnimationFrame(() => startOver.current?.focus()); }}>{text('keepAttempt')}</Button>
          <Button variant="destructive" onClick={() => {
            rememberAttempt?.(undefined);
            uncertain.current = false; generation.current = null;
            setPreview(null); setConfirming(false); setAttempted(false); setError(null); setTestSent(false); setStartingOver(false);
            requestAnimationFrame(() => subjectInput.current?.focus());
          }}>{text('confirmStartOver')}</Button>
        </DialogActions>
      </> : <>
      {!preview ? <form className="space-y-4" onSubmit={event => {
        event.preventDefault();
        const parsed = draft();
        if (!parsed) return;
        void run(async () => {
          const result = await client.preview(parsed);
          generation.current = crypto.randomUUID();
          setPreview({ draft: parsed, count: result.recipientCount, smsCount: result.smsRecipientCount, segments: result.smsSegments });
        }, 'previewError');
      }}>
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <div><Label htmlFor="announcement-subject">{text('subject')}</Label>
            <Input ref={subjectInput} id="announcement-subject" value={subject} maxLength={150} required aria-describedby="subject-count" onChange={event => setSubject(event.target.value)} />
            <p id="subject-count" className="text-sm text-muted-foreground">{text('characters', { count: formatCount(subject.length), max: formatCount(150) })}</p></div>
          <div><Label htmlFor="announcement-body">{text('body')}</Label>
            <Textarea id="announcement-body" rows={8} value={body} maxLength={10000} required aria-describedby="body-count" onChange={event => setBody(event.target.value)} />
            <p id="body-count" className="text-sm text-muted-foreground">{text('characters', { count: formatCount(body.length), max: formatCount(10_000) })}</p></div>
          <CheckboxField label={text('includeSms')} checked={smsEnabled} onChange={event => setSmsEnabled(event.target.checked)} />
          {smsEnabled && <div className="min-w-0 space-y-2">
            <Label htmlFor="announcement-sms">{text('smsBody')}</Label>
            <Textarea id="announcement-sms" value={smsBody} maxLength={480} rows={4} required onChange={event => setSmsBody(event.target.value)} aria-describedby="sms-count" />
            <p id="sms-count" className="text-sm text-muted-foreground">{text('smsCount', { count: composedText.length, segments })}</p>
            <p className="whitespace-pre-wrap rounded border p-3">{composedText}</p>
            <p className="text-sm text-muted-foreground">{text('smsQuietHours')}</p>
            <Label htmlFor="announcement-test-phone">{text('testTo')}</Label>
            <Input id="announcement-test-phone" type="tel" value={testTo} onChange={event => setTestTo(event.target.value)} />
            <Button type="button" variant="outline" disabled={!testTo} onClick={() => {
              const parsed = draft();
              if (parsed?.sms) void run(async () => { await client.testSms({ ...parsed, sms: parsed.sms!, testTo }); setSmsTestSent(true); setTestSent(true); }, 'testError');
            }}>{text('testSms')}</Button>
          </div>}
          <fieldset className="space-y-2"><legend className="font-medium">{text('statuses')}</legend>
            <p className="text-sm text-muted-foreground">{text('statusHelp')}</p>
            {statuses.map(status => <CheckboxField key={status} label={text(status)} checked={selectedStatuses.includes(status)}
              onChange={event => setStatuses(toggle(selectedStatuses, status, event.target.checked))} />)}</fieldset>
          <fieldset className="min-w-0 space-y-2"><legend className="font-medium">{text('programs')}</legend>
            <p className="text-sm text-muted-foreground">{text('programHelp')}</p>
            <div className="max-h-64 overflow-y-auto">{programs.map(program => <CheckboxField key={program.id}
              label={program.name} checked={programIds.includes(program.id)} disabled={programIds.length >= 100 && !programIds.includes(program.id)}
              onChange={event => setPrograms(toggle(programIds, program.id, event.target.checked))} />)}</div></fieldset>
          <DialogActions>
            <Button type="submit" className="w-full sm:w-auto">{text(busy ? 'working' : 'preview')}</Button>
            <Button type="button" variant="outline" onClick={() => {
              const parsed = draft();
              if (parsed) void run(async () => { await client.test(parsed); setTestSent(true); }, 'testError');
            }}>{text('test')}</Button>
          </DialogActions>
        </fieldset>
      </form> : <>
        <p className="font-medium">{text(preview.draft.sms ? 'emailRecipients' : 'recipients', { count: formatCount(preview.count) })}</p>
        {preview.draft.sms && <section className="min-w-0 space-y-2 rounded-xl border p-4">
          <p>{text('smsRecipients', { count: preview.smsCount ?? 0, segments: preview.segments ?? 0 })}</p>
          <p className="whitespace-pre-wrap">{announcementSmsBody(gymName, preview.draft.sms.body)}</p>
          <p className="text-sm text-muted-foreground">{text('smsQuietHours')}</p>
        </section>}
        <p className="text-sm text-muted-foreground">{text('audienceHelp')}</p>
        <section aria-label={text('messagePreview')} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          <h3 className="font-semibold">{preview.draft.subject}</h3>
          <p>{gymName}</p>
          <p className="whitespace-pre-wrap">{preview.draft.body}</p>
          <p className="border-t border-border pt-4 text-sm text-muted-foreground">{t('announcements/send:unsubscribe')}</p>
        </section>
        <p className="text-sm text-muted-foreground">{text('testHelp')}</p>
        {confirming && <Alert role="note">{text('confirmHelp')}</Alert>}
        {preview.count + (preview.smsCount ?? 0) === 0 && <Alert role="note">{text('noRecipients')}</Alert>}
        <DialogActions>
          {!attempted && <Button variant="outline" disabled={busy} onClick={() => { setPreview(null); setConfirming(false); setError(null); setTestSent(false); }}>{text('edit')}</Button>}
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await client.test(preview.draft); setTestSent(true); }, 'testError')}>{text('test')}</Button>
          {!confirming ? <Button disabled={busy || preview.count + (preview.smsCount ?? 0) === 0} onClick={() => { setConfirming(true); setError(null); setTestSent(false); }}>{text('continue')}</Button>
            : <Button disabled={busy || preview.count + (preview.smsCount ?? 0) === 0} onClick={() => void run(async () => {
              setAttempted(true);
              // Retain an in-flight request conservatively in case the dialog is remounted.
              rememberAttempt?.({ ...preview, generation: generation.current!, uncertain: true });
              let result: Announcement;
              try { result = await client.send({ ...preview.draft, sendGeneration: generation.current!, confirm: true }); }
              catch (cause) {
                if (definiteRefusal(cause) && !uncertain.current) { setAttempted(false); rememberAttempt?.(undefined); }
                else {
                  // A refusal of this retry cannot settle an earlier request whose response was lost.
                  uncertain.current = true;
                  rememberAttempt?.({ ...preview, generation: generation.current!, uncertain: true });
                }
                throw cause;
              }
              rememberAttempt?.(undefined);
              sent(result);
            }, 'sendError')}>{text(pending === 'sendError' ? 'sending' : preview.draft.sms ? 'confirmSms' : 'confirm', { count: formatCount(preview.count), smsCount: formatCount(preview.smsCount ?? 0) })}</Button>}
        </DialogActions>
      </>}
      {testSent && <Alert role="status">{text(smsTestSent ? 'smsTestSent' : 'testSent')}</Alert>}
      {attempted && !busy && <Alert role="note" className="space-y-3">
        <p>{text('retainedAttempt')}</p>
        <Button ref={startOver} variant="outline" onClick={() => setStartingOver(true)}>{text('startOver')}</Button>
      </Alert>}
      {error && <Failure error={error.cause} fallback={error.fallback} owner={owner} retrySame={error.fallback === 'sendError' && uncertain.current} />}
      </>}
    </div>
  </Dialog>;
}
