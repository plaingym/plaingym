// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { gymSettingsResponseSchema, type ChargeType, type GymSettings } from '@plaingym/shared/contracts';
import { bootstrapKey } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { billingClient } from '../billing/catalog/api.js';
import { money } from '../billing/catalog/format.js';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';

const text = (key: string, values?: Record<string, string>) => t('settings/drop-in:' + key, values);
/** Chooses the charge type whose current price the public drop-in page shows; the price itself stays in the catalog. */
export function DropInSettings() {
  const id = useId(), cache = useQueryClient();
  const [settings, setSettings] = useState<GymSettings | null>(null), [charges, setCharges] = useState<ChargeType[]>([]);
  const [choice, setChoice] = useState(''), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [message, setMessage] = useState('');
  async function load() {
    setBusy(true); setFailed(false); setMessage('');
    try {
      const [next, list] = await Promise.all([billingClient.settings(), billingClient.charges()]);
      setSettings(next); setCharges(list); setChoice(next.dropInChargeTypeId ?? '');
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!settings) return;
    // A saved choice that was archived since can't be saved again; the server would refuse it.
    if (choice && !charges.find((charge) => charge.id === choice)?.active) { setMessage(text('archivedChoice')); return; }
    setBusy(true);
    try {
      // Other sections on this page save the same gym revision. Take the current one unless the drop-in
      // fee itself changed since this section loaded; the revision still guards the save from here on.
      const current = await billingClient.settings();
      if (current.dropInChargeTypeId !== settings.dropInChargeTypeId) { setMessage(text('conflict')); return; }
      const result = await api.PATCH('/api/settings/drop-in', { body: { revision: current.revision, dropInChargeTypeId: choice || null } });
      if (!result.response.ok) {
        setMessage(text(result.response.status === 409 ? 'conflict' : result.response.status === 404 ? 'missing' : 'error'));
        return;
      }
      const next = gymSettingsResponseSchema.parse(result.data).data;
      setSettings(next); setChoice(next.dropInChargeTypeId ?? ''); setMessage(text('saved'));
      // Every gym settings save refreshes the shell's cached gym summary, so it never lags a save made here.
      void cache.invalidateQueries({ queryKey: bootstrapKey });
    } catch { setMessage(text('error')); }
    finally { setBusy(false); }
  }
  if (!settings) return failed
    ? <ErrorState message={text('error')} onRetry={() => void load()} retryLabel={text('reload')}/>
    : <LoadingState label={text('loading')}/>;
  const chosen = charges.find((charge) => charge.id === choice);
  // An archived choice stays visible so the select shows what is saved, but it can't be chosen again.
  const options = charges.filter((charge) => charge.active || charge.id === settings.dropInChargeTypeId);
  return <div className="min-w-0 space-y-4">
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    {message && <p role={message === text('saved') ? 'status' : 'alert'} className="rounded-md border border-border p-3 text-sm">{message}</p>}
    {failed && <ErrorState message={text('error')} onRetry={() => void load()}/>}
    <form onSubmit={(event) => void save(event)} aria-label={text('title')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor={id}>{text('chargeType')}</Label>
          <Select id={id} name="dropInChargeTypeId" value={choice} onChange={(event) => { setChoice(event.target.value); setMessage(''); }}
            aria-describedby={id + '-help ' + id + '-preview'}>
            <option value="">{text('none')}</option>
            {options.map((charge) => <option key={charge.id} value={charge.id} disabled={!charge.active}>
              {(charge.active ? charge.name : text('archived', { name: charge.name })) + ' · ' + money(charge.amountCents, charge.currency)}</option>)}
          </Select>
          <p id={id + '-help'} className="text-sm text-muted-foreground">{text('help')} {text('noneHelp')}</p>
          <p id={id + '-preview'} className="text-sm font-medium">
            {chosen?.active ? text('preview', { fee: money(chosen.amountCents, chosen.currency) }) : text('previewNone')}</p>
          {!charges.some((charge) => charge.active) && <p className="text-sm text-muted-foreground">{text('noCharges')}</p>}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit">{text('save')}</Button>
          <Button type="button" variant="outline" onClick={() => void load()}>{text('reload')}</Button>
        </div>
      </fieldset>
    </form>
  </div>;
}
