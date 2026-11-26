// SPDX-License-Identifier: AGPL-3.0-only
import { formatCount } from '../../../lib/count.js';
import { useGymTime } from '../../../lib/instant.js';
import { restrictedKeyPattern } from '@plaingym/shared/contracts';
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PaymentsIntegration } from '@plaingym/shared/contracts';
import { api } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { useGymSettings } from '../gym-settings.js';
import { hasRestoreModeNote } from '../restore-mode-note.js';
import { useGoLiveChecklist } from '../go-live-query.js';
import { Button } from '../../../components/ui/button.js';
import { FormMessage } from '../../../components/ui/alert.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { failedText, integrationsOf, refusedText, text, type ChangeResult, type useIntegrations } from './state.js';

const label = (key: string) => text('payments.' + key);
const refusals: Record<string, string> = { missing_permission: 'missingPermission', account_locked: 'accountLocked', mode_locked: 'modeLocked',
  payments_in_progress: 'inProgress', busy: 'busy' };
type Message = { kind: 'status' | 'alert'; text: string };
/** The refusal for a reply the server didn't accept; a live gym refusing a test key says so in its own words. */
function refusal(reply: ChangeResult<unknown>, mode: PaymentsIntegration['mode']): Message {
  const reason = reply.reason === 'mode_locked' && mode === 'live' ? 'modeLockedLive' : reply.reason ? refusals[reply.reason] : undefined;
  return { kind: 'alert', text: reason ? label(reason)
    : reply.reason === 'operator_managed' || reply.status === 409 ? refusedText(reply) : reply.status === 400 ? label('invalid') : label('failed') };
}

/**
 * The gym's Stripe mode and webhook status; the key is replaced through the same probe and endpoint lifecycle as setup.
 * A live key refused because test-mode references exist (`mode_locked` from test) offers the switch: a confirmation lists
 * what is cleared and what stays, and only then is the key sent again with `clearTestData`. The live key waits in memory
 * for that confirmation and is dropped on cancel or success.
 */
