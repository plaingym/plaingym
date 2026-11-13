// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type FormEvent } from 'react';
import { createDiscountRequestSchema, type Discount, type Plan } from '@plaingym/shared/contracts';
import { minorUnitsToInput, parseMinorUnits } from '@plaingym/shared/money';
import { Dialog } from '../../../components/ui/dialog.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField, Select } from '../../../components/ui/select.js';
import { ApiError } from '../../../lib/api.js';
import type { DiscountClient } from './api.js';
import { failure, text } from './messages.js';
import { basisPointsToPercent, percentToBasisPoints } from './percent.js';

export function DiscountEditor({ record, currency, plans, client, close, saved }: {
  record?: Discount; currency: string; plans: Plan[]; client: DiscountClient; close(): void; saved(): void;
}) {
  const [kind, setKind] = useState(record?.percentBasisPoints !== null && record?.percentBasisPoints !== undefined ? 'percent' : record?.amountCents ? 'amount' : 'fee');
  const [duration, setDuration] = useState(record?.duration ?? 'once');
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false), locked = record?.termsLocked ?? false;
  const denomination = record?.currency ?? currency;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || stale) return;
    const form = new FormData(event.currentTarget);
    let input: Record<string, unknown>;
    try {
      const metadata = { name: String(form.get('name')).trim(), code: String(form.get('code') ?? '').trim() || null,
        endsOn: form.get('endsOn') || null, maxUses: form.get('maxUses') ? Number(form.get('maxUses')) : null,
        active: form.has('active'), planIds: form.getAll('planIds') };
      const terms = locked ? { percentBasisPoints: record!.percentBasisPoints, amountCents: record!.amountCents,
        currency: denomination, waivesSignupFee: record!.waivesSignupFee, duration: record!.duration, cycles: record!.cycles } : {
        percentBasisPoints: kind === 'percent' ? percentToBasisPoints(String(form.get('value'))) : null,
        amountCents: kind === 'amount' ? parseMinorUnits(String(form.get('value')), denomination) : null,
        currency: denomination, waivesSignupFee: kind === 'fee' || form.has('waivesSignupFee'),
        duration: kind === 'fee' ? null : duration, cycles: kind !== 'fee' && duration === 'cycles' ? Number(form.get('cycles')) : null };
      createDiscountRequestSchema.parse({ ...metadata, ...terms });
      input = { ...metadata, ...(!locked ? terms : {}), ...(record ? { revision: record.revision } : {}) };
    } catch { setError(text('invalid')); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (record) await client.update(record.id, input); else await client.create(input);
      saved();
    } catch (cause) {
      if (record && cause instanceof ApiError && cause.status === 409) setStale(true);
      setError(failure(cause));
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={text(record ? 'edit' : 'create')} closeLabel={text('close')} onClose={close} dismissible={!busy}>
    <form onSubmit={event => void submit(event)} className="min-w-0 space-y-4 wrap-anywhere">
      {error && <Alert role="alert">{error}</Alert>}
      <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Label className="block min-w-0 sm:col-span-2">{text('name')}<Input name="name" required maxLength={100} defaultValue={record?.name}/></Label>
        <Label className="block min-w-0 sm:col-span-2">{text('code')}<Input name="code" pattern="[A-Za-z0-9\-]{3,40}" maxLength={40} defaultValue={record?.code ?? ''}/></Label>
        <p className="text-sm text-muted-foreground sm:col-span-2">{text('codeHelp')}</p>
        <fieldset disabled={locked} className="min-w-0 space-y-4 sm:col-span-2">
          <legend className="font-medium">{text('terms')}</legend>
          <p className="text-sm text-muted-foreground">{text(locked ? 'locked' : 'termsHelp')}</p>
          <Label className="block min-w-0">{text('kind')}<Select value={kind} onChange={event => setKind(event.target.value)}>
            <option value="percent">{text('percentage')}</option><option value="amount">{text('fixed')}</option><option value="fee">{text('feeOnly')}</option>
          </Select></Label>
          {kind !== 'fee' && <>
            <Label className="block min-w-0">{text(kind === 'percent' ? 'percent' : 'amount', { currency: denomination })}<Input key={kind} name="value" inputMode="decimal" required
              defaultValue={kind === 'percent' ? (record?.percentBasisPoints === null || record?.percentBasisPoints === undefined ? '' : basisPointsToPercent(record.percentBasisPoints)) : record?.amountCents ? minorUnitsToInput(record.amountCents, denomination) : ''}/></Label>
            <Label className="block min-w-0">{text('duration')}<Select value={duration} onChange={event => setDuration(event.target.value as typeof duration)}>
              <option value="once">{text('once')}</option><option value="cycles">{text('cycles')}</option><option value="forever">{text('forever')}</option>
            </Select></Label>
            {duration === 'cycles' && <Label className="block min-w-0">{text('cycleCount')}<Input name="cycles" type="number" min={1} step={1} required defaultValue={record?.cycles ?? 1}/></Label>}
            <CheckboxField name="waivesSignupFee" label={text('waiveSignup')} defaultChecked={record?.waivesSignupFee}/>
          </>}
        </fieldset>
        <Label className="block min-w-0">{text('endsOn')}<Input name="endsOn" type="date" defaultValue={record?.endsOn ?? ''}/></Label>
        <Label className="block min-w-0">{text('maxUses')}<Input name="maxUses" type="number" min={Math.max(record?.uses ?? 0, 1)} step={1} defaultValue={record?.maxUses ?? ''}/></Label>
        <p className="text-sm text-muted-foreground sm:col-span-2">{text('limitsHelp')}</p>
        <fieldset className="min-w-0 sm:col-span-2"><legend className="font-medium">{text('plans')}</legend>
          <p className="text-sm text-muted-foreground">{text('plansHelp')}</p>
          {plans.filter(plan => plan.currency === denomination).map(plan => <CheckboxField key={plan.id} name="planIds" value={plan.id} label={plan.name} defaultChecked={record?.planIds.includes(plan.id)}/>)}
        </fieldset>
        <CheckboxField name="active" label={text('active')} defaultChecked={record?.active ?? true}/>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row"><Button type="submit" disabled={stale}>{text(busy ? 'saving' : 'save')}</Button>
          <Button variant="outline" onClick={close}>{text(stale ? 'closeReload' : 'cancel')}</Button></div>
      </fieldset>
    </form>
  </Dialog>;
}
