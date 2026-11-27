// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as c from '@plaingym/shared/contracts';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { PhoneInput } from '../../components/ui/phone-input.js';
import { useBootstrap } from '../../app/context.js';
import { t } from '../../lib/i18n.js';
import { CheckboxField } from '../../components/ui/select.js';
import { LoadingState } from '../../components/ui/states.js';
import { Autocomplete } from '../../components/ui/autocomplete.js';
import { useDialogSaved } from '../../components/ui/dialog.js';
import { memberRequest } from './api.js';
import { Field, Panel, ErrorMessage, text, useDraft, useMemberSave } from './common.js';
import { basisPointsToPercent, percentToBasisPoints } from '../billing/discounts/percent.js';
import { samePhoneAs, StaffSmsConsent } from './sms-consent.js';
import { useGymTime } from '../../lib/instant.js';

export function HouseholdsManager({ gymId, pricing }: { gymId: string; pricing: boolean }) {
  const [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState('');
  const query = useQuery({ queryKey: ['members', gymId, 'household-manager', search, offset], queryFn: ({ signal }) => memberRequest(c.householdListResponseSchema,
    '/api/households?' + new URLSearchParams({ limit: '50', offset: String(offset), ...(search ? { search } : {}) }), 'GET', undefined, signal) });
  return <div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
    <Autocomplete label={text('searchHouseholds')} query={search} value={selected} onQueryChange={value => { setSearch(value); setOffset(0); }} onChange={setSelected}
      options={(query.data?.data ?? []).map(home => ({ id: home.id, label: home.name }))} loading={query.isPending} />
    {selected && <Button variant="outline" onClick={() => { setSelected(''); setSearch(''); }}>{text('createHousehold')}</Button>}
    <ErrorMessage error={query.error}/>
    <Pager offset={offset} total={query.data?.pagination.total ?? 0} limit={50} onChange={setOffset} previousLabel={text('previous')} nextLabel={text('next')}/>
    {selected ? <HouseholdDetails key={selected} gymId={gymId} householdId={selected} pricing={pricing} onDeleted={() => { setSelected(''); setSearch(''); }}/>
      : <HouseholdForm onSaved={(home) => { setSelected(home.id); setSearch(home.name); }}/>}
  </div>;
}

export function HouseholdForm({ household, onSaved }: { household?: c.Household; onSaved?: (household: c.Household) => void }) {
  const markSaved = useDialogSaved();
  const draft = useDraft({ name: household?.name ?? '', email: household?.email ?? '', phone: household?.phone ?? '', address: household?.address ?? ({} as c.HouseholdAddress) });
  const state = useMemberSave(), { values, set } = draft, address = values.address;
  // Two of these forms can be on one screen (the households panel and the add-member dialog), so the phone ids are per form.
  const country = useBootstrap().data?.gym.country, phoneId = useId();
  // Counts resets, so the phone field drops a country chosen with no number even when the reset leaves its value unchanged.
  const [resets, setResets] = useState(0);
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
    }, () => { draft.reset(); setResets((count) => count + 1); markSaved(formElement); });
  }
  return <form onSubmit={submit} className="space-y-3"><ErrorMessage error={state.error}/>
    <Field name="householdName" value={values.name} onChange={(value) => set('name', value)} required/><Field name="email" type="email" value={values.email} onChange={(value) => set('email', value)}/><PhoneInput id={phoneId} label={text('phone')} value={values.phone} onChange={(value) => set('phone', value)} defaultCountry={country}
      resetKey={resets} {...(country ? {} : { hint: t('shell/phone:noGymCountry') })}/>
    <div className="grid gap-3 sm:grid-cols-2">{(['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'] as const).map((key) => <Field key={key} name={key} value={address[key] ?? ''} onChange={(value) => set('address', { ...address, [key]: key === 'countryCode' ? value.toUpperCase() : value })}/>)}</div>
    <Button type="submit" className="w-full sm:w-auto" disabled={state.busy}>{text(household ? 'save' : 'createHousehold')}</Button>
  </form>;
}
/**
 * With `member` (a member's profile), the billing consent panel says when the member's own phone is this number.
 * Without `pricing` (plan management), the family discount is read-only.
 */