export function PaymentsIntegrationSection({ payments, editable, lastEventAt, state }: {
  payments: PaymentsIntegration; editable: boolean; lastEventAt: string | null | undefined; state: ReturnType<typeof useIntegrations>;
}) {
  const { instantLabel, dateLabel } = useGymTime();
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [switchKey, setSwitchKey] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const gym = useGymSettings();
  const checklist = useGoLiveChecklist(gym.settings?.revision, gym.epoch, editable && payments.configured);
  const bankStatus = useQuery({ queryKey: ['bank-debit-status', gym.settings?.id, gym.settings?.revision], enabled: Boolean(gym.settings),
    queryFn: async () => {
      const result = await api.GET('/api/settings/payments/bank-debits');
      if (!result.response.ok) throw new Error('Could not read bank payment status');
      return result.data?.data.unavailableAt ?? null;
    } });
  const eligible = gym.settings?.currency === 'USD' || gym.settings?.currency === 'CAD';
  async function toggleBankDebits(bankDebitsEnabled: boolean) {
    setBusy(true); setMessage(null);
    try {
      const result = await gym.save((revision, signal) => api.PUT('/api/settings/payments/bank-debits', { signal, body: { revision, bankDebitsEnabled } }));
      if (result.status >= 300) setMessage({ kind: 'alert', text: refusedText(result) });
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setBusy(false); }
  }
  const restore = checklist.data?.restoreReconciliation;
  const reconciliation = checklist.data?.items.find(item => item.id === 'reconciliation_complete');
  const send = (restrictedKey: string, clearTestData: boolean) => state.change((revision, signal) => api.PUT('/api/settings/integrations/stripe',
    { signal, body: { revision, restrictedKey, ...(clearTestData ? { clearTestData } : {}) } }), integrationsOf);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null); setSwitchKey(null);
    if (!restrictedKeyPattern.test(key)) { setMessage({ kind: 'alert', text: label('invalid') }); return; }
    setBusy(true);
    try {
      const reply = await send(key, false);
      if (reply.status < 300) setMessage({ kind: 'status', text: label('saved') });
      else if (reply.reason === 'mode_locked' && payments.mode === 'test' && key.startsWith('rk_live_')) setSwitchKey(key);
      else setMessage(refusal(reply, payments.mode));
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setKey(''); setBusy(false); }
  }
  async function confirmSwitch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    if (!switchKey) return;
    setBusy(true);
    try {
      const reply = await send(switchKey, true);
      if (reply.status < 300) { setSwitchKey(null); setMessage({ kind: 'status', text: label('switched') }); }
      else setMessage(refusal(reply, payments.mode));
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setBusy(false); }
  }
  const counts = payments.testData;
  return <div className="grid min-w-0 gap-4">
    <h3 className="text-base font-semibold">{label('title')}</h3>
    <p className="text-sm">{payments.configured ? text('payments.configured', { mode: label('mode_' + payments.mode) }) : label('notConfigured')}</p>
    {payments.configured && <p className="text-sm text-muted-foreground">{label(payments.webhookRegistered ? 'webhookRegistered' : 'webhookMissing')}</p>}
    {payments.configured && lastEventAt !== undefined && <p className="text-sm text-muted-foreground">
      {lastEventAt ? text('payments.lastEvent', { time: instantLabel(lastEventAt) }) : label('noEvent')}</p>}
    {editable && payments.accountLocked && <p className="text-sm text-muted-foreground">{label(payments.mode === 'test' ? 'lockedTest' : 'locked')}</p>}
    {editable && payments.importedCustomersOnly && <p className="text-sm text-muted-foreground">{label('importedOnly')}</p>}
    {editable && payments.configured && restore?.stripeConfigured === false && <p className="text-sm" role="note">
      {t('settings/go-live:reconcileStripeConnected')}</p>}
    {editable && payments.configured && reconciliation && hasRestoreModeNote(reconciliation) && <p className="text-sm" role="note">{reconciliation.message}</p>}
    {gym.settings && <div className="grid min-w-0 gap-1">
      <CheckboxField role="switch" label={text('bankDebitsLabel')} checked={gym.settings.bankDebitsEnabled && eligible}
        disabled={!editable || !eligible || busy || gym.failed} aria-describedby="bank-debits-help" onChange={event => void toggleBankDebits(event.target.checked)}/>
      <p id="bank-debits-help" className="text-sm text-muted-foreground">{text(eligible ? 'bankDebitsHelp' : 'bankDebitsCurrency')}</p>
      {bankStatus.data && <p role="alert" className="text-sm">{text('bankDebitsWarning', { date: dateLabel(bankStatus.data) })}</p>}
    </div>}
    <FormMessage message={message}/>
    {!editable ? null : switchKey ? <form onSubmit={(event) => void confirmSwitch(event)} aria-label={label('switchTitle')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4 rounded-md border border-border p-3">
        <h4 className="text-sm font-semibold">{label('switchTitle')}</h4>
        <p className="text-sm">{label('switchIntro')}</p>
        <div className="grid gap-1">
          <p className="text-sm font-medium">{label('switchCleared')}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{text('payments.switchCustomers', { count: counts ? formatCount(counts.customers) : '–' })}</li>
            <li>{text('payments.switchCards', { count: counts ? formatCount(counts.cards) : '–' })}</li>
            <li>{text('payments.switchCheckouts', { count: counts ? formatCount(counts.checkouts) : '–' })}</li>
            <li>{text('payments.switchDisputes', { count: counts ? formatCount(counts.disputes) : '–' })}</li>
          </ul>
        </div>
        <div className="grid gap-1">
          <p className="text-sm font-medium">{label('switchKept')}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{text('payments.switchPayments', { count: counts ? formatCount(counts.payments) : '–' })}</li>
            {counts && counts.importedCustomers + counts.importedCards > 0 && <li>{text('payments.switchImported',
              { customers: formatCount(counts.importedCustomers), cards: formatCount(counts.importedCards) })}</li>}
            <li>{label('switchBooks')}</li>
          </ul>
        </div>
        <p className="text-sm text-muted-foreground">{label('switchFinal')}</p>
        <CheckboxField required label={label('switchConfirm')}/>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit">{label(busy ? 'switching' : 'switch')}</Button>
          <Button type="button" variant="outline" onClick={() => { setSwitchKey(null); setMessage(null); }}>{label('switchCancel')}</Button>
        </div>
      </fieldset>
    </form>
    : <form onSubmit={(event) => void save(event)} aria-label={label('title')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <p className="text-sm text-muted-foreground">{label('hint')}</p>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="integrations-stripe-key">{label('key')}</Label>
          <Input id="integrations-stripe-key" name="restrictedKey" type="password" autoComplete="off" spellCheck={false} required
            value={key} onChange={(event) => setKey(event.target.value)}/>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row"><Button type="submit">{label(busy ? 'saving' : 'save')}</Button></div>
      </fieldset>
    </form>}
  </div>;
}
