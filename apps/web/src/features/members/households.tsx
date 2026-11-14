// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as c from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField } from '../../components/ui/select.js';
import { LoadingState } from '../../components/ui/states.js';
import { Autocomplete } from '../../components/ui/autocomplete.js';
import { useDialogSaved } from '../../components/ui/dialog.js';
import { memberRequest } from './api.js';
import { Field, Panel, ErrorMessage, text, useDraft, useMemberSave } from './common.js';
import { basisPointsToPercent, percentToBasisPoints } from '../billing/discounts/percent.js';

export function HouseholdsManager({ gymId }: { gymId: string }) {
  const [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState('');
  const query = useQuery({ queryKey: ['members', gymId, 'household-manager', search, offset], queryFn: ({ signal }) => memberRequest(c.householdListResponseSchema,
    '/api/households?' + new URLSearchParams({ limit: '50', offset: String(offset), ...(search ? { search } : {}) }), 'GET', undefined, signal) });
  return <div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
    <Autocomplete label={text('searchHouseholds')} query={search} value={selected} onQueryChange={value => { setSearch(value); setOffset(0); }} onChange={setSelected}
      options={(query.data?.data ?? []).map(home => ({ id: home.id, label: home.name }))} loading={query.isPending} />
    {selected && <Button variant="outline" onClick={() => { setSelected(''); setSearch(''); }}>{text('createHousehold')}</Button>}
    <ErrorMessage error={query.error}/>
    <Pager offset={offset} total={query.data?.pagination.total ?? 0} limit={50} onChange={setOffset} previousLabel={text('previous')} nextLabel={text('next')}/>
    {selected ? <HouseholdDetails key={selected} gymId={gymId} householdId={selected} onDeleted={() => { setSelected(''); setSearch(''); }}/>
      : <HouseholdForm onSaved={(home) => { setSelected(home.id); setSearch(home.name); }}/>}
  </div>;
}

export function HouseholdForm({ household, onSaved }: { household?: c.Household; onSaved?: (household: c.Household) => void }) {
  const markSaved = useDialogSaved();
  const draft = useDraft({ name: household?.name ?? '', email: household?.email ?? '', phone: household?.phone ?? '', address: household?.address ?? ({} as c.HouseholdAddress) });
  const state = useMemberSave(), { values, set } = draft, address = values.address;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    void state.save(async () => {
      // Only edited fields are sent, so a PIN or billing save in between never reverts them.
      const changed = household ? draft.changes() : values;
      if (household && !Object.keys(changed).length) return;
      const input = { ...(changed.name === undefined ? {} : { name: changed.name }), ...(changed.email === undefined ? {} : { email: changed.email || null }),
        ...(changed.phone === undefined ? {} : { phone: changed.phone || null }),
        ...(changed.address === undefined ? {} : { address: Object.fromEntries(Object.entries(changed.address).filter(([, value]) => value)) }) };
      const saved = household ? await memberRequest(c.householdResponseSchema, `/api/households/${household.id}`, 'PATCH', c.updateHouseholdRequestSchema.parse({ ...input, revision: household.revision }))
        : await memberRequest(c.householdResponseSchema, '/api/households', 'POST', c.createHouseholdRequestSchema.parse(input));
      onSaved?.(saved.data);
    }, () => { draft.reset(); markSaved(formElement); });
  }
  return <form onSubmit={submit} className="space-y-3"><ErrorMessage error={state.error}/>
    <Field name="householdName" value={values.name} onChange={(value) => set('name', value)} required/><Field name="email" type="email" value={values.email} onChange={(value) => set('email', value)}/><Field name="phone" value={values.phone} onChange={(value) => set('phone', value)}/>
    <div className="grid gap-3 sm:grid-cols-2">{(['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'] as const).map((key) => <Field key={key} name={key} value={address[key] ?? ''} onChange={(value) => set('address', { ...address, [key]: key === 'countryCode' ? value.toUpperCase() : value })}/>)}</div>
    <Button type="submit" className="w-full sm:w-auto" disabled={state.busy}>{text(household ? 'save' : 'createHousehold')}</Button>
  </form>;
}
export function HouseholdDetails({ householdId, gymId, onDeleted }: { householdId: string; gymId: string; onDeleted?: () => void }) {
  const query = useQuery({ queryKey: ['members', gymId, 'household', householdId], queryFn: ({ signal }) => memberRequest(c.householdResponseSchema, `/api/households/${householdId}`, 'GET', undefined, signal) });
  const billing = useQuery({ queryKey: ['members', gymId, 'billing', householdId], queryFn: ({ signal }) => memberRequest(c.householdBillingSettingsResponseSchema, `/api/households/${householdId}/billing-settings`, 'GET', undefined, signal) });
  return <Panel title={text('household')}><ErrorMessage error={query.error}/>{query.isPending && <LoadingState label={text('loading')}/>}{query.data && <>
    <HouseholdForm household={query.data.data}/>
    <PinForm household={query.data.data}/>
    {billing.data && <BillingForm billing={billing.data.data}/>}
    {onDeleted && <DeleteHousehold household={query.data.data} onDeleted={onDeleted}/>}
  </>}</Panel>;
}
function DeleteHousehold({ household, onDeleted }: { household: c.Household; onDeleted: () => void }) {
  const state = useMemberSave(), [confirmed, setConfirmed] = useState(false);
  return <div className="space-y-3 border-t border-border pt-4"><p className="text-sm">{text('deleteHouseholdWarning')}</p><CheckboxField label={text('confirmDelete')} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/>
    <Button variant="outline" className="w-full border-destructive text-destructive sm:w-auto" disabled={!confirmed || state.busy} onClick={() => void state.save(() => memberRequest(c.membersContracts.deleteHousehold.response, `/api/households/${household.id}`, 'DELETE', { revision: household.revision }), onDeleted)}>{text('deleteHousehold')}</Button><ErrorMessage error={state.error}/>
  </div>;
}
function PinForm({ household }: { household: c.Household }) {
  const [pin, setPin] = useState(''), state = useMemberSave();
  const submit = (clear: boolean) => void state.save(() => memberRequest(c.householdResponseSchema, `/api/households/${household.id}/pin`, 'PUT', c.setHouseholdPinRequestSchema.parse({ revision: household.revision, pin: clear ? null : pin })), () => setPin(''));
  return <form className="space-y-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); submit(false); }}><ErrorMessage error={state.error}/>
    <Label className="grid gap-2">{text('pin')}<Input type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4,8}" minLength={4} maxLength={8} value={pin} onChange={(event) => setPin(event.target.value)} required/></Label>
    <div className="grid grid-cols-2 gap-2 sm:flex"><Button type="submit" disabled={state.busy}>{text('setPin')}</Button><Button type="button" variant="outline" disabled={state.busy} onClick={() => submit(true)}>{text('clearPin')}</Button></div>
  </form>;
}
function BillingForm({ billing }: { billing: c.HouseholdBillingSettings }) {
  const draft = useDraft({ day: String(billing.billingDay), discount: basisPointsToPercent(billing.familyDiscountBasisPoints) }), state = useMemberSave();
  // The household revision also changes with contact and PIN saves; draft.changes() catches real conflicts.
  return <form className="space-y-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); void state.save(async () => {
    const { day, discount } = { ...draft.values, ...draft.changes() };
    const familyDiscountBasisPoints = /^0(?:\.0{1,2})?$/.test(discount) ? 0 : percentToBasisPoints(discount);
    await memberRequest(c.householdBillingSettingsResponseSchema, `/api/households/${billing.id}/billing-settings`, 'PATCH', c.updateHouseholdBillingSettingsRequestSchema.parse({ revision: billing.revision, billingDay: Number(day), familyDiscountBasisPoints }));
  }, draft.reset); }}>
    <ErrorMessage error={state.error}/><Field name="billingDay" type="number" value={draft.values.day} onChange={(value) => draft.set('day', value)}/>
    <Label className="grid gap-2">{text('discount')}<Input type="number" min="0" max="100" step="0.01" required value={draft.values.discount} onChange={event => draft.set('discount', event.target.value)}/></Label>
    <Button type="submit" className="w-full sm:w-auto" disabled={state.busy}>{text('saveBilling')}</Button>
  </form>;
}
