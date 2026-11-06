// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import type { ChargeType, Plan, TaxRate, TaxRateUsage } from '@plaingym/shared/contracts';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Alert } from '../../../components/ui/alert.js';
import { amountInputStep, decimalUnits, minorUnitsToInput, parseMinorUnits, say, selectClass, text } from './format.js';

/** Confirms removing a tax rate from everything that carries it, archiving it if active. */
export function ArchiveConfirmation({ rate, usage, busy, confirm, cancel }: {
  rate: TaxRate; usage: TaxRateUsage; busy: boolean; confirm: () => Promise<void>; cancel: () => void;
}) {
  const items = usage.chargeTypes.length + usage.plans.length;
  const status = (active: boolean) => active ? '' : ' (' + text('inactive') + ')';
  return <section aria-labelledby="archive-tax-title" className="min-w-0 space-y-3 rounded-lg border border-destructive p-4">
    <h2 id="archive-tax-title" className="text-lg font-semibold">{say(rate.active ? 'archiveTitle' : 'detachTitle', { name: rate.name })}</h2>
    <p>{text(rate.active ? 'archiveHelp' : 'detachHelp')}</p>
    {usage.chargeTypes.length > 0 && <div><h3 className="font-medium">{text('charges')}</h3>
      <ul className="list-disc pl-5">{usage.chargeTypes.map(item => <li key={item.id}>{item.name}{status(item.active)}</li>)}</ul></div>}
    {usage.plans.length > 0 && <div><h3 className="font-medium">{text('plans')}</h3>
      <ul className="list-disc pl-5">{usage.plans.map(item => <li key={item.id}>{say('archivePlan', { name: item.name, count: item.memberships })}{status(item.active)}</li>)}</ul></div>}
    {usage.plans.length > 0 && <p role="note" className="font-medium">{say('archiveMemberships', { count: usage.memberships })}</p>}
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button disabled={busy} onClick={() => void confirm()}>{say(rate.active ? 'archiveConfirm' : 'detachConfirm', { count: items })}</Button>
      <Button variant="outline" disabled={busy} onClick={cancel}>{text('cancel')}</Button>
    </div>
  </section>;
}

export type CatalogKind = 'plans' | 'taxes' | 'charges';
export type CatalogRecord = Plan | ChargeType | TaxRate;
export function CatalogEditor({ kind, record, currency, taxes, busy, locked = false, save, cancel }: {
  kind: CatalogKind; record?: CatalogRecord; currency: string; taxes: TaxRate[]; busy: boolean;
  /** Holds the draft while a confirmation for it is open, so the confirmed values are the ones on screen. */
  locked?: boolean;
  save: (data: Record<string, unknown>) => Promise<void>; cancel: () => void;
}) {
  const [invalid, setInvalid] = useState(false);
  const price = record && 'amountCents' in record ? record : undefined;
  const plan = record && 'signupFeeCents' in record ? record : undefined;
  const tax = record && 'rateMillionths' in record ? record : undefined;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setInvalid(false);
    let data: Record<string, unknown>;
    try {
      data = { name: String(form.get('name')).trim(), active: form.has('active') };
      if (kind === 'taxes') Object.assign(data, { rateMillionths: decimalUnits(String(form.get('rate')), 4), inclusive: form.has('inclusive') });
      else Object.assign(data, { amountCents: parseMinorUnits(String(form.get('amount')), currency), currency, taxRateIds: form.getAll('taxRateIds') });
      if (kind === 'plans') Object.assign(data, { interval: form.get('interval'), signupFeeCents: parseMinorUnits(String(form.get('signupFee')), currency),
        trialDays: Number(form.get('trialDays')), commitmentMonths: form.get('commitmentMonths') ? Number(form.get('commitmentMonths')) : null });
    } catch { setInvalid(true); return; }
    await save({ ...data, ...(record ? { revision: record.revision } : {}) });
  }
  return <form onSubmit={event => void submit(event)} className="min-w-0 space-y-4 rounded-lg border p-4">
    <h2 className="text-lg font-semibold">{text(record ? 'edit' : 'create')} {text(kind)}</h2>
    {invalid && <Alert role="alert">{text('invalid')}</Alert>}
    <fieldset disabled={busy || locked} className="grid min-w-0 gap-4 sm:grid-cols-2">
      <Label className="block min-w-0 sm:col-span-2">{text('name')}<Input name="name" required defaultValue={record?.name}/></Label>
      {kind === 'taxes' ? <>
        <Label className="block min-w-0">{text('rate')}<Input name="rate" inputMode="decimal" type="number" min="0" max="100" step="0.0001" required defaultValue={tax ? tax.rateMillionths / 10_000 : 0}/></Label>
        <Label className="flex min-h-11 items-center gap-3"><input className="size-5" type="checkbox" name="inclusive" defaultChecked={tax?.inclusive}/>{text('inclusive')}</Label>
      </> : <>
        <Label className="block min-w-0">{text('amount')} ({currency})<Input name="amount" inputMode="decimal" type="number" min="0" step={amountInputStep(currency)} required defaultValue={minorUnitsToInput(price?.amountCents ?? 0, currency)}/></Label>
        {kind === 'plans' && <>
          <Label className="block min-w-0">{text('interval')}<select className={selectClass} name="interval" defaultValue={plan?.interval ?? 'monthly'}><option value="monthly">{text('monthly')}</option><option value="annual">{text('annual')}</option></select></Label>
          <Label className="block min-w-0">{text('signupFee')} ({currency})<Input name="signupFee" type="number" inputMode="decimal" min="0" step={amountInputStep(currency)} required defaultValue={minorUnitsToInput(plan?.signupFeeCents ?? 0, currency)}/></Label>
          <Label className="block min-w-0">{text('trialDays')}<Input name="trialDays" type="number" min="0" step="1" required defaultValue={plan?.trialDays ?? 0}/></Label>
          <Label className="block min-w-0">{text('commitmentMonths')}<Input name="commitmentMonths" type="number" min="1" step="1" defaultValue={plan?.commitmentMonths ?? ''}/></Label>
        </>}
        <fieldset className="min-w-0 sm:col-span-2"><legend className="font-medium">{text('taxes')}</legend>
          {!taxes.length && <p className="text-sm text-muted-foreground">{text('noTaxes')}</p>}
          {taxes.filter(item => item.active || price?.taxRateIds.includes(item.id)).map(item => <Label key={item.id} className="flex min-h-11 items-center gap-3">
            <input className="size-5 shrink-0" type="checkbox" name="taxRateIds" value={item.id} defaultChecked={price?.taxRateIds.includes(item.id)}/>
            {item.name} ({item.rateMillionths / 10_000}%, {text(item.inclusive ? 'inclusive' : 'exclusive')}{item.active ? '' : ', ' + text('inactive')})
          </Label>)}
        </fieldset>
      </>}
      <Label className="flex min-h-11 items-center gap-3"><input className="size-5" type="checkbox" name="active" defaultChecked={record?.active ?? true}/>{text('active')}</Label>
      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row"><Button type="submit">{text(busy ? 'saving' : 'save')}</Button><Button variant="outline" onClick={cancel}>{text('cancel')}</Button></div>
    </fieldset>
  </form>;
}
