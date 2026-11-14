// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChargeType } from '@plaingym/shared/contracts';
import { bootstrapKey } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { SaveTimeoutError, useGymSettings } from './gym-settings.js';
import { t } from '../../lib/i18n.js';
import { billingClient } from '../billing/catalog/api.js';
import { money } from '../billing/catalog/format.js';
import { FormMessage } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';

const text = (key: string, values?: Record<string, string>) => t('settings/drop-in:' + key, values);
/** Chooses the charge type whose current price the public drop-in page shows; the price itself stays in the catalog. */
export function DropInSettings() {
  const id = useId(), cache = useQueryClient(), gym = useGymSettings(), settings = gym.settings;
  const [charges, setCharges] = useState<ChargeType[] | null>(null), [chargesFailed, setChargesFailed] = useState(false);
  const [choice, setChoice] = useState(''), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const shown = useMemo(() => message ? { kind: message === text('saved') ? 'status' as const : 'alert' as const, text: message } : null, [message]);
  const failed = gym.failed || chargesFailed;
  async function loadCharges() {
    setChargesFailed(false);
    try { setCharges(await billingClient.charges()); } catch { setChargesFailed(true); }
  }
  function reload() { setMessage(''); gym.reload(); void loadCharges(); }
  useEffect(() => { void loadCharges(); }, []);
  // Show the saved choice whenever the settings or the charge types come from the server; a save in another section
  // keeps this one. A saved ID that matches no charge type shows, and saves, as no drop-in fee.
  useEffect(() => {
    if (settings && charges) setChoice(charges.some((charge) => charge.id === settings.dropInChargeTypeId) ? settings.dropInChargeTypeId ?? '' : '');
  }, [gym.epoch, charges]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!settings || !charges) return;
    // A saved choice that was archived since can't be saved again; the server would refuse it.
    if (choice && !charges.find((charge) => charge.id === choice)?.active) { setMessage(text('archivedChoice')); return; }
    setBusy(true);
    try {
      const result = await gym.save((revision, signal) => api.PATCH('/api/settings/drop-in', { signal, body: { revision, dropInChargeTypeId: choice || null } }));
      if (result.status >= 300) {
        // A 409 is a changed revision (the hook reloads the settings) or a charge type archived since, and a 404 a charge
        // type removed since; reload the list in both.
        if (result.status === 409 || result.status === 404) void loadCharges();
        setMessage(text(result.status === 409 ? (result.moved ? 'conflict' : 'conflictKept') : result.status === 404 ? 'missing' : 'error'));
        return;
      }
      setChoice(result.settings.dropInChargeTypeId ?? ''); setMessage(text('saved'));
      // Every gym settings save refreshes the shell's cached gym summary, so it never lags a save made here.
      void cache.invalidateQueries({ queryKey: bootstrapKey });
    } catch (error) { setMessage(text(error instanceof SaveTimeoutError ? 'timeout' : 'error')); }
    finally { setBusy(false); }
  }
  if (!settings || !charges) return failed
    ? <ErrorState message={text('error')} onRetry={reload} retryLabel={text('reload')}/>
    : <LoadingState label={text('loading')}/>;
  const chosen = charges.find((charge) => charge.id === choice);
  // An archived choice stays visible so the select shows what is saved, but it can't be chosen again.
  const options = charges.filter((charge) => charge.active || charge.id === settings.dropInChargeTypeId);
  return <div className="min-w-0 space-y-4">
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    <FormMessage message={shown}/>
    {failed && <ErrorState message={text('error')} onRetry={reload}/>}
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
          <Button type="button" variant="outline" onClick={reload}>{text('reload')}</Button>
        </div>
      </fieldset>
    </form>
  </div>;
}