export function HouseholdDetails({ householdId, gymId, pricing, onDeleted, member }: { householdId: string; gymId: string; pricing: boolean; onDeleted?: () => void; member?: c.Member }) {
  const query = useQuery({ queryKey: ['members', gymId, 'household', householdId], queryFn: ({ signal }) => memberRequest(c.householdResponseSchema, `/api/households/${householdId}`, 'GET', undefined, signal) });
  const billing = useQuery({ queryKey: ['members', gymId, 'billing', householdId], queryFn: ({ signal }) => memberRequest(c.householdBillingSettingsResponseSchema, `/api/households/${householdId}/billing-settings`, 'GET', undefined, signal) });
  return <Panel title={text('household')}><ErrorMessage error={query.error}/>{query.isPending && <LoadingState label={text('loading')}/>}{query.data && <>
    <HouseholdForm household={query.data.data}/>
    <StaffSmsConsent record={query.data.data} household
      samePhone={samePhoneAs(query.data.data, member, { other: 'member', name: member ? `${member.firstName} ${member.lastName}` : '' })}/>
    <PinForm household={query.data.data} gymId={gymId}/>
    {billing.data && <BillingForm billing={billing.data.data} pricing={pricing}/>}
    {onDeleted && <DeleteHousehold household={query.data.data} onDeleted={onDeleted}/>}
  </>}</Panel>;
}
function DeleteHousehold({ household, onDeleted }: { household: c.Household; onDeleted: () => void }) {
  const state = useMemberSave(), [confirmed, setConfirmed] = useState(false);
  return <div className="space-y-3 border-t border-border pt-4"><p className="text-sm">{text('deleteHouseholdWarning')}</p><CheckboxField label={text('confirmDelete')} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/>
    <Button variant="outline" className="w-full border-destructive text-destructive sm:w-auto" disabled={!confirmed || state.busy} onClick={() => void state.save(() => memberRequest(c.membersContracts.deleteHousehold.response, `/api/households/${household.id}`, 'DELETE', { revision: household.revision }), onDeleted)}>{text('deleteHousehold')}</Button><ErrorMessage error={state.error}/>
  </div>;
}
function PinForm({ household, gymId }: { household: c.Household; gymId: string }) {
  const [pin, setPin] = useState(''), state = useMemberSave(), { instantLabel } = useGymTime();
  // What the last save did; the household query refetches after it, so `household.pinSet` follows.
  const [saved, setSaved] = useState<{ cleared: boolean; shared: boolean } | null>(null), [lockCleared, setLockCleared] = useState(false);
  // The kiosk's wrong-PIN lock; a read that fails or is pending shows nothing and never blocks the form. Every save
  // refetches the members queries, this one included.
  const lock = useQuery({ queryKey: ['members', gymId, 'household-pin-lock', household.id], enabled: household.pinSet,
    queryFn: ({ signal }) => memberRequest(c.householdPinLockResponseSchema, `/api/households/${household.id}/pin-lock`, 'GET', undefined, signal) });
  const lockedUntil = household.pinSet ? lock.data?.data.lockedUntil ?? null : null;
  // A lock ends on its own: at its end the notice goes and the lock is read again, so a profile left open never
  // shows an ended lock.
  const [ended, setEnded] = useState<string | null>(null), refetchLock = lock.refetch;
  useEffect(() => {
    if (!lockedUntil) return;
    const timer = setTimeout(() => { setEnded(lockedUntil); void refetchLock(); },
      Math.min(Math.max(Date.parse(lockedUntil) - Date.now(), 0), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [lockedUntil, refetchLock]);
  const locked = lockedUntil !== null && lockedUntil !== ended;
  const submit = (clear: boolean) => { setSaved(null); setLockCleared(false); void state.save(async () => {
    const result = await memberRequest(c.setHouseholdPinResponseSchema, `/api/households/${household.id}/pin`, 'PUT', c.setHouseholdPinRequestSchema.parse({ revision: household.revision, pin: clear ? null : pin }));
    setSaved({ cleared: clear, shared: result.sharedPin });
  }, () => setPin('')); };
  const clearLock = () => { setSaved(null); setLockCleared(false); void state.save(
    () => memberRequest(c.householdResponseSchema, `/api/households/${household.id}/pin-lock/clear`, 'POST', c.clearHouseholdPinLockRequestSchema.parse({ revision: household.revision })),
    () => setLockCleared(true)); };
  return <form className="space-y-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); submit(false); }}><ErrorMessage error={state.error}/>
    <p className="text-sm">{text(household.pinSet ? 'pinIsSet' : 'pinNotSet')}</p>
    {locked && lockedUntil && <Alert variant="warning" className="space-y-3">
      <p>{t('members/members:pinLocked', { time: instantLabel(lockedUntil) })}</p>
      <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={state.busy} onClick={clearLock}>{text('clearPinLock')}</Button>
    </Alert>}
    {lockCleared && <p role="status" className="text-sm">{text('pinLockCleared')}</p>}
    <Label className="grid gap-2">{text(household.pinSet ? 'pinNew' : 'pin')}<Input type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4,8}" minLength={4} maxLength={8} value={pin} onChange={(event) => setPin(event.target.value)} required/></Label>
    <div className="grid grid-cols-2 gap-2 sm:flex"><Button type="submit" disabled={state.busy}>{text('setPin')}</Button><Button type="button" variant="outline" disabled={state.busy || !household.pinSet} onClick={() => submit(true)}>{text('clearPin')}</Button></div>
    {saved && <p role="status" className="text-sm">{text(saved.cleared ? 'pinCleared' : 'pinSaved')}</p>}
    {saved?.shared && <Alert variant="warning">{text('pinShared')}</Alert>}
  </form>;
}
/** Without `pricing` the discount is read-only and a save sends the stored one, so only the billing day changes. */
function BillingForm({ billing, pricing }: { billing: c.HouseholdBillingSettings; pricing: boolean }) {
  const draft = useDraft({ day: String(billing.billingDay), discount: basisPointsToPercent(billing.familyDiscountBasisPoints) }), state = useMemberSave();
  const [discountError, setDiscountError] = useState(false);
  const describedBy = pricing ? (discountError ? `discount-error-${billing.id}` : undefined) : `discount-note-${billing.id}`;
  // The household revision also changes with contact and PIN saves; draft.changes() catches real conflicts.
  return <form className="space-y-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault();
    let familyDiscountBasisPoints = billing.familyDiscountBasisPoints;
    if (pricing) {
      try { familyDiscountBasisPoints = percentToBasisPoints(draft.values.discount.trim(), { min: 0 }); }
      catch { setDiscountError(true); return; }
    }
    setDiscountError(false);
    void state.save(async () => {
    const { day } = { ...draft.values, ...draft.changes() };
    await memberRequest(c.householdBillingSettingsResponseSchema, `/api/households/${billing.id}/billing-settings`, 'PATCH', c.updateHouseholdBillingSettingsRequestSchema.parse({ revision: billing.revision, billingDay: Number(day), familyDiscountBasisPoints }));
  }, draft.reset); }}>
    <ErrorMessage error={state.error}/><Field name="billingDay" type="number" value={draft.values.day} onChange={(value) => draft.set('day', value)}/>
    <Label className="grid gap-2">{text('discount')}<Input type="text" inputMode="decimal" required readOnly={!pricing} aria-invalid={discountError} aria-describedby={describedBy}
      value={draft.values.discount} onChange={event => { draft.set('discount', event.target.value); setDiscountError(false); }}/></Label>
    {!pricing && <p id={`discount-note-${billing.id}`} className="text-sm text-muted-foreground">{text('discountManagersOnly')}</p>}
    {discountError && <p id={`discount-error-${billing.id}`} role="alert" className="text-sm text-destructive">{text('invalidDiscount')}</p>}
    <Button type="submit" className="w-full sm:w-auto" disabled={state.busy}>{text('saveBilling')}</Button>
  </form>;
}
