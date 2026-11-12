// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../../lib/response.js';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createBackupKeyResponseSchema, type BackupsIntegration } from '@plaingym/shared/contracts';
import { api } from '../../../lib/api.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { FormMessage } from '../../../components/ui/alert.js';
import { BackupKeyPanel, ConfirmKeySection, confirmKeyLabels } from '../../setup/backup-key.js';
import { failedText, integrationsOf, refusedText, text, type useIntegrations } from './state.js';
import { BackupActions } from '../../health/backups.js';

const label = (key: string) => text('backups.' + key);
/**
 * Making a key first lists, writes, reads and deletes a probe at the destination, each a request of its own or several.
 * Giving up sooner would leave the server saving a pending key whose private half this page never receives.
 */
export const destinationCheckTimeoutMs = 2 * 60_000;
const gigabytes = (bytes: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1e9) + ' GB';
/** What the health check knows about the last snapshot: undefined while it loads or when it couldn't be checked. */
export type LastSnapshot = { at: string | null; noneUnderCurrentKey: boolean } | 'unknown' | undefined;
function Field({ name, type = 'text', value, text: shown }: { name: string; type?: string; value?: string | undefined; text?: string }) {
  return <div className="grid min-w-0 gap-2">
    <Label htmlFor={'integrations-backup-' + name}>{shown ?? label(name)}</Label>
    <Input id={'integrations-backup-' + name} name={name} type={type} required defaultValue={value} autoComplete={type === 'password' ? 'new-password' : 'off'}/>
  </div>;
}
/**
 * Single-gym installs only. Set up, move or re-key backups through the same two steps as setup: a new key pair whose
 * private key is shown once, and nothing used until the owner pastes it back.
 */
export function BackupsIntegrationSection({ backups, lastSnapshot, state }: { backups: BackupsIntegration; lastSnapshot: LastSnapshot; state: ReturnType<typeof useIntegrations> }) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  const run = async (action: () => Promise<void>) => {
    setMessage(null); setBusy(true);
    try { await action(); } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); } finally { setBusy(false); }
  };
  const generate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget), field = (name: string) => String(form.get(name) ?? '');
    void run(async () => {
      const reply = await state.change((revision, signal) => api.POST('/api/settings/integrations/backups', { signal, body: { revision, destination: {
        endpoint: field('endpoint'), region: field('region'), bucket: field('bucket'), accessKeyId: field('accessKeyId'), secretAccessKey: field('secretAccessKey') } } }),
      (data) => { const parsed = parseResponse(createBackupKeyResponseSchema, data).data; return { integrations: parsed.integrations, result: { privateKey: parsed.privateKey, publicKey: parsed.publicKey } }; },
      { timeoutMs: destinationCheckTimeoutMs });
      if (reply.result) { setCreated(reply.result); setOpen(false); }
      else setMessage({ kind: 'alert', text: reply.reason === 'unreachable' ? label('unreachable') : refusedText(reply) });
    });
  };
  const confirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const privateKey = String(new FormData(event.currentTarget).get('privateKey') ?? '').trim();
    void run(async () => {
      const reply = await state.change((revision, signal) => api.POST('/api/settings/integrations/backups/confirm', { signal, body: { revision, privateKey } }), integrationsOf);
      if (reply.status < 300) {
        setCreated(null); setMessage({ kind: 'status', text: label('confirmed') });
        if (state.gymId) await cache.invalidateQueries({ queryKey: ['health', state.gymId, 'backups'] });
      }
      else setMessage({ kind: 'alert', text: reply.reason === 'mismatch' || reply.status === 400 ? confirmKeyLabels.mismatch()
        : reply.reason === 'no_pending_key' ? label('noPending') : refusedText(reply) });
    });
  };
  const pending = backups.pending;
  return <div className="grid min-w-0 gap-4">
    <h3 className="text-base font-semibold">{label('title')}</h3>
    {backups.configured && backups.destination
      ? <p className="text-sm [overflow-wrap:anywhere]">{text('backups.configured', { bucket: backups.destination.bucket, endpoint: backups.destination.endpoint })}</p>
      : <p className="text-sm">{label('notConfigured')}</p>}
    {backups.publicKey && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{text('backups.publicKey', { key: backups.publicKey })}</p>}
    {backups.configured && lastSnapshot !== undefined && <p className="text-sm text-muted-foreground">{lastSnapshot === 'unknown' ? label('snapshotUnknown')
      : lastSnapshot.noneUnderCurrentKey || lastSnapshot.at === null ? label('noneUnderKey')
      : text('backups.lastSnapshot', { time: new Date(lastSnapshot.at).toLocaleString() })}</p>}
    <p className="text-sm text-muted-foreground">{text('backups.retention', { size: gigabytes(backups.retentionBudgetBytes) })}</p>
    {state.gymId && <BackupActions gymId={state.gymId} owner onConfirmed={state.reload}/>}
    {backups.configured && <p className="text-sm">{label('changeWarning')}</p>}
    <FormMessage message={message}/>
    {pending && <p role="note" className="rounded-md [overflow-wrap:anywhere] border border-border p-3 text-sm">{text('backups.pending', { bucket: pending.destination.bucket })}</p>}
    {created && <BackupKeyPanel idPrefix="integrations-backup" privateKey={created.privateKey} publicKey={created.publicKey}/>}
    {pending && !open && <ConfirmKeySection idPrefix="integrations-backup"><form onSubmit={confirm} aria-label={label('confirm')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <Field name="privateKey" type="password" text={confirmKeyLabels.field()}/>
        <CheckboxField required label={label('savedKey')}/>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit">{busy ? confirmKeyLabels.checking() : confirmKeyLabels.submit()}</Button>
          <Button type="button" variant="outline" onClick={() => { setCreated(null); setOpen(true); }}>{label('start')}</Button>
        </div>
      </fieldset>
    </form></ConfirmKeySection>}
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
