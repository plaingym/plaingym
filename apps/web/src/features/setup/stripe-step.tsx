// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { createSetupClient } from './api.js';

const label = (key: string) => t('setup/stripe-step:' + key);
const permissions = ['customers', 'intents', 'checkout', 'setupIntents', 'methods', 'refunds', 'webhooks', 'events', 'disputes'];
export function StripeStep({ fetcher = fetch, onComplete }: { fetcher?: typeof fetch; onComplete?: () => void }) {
  const [client] = useState(() => createSetupClient(fetcher));
  const [restrictedKey, setKey] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [failure, setFailure] = useState<'failed' | 'changed' | 'invalid' | null>(null);
  const queries = useQueryClient();
  async function save(choice: 'configure' | 'skip') {
    if (busy) return;
    if (choice === 'configure' && !/^rk_(test|live)_[A-Za-z0-9]+$/.test(restrictedKey)) { setFailure('invalid'); return; }
    setBusy(true); setFailure(null);
    try {
      const { revision } = await client.call('status');
      await client.call('stripe', choice === 'skip' ? { choice, revision } : { choice, revision, restrictedKey });
      setKey(''); setDone(true);
      await queries.invalidateQueries({ queryKey: ['setup', 'status'] });
      onComplete?.();
    } catch (error) {
      setKey(''); setFailure(error instanceof ApiError && error.status === 409 ? 'changed' : 'failed');
    } finally { setBusy(false); }
  }
  return <section className="min-w-0 space-y-5" aria-label={label('title')}>
    {done ? <p role="status">{label('done')}</p> : <>
      <p className="break-words">{label('intro')}</p>
      <h3 className="font-semibold">{label('permissions')}</h3>
      <dl className="space-y-2 rounded-md border p-3 text-sm">
        {permissions.map((resource) => <div key={resource} className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="break-words">{label(resource)}</dt><dd className="font-medium">{label(['setupIntents', 'events', 'disputes'].includes(resource) ? 'read' : 'write')}</dd>
        </div>)}
      </dl><p className="text-sm">{label('other')}</p>
      {failure && <Alert>{label(failure)}</Alert>}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save('configure'); }}>
        <Label htmlFor="stripe-restricted-key">{label('key')}</Label>
        <Input id="stripe-restricted-key" name="restrictedKey" type="password" autoComplete="off" spellCheck={false}
          value={restrictedKey} onChange={(event) => setKey(event.target.value)} disabled={busy} required />
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button type="submit" disabled={busy}>{label(busy ? 'busy' : 'configure')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void save('skip')}>{label('skip')}</Button>
        </div>
      </form>
    </>}
  </section>;
}
