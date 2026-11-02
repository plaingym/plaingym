// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import type { PaymentsIntegration } from '@plaingym/shared/contracts';
import { api } from '../../../lib/api.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { integrationsOf, text, type useIntegrations } from './state.js';

const label = (key: string) => text('payments.' + key);
const refusals: Record<string, string> = { missing_permission: 'missingPermission', account_locked: 'accountLocked', mode_locked: 'modeLocked' };
/** The gym's Stripe mode and webhook status; the key is replaced through the same probe and endpoint lifecycle as setup. */
export function PaymentsIntegrationSection({ payments, lastEventAt, state }: {
  payments: PaymentsIntegration; lastEventAt: string | null | undefined; state: ReturnType<typeof useIntegrations>;
}) {
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    if (!/^rk_(test|live)_[A-Za-z0-9]+$/.test(key)) { setMessage({ kind: 'alert', text: label('invalid') }); return; }
    setBusy(true);
    try {
      const reply = await state.change((revision) => api.PUT('/api/settings/integrations/stripe', { body: { revision, restrictedKey: key } }), integrationsOf);
      if (reply.status < 300) setMessage({ kind: 'status', text: label('saved') });
      else setMessage({ kind: 'alert', text: reply.reason && refusals[reply.reason] ? label(refusals[reply.reason]!)
        : reply.status === 409 ? text('conflict') : reply.status === 400 ? label('invalid') : label('failed') });
    } catch { setMessage({ kind: 'alert', text: text('error') }); }
    finally { setKey(''); setBusy(false); }
  }
  return <div className="grid min-w-0 gap-4">
    <h3 className="text-base font-semibold">{label('title')}</h3>
    <p className="text-sm">{payments.configured ? text('payments.configured', { mode: label('mode_' + payments.mode) }) : label('notConfigured')}</p>
    {payments.configured && <p className="text-sm text-muted-foreground">{label(payments.webhookRegistered ? 'webhookRegistered' : 'webhookMissing')}</p>}
    {payments.configured && lastEventAt !== undefined && <p className="text-sm text-muted-foreground">
      {lastEventAt ? text('payments.lastEvent', { time: new Date(lastEventAt).toLocaleString() }) : label('noEvent')}</p>}
    {payments.accountLocked && <p className="text-sm text-muted-foreground">{label('locked')}</p>}
    {message && <p role={message.kind} className="rounded-md border border-border p-3 text-sm">{message.text}</p>}
    <form onSubmit={(event) => void save(event)} aria-label={label('title')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <p className="text-sm text-muted-foreground">{label('hint')}</p>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="integrations-stripe-key">{label('key')}</Label>
          <Input id="integrations-stripe-key" name="restrictedKey" type="password" autoComplete="off" spellCheck={false} required
            value={key} onChange={(event) => setKey(event.target.value)}/>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row"><Button type="submit">{label(busy ? 'saving' : 'save')}</Button></div>
      </fieldset>
    </form>
  </div>;
}
