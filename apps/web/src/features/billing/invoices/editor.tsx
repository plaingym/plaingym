// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { localDate } from '@plaingym/shared/time';
import { useBootstrap } from '../../../app/context.js';
import { invoiceError, type InvoiceClient } from './api.js';
import { text, decimalUnits, money } from './format.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Select, CheckboxField } from '../../../components/ui/select.js';
import { Alert } from '../../../components/ui/alert.js';
import { LoadingState, ErrorState } from '../../../components/ui/states.js';

export function OneOffEditor({ gymId, householdId, client, close, created }: {
  gymId: string; householdId?: string; client: InvoiceClient; close: () => void; created: (invoiceId: string) => void;
}) {
  const bootstrap = useBootstrap();
  const gym = bootstrap.data?.gym;
  const [search, setSearch] = useState(''), [chosen, setChosen] = useState(householdId ?? '');
  const [source, setSource] = useState('charge_type'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const setup = useQuery({ queryKey: ['billing', gymId, 'invoice-editor'], queryFn: async () => {
    const [charges, taxes] = await Promise.all([client.charges(), client.taxes()]); return { charges, taxes };
  } });
  const homes = useQuery({ queryKey: ['billing', gymId, 'household-search', search], queryFn: () => client.households(search), enabled: !householdId });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!setup.data || !gym) return;
    const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const body = source === 'charge_type' ? { source, householdId: chosen, dueOn: form.get('dueOn'), chargeTypeId: form.get('chargeTypeId') }
        : { source, householdId: chosen, dueOn: form.get('dueOn'), description: form.get('description'),
          amountCents: decimalUnits(String(form.get('amount')), 2), currency: gym.currency, taxRateIds: form.getAll('taxRateIds') };
      const result = await client.call('createOneOffInvoice', body); created(result.data.id);
    } catch (error) { setError(invoiceError(error)); } finally { setBusy(false); }
  }
  return <Dialog title={text('create')} closeLabel={text('close')} onClose={() => { if (!busy) close(); }}>
    {(setup.isPending || bootstrap.isPending) && <LoadingState/>}{setup.isError && <ErrorState onRetry={() => void setup.refetch()}/>}
    {bootstrap.isError && <ErrorState onRetry={() => void bootstrap.refetch()}/>}
    {error && <Alert role="alert">{error}</Alert>}
    {setup.data && gym && <form className="space-y-4" onSubmit={event => void submit(event)}>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        {!householdId && <>
          <Label className="block">{text('searchHousehold')}<Input value={search} onChange={event => { setSearch(event.target.value); setChosen(''); }}/></Label>
          {homes.isPending && <LoadingState/>}{homes.isError && <ErrorState onRetry={() => void homes.refetch()}/>}
          <Label className="block">{text('household')}<Select required value={chosen} onChange={event => setChosen(event.target.value)}>
            <option value="">{text('chooseHousehold')}</option>{homes.data?.data.map(home => <option key={home.id} value={home.id}>{home.name}</option>)}
          </Select></Label>
          <p className="text-sm text-muted-foreground">{text('householdSearchHelp')}</p>
        </>}
        <Label className="block">{text('source')}<Select value={source} onChange={event => setSource(event.target.value)}><option value="charge_type">{text('chargeType')}</option><option value="custom">{text('custom')}</option></Select></Label>
        {source === 'charge_type' ? <Label className="block">{text('chargeType')}<Select name="chargeTypeId" required><option value="">{text('chooseCharge')}</option>
          {setup.data.charges.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name} · {money(c.amountCents, c.currency)}</option>)}</Select></Label>
          : <>
            <Label className="block">{text('description')}<Input name="description" required/></Label>
            <Label className="block">{text('amount')} ({gym.currency})<Input name="amount" inputMode="decimal" required pattern="[0-9]+([.][0-9]{1,2})?"/></Label>
            <fieldset><legend className="text-sm font-medium">{text('taxes')}</legend>{setup.data.taxes.filter(t => t.active).map(t => <CheckboxField key={t.id} name="taxRateIds" value={t.id} label={t.name}/>)}</fieldset>
          </>}
        <Label className="block">{text('dueOn')}<Input name="dueOn" type="date" required defaultValue={localDate(new Date(), gym.timezone)}/></Label>
        <p className="text-sm text-muted-foreground">{text('createHelp')}</p>
        <Button type="submit" className="w-full sm:w-auto">{text(busy ? 'saving' : 'create')}</Button>
      </fieldset>
    </form>}
  </Dialog>;
}
