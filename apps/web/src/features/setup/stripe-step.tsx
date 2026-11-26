// SPDX-License-Identifier: AGPL-3.0-only
import { restrictedKeyPattern } from '@plaingym/shared/contracts';
import { useContext, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { createSetupClient } from './api.js';
import { SetupActions } from './actions.js';
import { SetupHoldContext } from './hold.js';

const label = (key: string, values?: Readonly<Record<string, string | number>>) => t('setup/stripe-step:' + key, values);
const permissions = ['customers', 'intents', 'checkout', 'setupIntents', 'mandates', 'methods', 'refunds', 'webhooks', 'events', 'disputes'];
const readPermissions = new Set(['setupIntents', 'mandates', 'events', 'disputes']);
export function StripeStep({ fetcher = fetch, onComplete }: { fetcher?: typeof fetch; onComplete?: () => void }) {
  const formId = useId();
  const [client] = useState(() => createSetupClient(fetcher));
  const [restrictedKey, setKey] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [connected, setConnected] = useState<{ mode: 'test' | 'live' | null; webhookRegistered: boolean } | null>(null);
  const [failure, setFailure] = useState<'failed' | 'changed' | 'invalid' | null>(null);
  const queries = useQueryClient();
  const hold = useContext(SetupHoldContext);
  async function save(choice: 'configure' | 'skip') {
    if (busy) return;
    if (choice === 'configure' && !restrictedKeyPattern.test(restrictedKey)) { setFailure('invalid'); return; }
    setBusy(true); setFailure(null);
    try {
      const { revision } = await client.call('status');
      const result = await client.call('stripe', choice === 'skip' ? { choice, revision } : { choice, revision, restrictedKey });
      setKey('');
      if (choice === 'configure') {
        setConnected({ mode: result.mode, webhookRegistered: result.webhookRegistered });
        hold?.hold({ mode: result.mode, webhookRegistered: result.webhookRegistered });
      } else {
        setDone(true);
        // The wizard reads the status itself, so a failed read is shown and focused like its other reloads.
        if (hold) await hold.release();
        else await queries.invalidateQueries({ queryKey: ['setup', 'status'] });
        onComplete?.();
      }
    } catch (error) {
      setKey(''); setFailure(error instanceof ApiError && error.status === 409 ? 'changed' : 'failed');
    } finally { setBusy(false); }
  }
  async function continueToBackups() {
    if (busy) return;
    setBusy(true);
    try {
      if (hold) await hold.release();
      else await queries.invalidateQueries({ queryKey: ['setup', 'status'] });
      onComplete?.();
    } finally { setBusy(false); }
  }
  const confirmation = connected ?? hold?.connected ?? null;
  const connectedLine = confirmation && [
    confirmation.mode === 'test' || confirmation.mode === 'live'
      ? label('connectedMode', { mode: label('mode_' + confirmation.mode) })
      : label('connected'),
    confirmation.webhookRegistered
      ? label('webhookRegistered', { url: new URL('/webhooks/stripe', location.origin).href })
      : label('webhookMissing'),
  ].join(' ');
  return <section className="min-w-0 space-y-5" aria-label={label('title')}>
    {done ? <p role="status">{label('done')}</p>
    : confirmation ? <>
      <p role="status" className="wrap-anywhere">{connectedLine}</p>
      <SetupActions><Button disabled={busy} onClick={() => void continueToBackups()}>{label('next')}</Button></SetupActions>
    </>
    : <>
      <p className="wrap-anywhere">{label('intro')}</p>
      <h3 className="font-semibold">{label('permissions')}</h3>
      <dl className="space-y-2 rounded-md border p-3 text-sm">
        {permissions.map((resource) => <div key={resource} className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="wrap-anywhere">{label(resource)}</dt><dd className="font-medium">{label(readPermissions.has(resource) ? 'read' : 'write')}</dd>
        </div>)}
      </dl><p className="text-sm">{label('other')}</p>
      {failure && <Alert variant="error" focusOnReveal>{label(failure)}</Alert>}
      <form id={formId} className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save('configure'); }}>
        <Label htmlFor="stripe-restricted-key">{label('key')}</Label>
        <Input id="stripe-restricted-key" name="restrictedKey" type="password" autoComplete="off" spellCheck={false}
          value={restrictedKey} onChange={(event) => setKey(event.target.value)} disabled={busy} required />
      </form>
        <SetupActions>
          <Button type="submit" form={formId} disabled={busy}>{label(busy ? 'busy' : 'configure')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void save('skip')}>{label('skip')}</Button>
        </SetupActions>
    </>}
  </section>;
}
