// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { createBackupKeyResponseSchema, type BackupsIntegration } from '@plaingym/shared/contracts';
import { api } from '../../../lib/api.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { integrationsOf, text, type useIntegrations } from './state.js';

const label = (key: string) => text('backups.' + key);
const gigabytes = (bytes: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1e9) + ' GB';
/** What the health check knows about the last snapshot: undefined while it loads or when it couldn't be checked. */
export type LastSnapshot = { at: string | null } | 'unknown' | undefined;
function Field({ name, type = 'text', value }: { name: string; type?: string; value?: string | undefined }) {
  return <div className="grid min-w-0 gap-2">
    <Label htmlFor={'integrations-backup-' + name}>{label(name)}</Label>
    <Input id={'integrations-backup-' + name} name={name} type={type} required defaultValue={value} autoComplete={type === 'password' ? 'new-password' : 'off'}/>
  </div>;
}
/**
 * Single-gym installs only. Set up, move or re-key backups through the same two steps as setup: a new key pair whose
 * private key is shown once, and nothing used until the owner pastes it back.
 */
export function BackupsIntegrationSection({ backups, lastSnapshot, state }: { backups: BackupsIntegration; lastSnapshot: LastSnapshot; state: ReturnType<typeof useIntegrations> }) {
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  const run = async (action: () => Promise<void>) => {
    setMessage(null); setBusy(true);
    try { await action(); } catch { setMessage({ kind: 'alert', text: text('error') }); } finally { setBusy(false); }
  };
  const generate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget), field = (name: string) => String(form.get(name) ?? '');
    void run(async () => {
      const reply = await state.change((revision) => api.POST('/api/settings/integrations/backups', { body: { revision, destination: {
        endpoint: field('endpoint'), region: field('region'), bucket: field('bucket'), accessKeyId: field('accessKeyId'), secretAccessKey: field('secretAccessKey') } } }),
      (data) => { const parsed = createBackupKeyResponseSchema.parse(data).data; return { integrations: parsed.integrations, result: { privateKey: parsed.privateKey, publicKey: parsed.publicKey } }; });
      if (reply.result) { setCreated(reply.result); setOpen(false); }
      else setMessage({ kind: 'alert', text: reply.reason === 'unreachable' ? label('unreachable') : text(reply.status === 409 ? 'conflict' : 'error') });
    });
  };
  const confirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const privateKey = String(new FormData(event.currentTarget).get('privateKey') ?? '').trim();
    void run(async () => {
      const reply = await state.change((revision) => api.POST('/api/settings/integrations/backups/confirm', { body: { revision, privateKey } }), integrationsOf);
      if (reply.status < 300) { setCreated(null); setMessage({ kind: 'status', text: label('confirmed') }); }
      else setMessage({ kind: 'alert', text: reply.reason === 'mismatch' || reply.status === 400 ? label('mismatch')
        : reply.reason === 'no_pending_key' ? label('noPending') : text(reply.status === 409 ? 'conflict' : 'error') });
    });
  };
  const download = (privateKey: string) => {
    const url = URL.createObjectURL(new Blob([privateKey + '\n'], { type: 'text/plain' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'plaingym-backup-key.txt'; anchor.click(); URL.revokeObjectURL(url);
  };
  const pending = backups.pending;
  return <div className="grid min-w-0 gap-4">
    <h3 className="text-base font-semibold">{label('title')}</h3>
    {backups.configured && backups.destination
      ? <p className="text-sm [overflow-wrap:anywhere]">{text('backups.configured', { bucket: backups.destination.bucket, endpoint: backups.destination.endpoint })}</p>
      : <p className="text-sm">{label('notConfigured')}</p>}
    {backups.publicKey && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{text('backups.publicKey', { key: backups.publicKey })}</p>}
    {backups.configured && lastSnapshot !== undefined && <p className="text-sm text-muted-foreground">{lastSnapshot === 'unknown' ? label('snapshotUnknown')
      : lastSnapshot.at ? text('backups.lastSnapshot', { time: new Date(lastSnapshot.at).toLocaleString() }) : label('noSnapshot')}</p>}
    <p className="text-sm text-muted-foreground">{text('backups.retention', { size: gigabytes(backups.retentionBudgetBytes) })}</p>
    {backups.configured && <p className="text-sm">{label('changeWarning')}</p>}
    {message && <p role={message.kind} className="rounded-md border border-border p-3 text-sm">{message.text}</p>}
    {pending && <p role="note" className="rounded-md [overflow-wrap:anywhere] border border-border p-3 text-sm">{text('backups.pending', { bucket: pending.destination.bucket })}</p>}
    {created && <div className="grid min-w-0 gap-3">
      <p className="text-sm font-medium">{label('keyWarning')}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-sm">{created.privateKey}</pre>
      <div><Button type="button" variant="outline" onClick={() => download(created.privateKey)}>{label('download')}</Button></div>
    </div>}
    {pending && !open && <form onSubmit={confirm} aria-label={label('confirm')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <Field name="privateKey" type="password"/>
        <CheckboxField required label={label('savedKey')}/>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit">{label(busy ? 'confirming' : 'confirm')}</Button>
          <Button type="button" variant="outline" onClick={() => { setCreated(null); setOpen(true); }}>{label('start')}</Button>
        </div>
      </fieldset>
    </form>}
    {!pending && !open && <div><Button type="button" variant="outline" onClick={() => { setMessage(null); setOpen(true); }}>{label(backups.configured ? 'change' : 'setUp')}</Button></div>}
    {open && <form onSubmit={generate} aria-label={label(backups.configured ? 'change' : 'setUp')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <p className="text-sm text-muted-foreground">{label('hint')}</p>
        <Field name="endpoint" type="url" value={backups.destination?.endpoint}/>
        <Field name="region" value={backups.destination?.region ?? 'auto'}/>
        <Field name="bucket" value={backups.destination?.bucket}/>
        <Field name="accessKeyId"/>
        <Field name="secretAccessKey" type="password"/>
        <div className="flex flex-col gap-3 sm:flex-row"><Button type="submit">{label(busy ? 'generating' : 'generate')}</Button></div>
      </fieldset>
    </form>}
  </div>;
}
