// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type FormEvent } from 'react';
import { createClassPackRequestSchema, updateClassPackRequestSchema, type ClassPack, type TaxRate } from '@plaingym/shared/contracts';
import { amountInputStep, minorUnitsToInput, parseMinorUnits } from '@plaingym/shared/money';
import { Dialog } from '../../../components/ui/dialog.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { ApiError } from '../../../lib/api.js';
import type { PackClient } from './api.js';
import { failure, text } from './messages.js';

export function PackEditor({ record, currency, taxes, client, close, saved }: {
  record?: ClassPack; currency: string; taxes: TaxRate[]; client: PackClient; close(): void; saved(): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const denomination = record?.currency ?? currency;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || stale) return;
    const form = new FormData(event.currentTarget);
    let input: Record<string, unknown>;
    try {
      input = { name: String(form.get('name')).trim(), currency: denomination,
        amountCents: parseMinorUnits(String(form.get('amount')), denomination),
        credits: Number(form.get('credits')), expiryDays: form.get('expiryDays') ? Number(form.get('expiryDays')) : null,
        taxRateIds: form.getAll('taxRateIds'), active: form.has('active'), ...(record ? { revision: record.revision } : {}) };
      (record ? updateClassPackRequestSchema : createClassPackRequestSchema).parse(input);
    } catch { setError(text('invalidPack')); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (record) await client.call('updateClassPack', input, { packId: record.id });
      else await client.call('createClassPack', input);
      saved();
    } catch (cause) {
      if (record && cause instanceof ApiError && cause.status === 409) { setStale(true); setError(text('stale')); }
      else setError(failure(cause));
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={text(record ? 'editPack' : 'createPack')} closeLabel={text('close')} onClose={close} dismissible={!busy}>
    <form onSubmit={event => void submit(event)} className="min-w-0 space-y-4 wrap-anywhere">
      {error && <Alert role="alert">{error}</Alert>}
      <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Label className="block min-w-0 sm:col-span-2">{text('name')}<Input name="name" required defaultValue={record?.name}/></Label>
        <Label className="block min-w-0">{text('price', { currency: denomination })}<Input name="amount" type="number" inputMode="decimal" min="0" step={amountInputStep(denomination)} required defaultValue={minorUnitsToInput(record?.amountCents ?? 0, denomination)}/></Label>
        <Label className="block min-w-0">{text('credits')}<Input name="credits" type="number" min="1" max="100" step="1" required defaultValue={record?.credits ?? 10}/></Label>
        <Label className="block min-w-0 sm:col-span-2">{text('expiryDays')}<Input name="expiryDays" type="number" min="1" max="3650" step="1" defaultValue={record?.expiryDays ?? ''}/></Label>
        <p className="text-sm text-muted-foreground sm:col-span-2">{text('expiryHelp')}</p>
        <fieldset className="min-w-0 sm:col-span-2"><legend className="font-medium">{text('taxRates')}</legend>
          {taxes.filter(rate => rate.active || record?.taxRateIds.includes(rate.id)).map(rate => <CheckboxField key={rate.id} name="taxRateIds" value={rate.id} defaultChecked={record?.taxRateIds.includes(rate.id)} label={rate.name + (rate.active ? '' : ' · ' + text('archived'))}/>)}
          {!taxes.length && <p className="text-sm text-muted-foreground">{text('noTaxes')}</p>}
        </fieldset>
        <CheckboxField name="active" defaultChecked={record?.active ?? true} label={text('active')}/>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
          <Button type="submit" disabled={stale}>{text(busy ? 'working' : 'save')}</Button>
          <Button variant="outline" onClick={close}>{text(stale ? 'closeReload' : 'cancel')}</Button>
        </div>
      </fieldset>
    </form>
  </Dialog>;
}
