// SPDX-License-Identifier: AGPL-3.0-only
import { calendarDateLabel as date } from '../../../lib/instant.js';
import { PortalRecovery } from './recovery.js';
import { useRef, useState, type ComponentProps, type FormEvent } from 'react';
import { useDraft } from '../../../lib/use-draft.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { portalContracts as contracts, type PortalContext, type PortalEmergencyContact, type PortalHousehold, type PortalMember } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { Dialog, DialogCancel } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Card } from '../../../components/ui/card.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { Badge, StackedItem, StackedList } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { conflict, gymToday, knownMinor, usePortalContext, usePortalScope, type PortalScope } from './api.js';
import { SmsConsentControls } from '../../members/sms-consent.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/household:' + key, values);

/** Reads the open household once; everything below is keyed by it and checks each answer was for it. */
export function PortalHousehold() {
  const scope = usePortalScope(), context = usePortalContext(scope);
  if (!context.data) return context.isPending || scope.settling ? <LoadingState /> : <ErrorState onRetry={() => void context.refetch()} />;
  return <PortalHouseholdPage context={context.data} scope={scope} />;
}
function PortalHouseholdPage({ context, scope }: { context: PortalContext; scope: PortalScope }) {
  const bootstrap = useBootstrap(), cache = useQueryClient(), { ready, own } = scope, payer = context.role === 'payer';
  const gymName = bootstrap.data?.gym.name ?? '';
  const [editing, setEditing] = useState<PortalMember | null>(null), [saved, setSaved] = useState<'saved' | 'unchanged' | null>(null);
  const household = useQuery({ queryKey: [...scope.key, 'household', 'details'], enabled: ready && payer, queryFn: async () => own(await scope.call(contracts.household)).data });
  const members = useQuery({ queryKey: [...scope.key, 'household', 'members'], enabled: ready, queryFn: async () => payer
    ? own(await scope.call(contracts.members, undefined, {}, { limit: 100, offset: 0 })).data
    : [own(await scope.call(contracts.profile, undefined, { memberId: context.memberId! })).data] });
  const timezone = bootstrap.data?.gym.timezone ?? 'UTC', today = gymToday(timezone);
  const editable = (member: PortalMember) => payer && (member.id === context.memberId || knownMinor(member.dateOfBirth, today));
  return <Page className="max-w-3xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text(payer ? 'title' : 'profileTitle')} description={text(payer ? 'description' : 'profileDescription')} />
    {/* A failed refetch keeps its data, so the form and its draft stay. */}
    {payer && (household.data ? <HouseholdForm key={household.data.id} household={household.data} scope={scope} gymName={gymName}
      saved={saved} setSaved={setSaved} refetch={() => household.refetch({ throwOnError: true })} />
      : household.isPending || scope.settling ? <LoadingState /> : <ErrorState onRetry={() => void household.refetch()} />)}
    <PageSection title={text(payer ? 'members' : 'profile')}>
      {members.isPending || (!members.data && scope.settling) ? <LoadingState /> : members.isError && <ErrorState onRetry={() => void members.refetch()} />}
      {members.data?.length === 0 && <EmptyState title={text('noMembers')} />}
      {!!members.data?.length && <StackedList>{members.data.map(member => <StackedItem key={member.id} className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 wrap-anywhere">
            <p className="font-semibold">{member.firstName} {member.lastName}{member.id === context.memberId && <span className="font-normal text-muted-foreground"> · {text('you')}</span>}</p>
            {member.dateOfBirth && <p className="text-sm text-muted-foreground">{text('born', { date: date(member.dateOfBirth) })}</p>}
            {(member.email || member.phone) && <p className="break-all text-sm">{[member.email, member.phone].filter(Boolean).join(' · ')}</p>}
          </div>
          <Badge tone={member.status === 'active' ? 'success' : 'muted'}>{text('status_' + member.status)}</Badge>
        </div>
        {member.emergencyContacts.length > 0 && <div className="text-sm"><p className="font-medium">{text('contacts')}</p>
          <ul className="space-y-1">{member.emergencyContacts.map((item, index) => <li key={index} className="wrap-anywhere">{item.name}
            {item.relationship && <span className="text-muted-foreground"> · {item.relationship}</span>} · {item.phone}{item.email && ` · ${item.email}`}</li>)}</ul></div>}
        <Memberships memberId={member.id} scope={scope} />
        {(member.id === context.memberId || editable(member)) && <SmsConsentControls sms={member.sms} gymName={gymName}
          onChange={async (kind, consent) => {
            own(await scope.call(contracts.changeMemberSmsConsent, { kind, consent, revision: member.revision }, { memberId: member.id }));
            await cache.invalidateQueries({ queryKey: [...scope.key, 'household'] });
          }}/>}
        {editable(member) && <div><Button variant="outline" onClick={() => setEditing(member)}>{text('edit')}</Button></div>}
      </StackedItem>)}</StackedList>}
      <p className="text-sm text-muted-foreground">{text(payer ? 'adultNote' : 'memberNote')}</p>
    </PageSection>
    {editing && <EditMember key={editing.id} member={editing} scope={scope} close={() => setEditing(null)} />}
  </PortalRecovery></Page>;
}
/** Memberships are shown for reference; the gym makes every membership change. */
function Memberships({ memberId, scope }: { memberId: string; scope: PortalScope }) {
  const [open, setOpen] = useState(false);
  const rows = useQuery({ queryKey: [...scope.key, 'household', 'memberships', memberId], enabled: open,
    queryFn: async () => scope.own(await scope.call(contracts.memberships, undefined, { memberId }, { limit: 50, offset: 0 })).data });
  return <div className="space-y-2">
    <Button variant="ghost" className="px-0" aria-expanded={open} onClick={() => setOpen(!open)}>{text(open ? 'hideMemberships' : 'showMemberships')}</Button>
    {open && (rows.isPending || (!rows.data && scope.settling) ? <LoadingState /> : rows.isError ? <ErrorState onRetry={() => void rows.refetch()} />
      : rows.data.length === 0 ? <p className="text-sm text-muted-foreground">{text('noMemberships')}</p>
      : <ul className="space-y-1 text-sm">{rows.data.map(row => <li key={row.id} className="rounded-lg bg-muted/50 p-3">
        <span className="font-medium">{text('interval_' + row.interval)}</span> · {text('membershipStatus_' + row.status)}
        <span className="block text-muted-foreground">{text('started', { date: date(row.startsOn) })}
          {['active', 'trial'].includes(row.status) && ` · ${text('nextDue', { date: date(row.nextDueOn) })}`}</span></li>)}</ul>)}
    {open && <p className="text-sm text-muted-foreground">{text('membershipNote')}</p>}
  </div>;
}
const addressFields = ['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'] as const;
const normalizeAddress = (address: PortalHousehold['address']) => Object.fromEntries(addressFields
  .map(field => [field, field === 'countryCode' ? address[field]?.trim().toUpperCase() : address[field]?.trim()])
  .filter(([, value]) => value)) as PortalHousehold['address'];
const normalizedPhone = (phone: PortalHousehold['phone']) => phone?.trim() || null;
const householdContact = ({ name, email, phone, address }: PortalHousehold) => ({ name, email, phone, address });
const normalizeHousehold = (value: ReturnType<typeof householdContact>) => ({
  name: value.name.trim(), email: value.email?.trim() || null, phone: normalizedPhone(value.phone), address: normalizeAddress(value.address),
});
function HouseholdForm({ household, scope, gymName, saved, setSaved, refetch }: {
  household: PortalHousehold; scope: PortalScope; gymName: string; saved: 'saved' | 'unchanged' | null;
  setSaved(value: 'saved' | 'unchanged' | null): void; refetch(): Promise<unknown>;
}) {
  const cache = useQueryClient();
  const draft = useDraft(householdContact(household), normalizeHousehold);
  const phoneChanged = normalizedPhone(draft.values.phone) !== normalizedPhone(household.phone);
  const refreshHousehold = () => cache.invalidateQueries({ queryKey: [...scope.key, 'household'] });
  // The ref guards handlers before React Query publishes the new pending state.
  const actionPending = useRef(false);
  const finishAction = () => { actionPending.current = false; };
  const save = useMutation({ mutationFn: async () => {
    const changes = draft.changes();
    if (!Object.keys(changes).length) return null;
    const { data } = scope.own(await scope.call(contracts.updateHousehold, { ...changes, revision: household.revision }));
    return { changes, data };
  }, onSuccess: async result => {
    if (result) {
      await refreshHousehold();
      const refetched = cache.getQueryState<PortalHousehold>([...scope.key, 'household', 'details']);
      // A failed refetch falls back to the saved household, so retained edits rebase on the new revision once it loads.
      draft.reconcileSaved(result.changes, householdContact(refetched?.status === 'success' && refetched.data ? refetched.data : result.data));
    } else draft.reset();
    setSaved(result ? 'saved' : 'unchanged');
  }, onSettled: finishAction });
  const discard = useMutation({
    mutationFn: refetch,
    onSuccess: () => { draft.reset(); save.reset(); },
    onSettled: finishAction,
  });
  const changeConsent = useMutation({
    mutationFn: async (consent: boolean) => {
      scope.own(await scope.call(contracts.changeHouseholdSmsConsent, { consent, revision: household.revision }));
      await refreshHousehold();
    },
    onSettled: finishAction,
  });
  const busy = save.isPending || discard.isPending || changeConsent.isPending;
  const hasConflict = save.isError && conflict(save.error);
  function startAction() {
    if (busy || actionPending.current) return false;
    actionPending.current = true;
    return true;
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!startAction()) return;
    setSaved(null);
    discard.reset();
    save.mutate();
  }
  return <><Card className="p-4 sm:p-6"><form className="space-y-4" onSubmit={submit} aria-labelledby="household-contact">
    <h2 id="household-contact" className="text-lg font-semibold">{text('contactTitle')}</h2>
    {save.isError && <Alert variant="error" focusOnReveal role="alert">
      <p>{text(hasConflict ? 'contactConflict' : 'failed')}</p>
      {hasConflict && discard.isError && <p>{text('failed')}</p>}
      {hasConflict && <Button type="button" variant="outline" disabled={busy} onClick={() => {
        if (startAction()) discard.mutate();
      }}>{text('discardEdits')}</Button>}
    </Alert>}
    {saved && <Alert role="status">{text(saved)}</Alert>}
    <div className="grid gap-4 sm:grid-cols-2">
      <Field name="name" label={text('householdName')} value={draft.values.name} onChange={event => draft.set('name', event.target.value)} required />
      <Field name="email" label={text('email')} value={draft.values.email ?? ''} onChange={event => draft.set('email', event.target.value)} type="email" autoComplete="email" />
      <Field name="phone" label={text('phone')} value={draft.values.phone ?? ''} onChange={event => draft.set('phone', event.target.value)} type="tel" autoComplete="tel" />
      {addressFields.map(field => <Field key={field} name={field} label={text('address_' + field)} value={draft.values.address[field] ?? ''}
        onChange={event => draft.set('address', { ...draft.values.address, [field]: event.target.value })}
        {...(field === 'countryCode' ? { maxLength: 2, pattern: '[A-Za-z]{2}' } : {})} />)}
    </div>
    <p className="text-sm text-muted-foreground">{text('billingNote')}</p>
    <Button type="submit" disabled={busy}>{text('save')}</Button>
  </form></Card>
    <SmsConsentControls sms={household.sms} gymName={gymName} disabled={busy} {...(phoneChanged ? { grantBlockedHint: text('savePhoneBeforeConsent') } : {})}
      onChange={async (_kind, consent) => {
        if (startAction()) await changeConsent.mutateAsync(consent);
      }}/>
  </>;
}
function Field({ name, label, value, prefix = 'household', ...props }: { name: string; label: string; value: string; prefix?: string }
  & Omit<ComponentProps<typeof Input>, 'name' | 'value' | 'defaultValue' | 'prefix'>) {
  return <div className="min-w-0"><Label htmlFor={`${prefix}-${name}`}>{label}</Label><Input id={`${prefix}-${name}`} name={name} value={value} {...props} /></div>;
}
function EditMember({ member, scope, close }: { member: PortalMember; scope: PortalScope; close: () => void }) {
  const cache = useQueryClient();
  const draft = useDraft({ firstName: member.firstName, lastName: member.lastName, email: member.email,
    phone: member.phone, dateOfBirth: member.dateOfBirth, emergencyContacts: member.emergencyContacts }, value => ({
    firstName: value.firstName.trim(), lastName: value.lastName.trim(), email: value.email?.trim() || null,
    phone: value.phone?.trim() || null, dateOfBirth: value.dateOfBirth || null,
    emergencyContacts: value.emergencyContacts.map(item => ({ name: item.name.trim(), relationship: item.relationship?.trim() || null,
      phone: item.phone.trim(), ...(item.email?.trim() ? { email: item.email.trim() } : {}) })),
  }));
  const { emergencyContacts: contacts } = draft.values;
  const setContacts = (value: PortalEmergencyContact[]) => draft.set('emergencyContacts', value);
  const [changed, setChanged] = useState(false);
  const save = useMutation({ mutationFn: async () => {
    const changes = draft.changes();
    if (!Object.keys(changes).length) return false;
    scope.own(await scope.call(contracts.updateMember, { ...changes, revision: member.revision }, { memberId: member.id }));
    return true;
  }, onSuccess: async changed => { if (changed) await cache.invalidateQueries({ queryKey: [...scope.key, 'household'] }); close(); } });
  const update = (index: number, field: keyof PortalEmergencyContact, value: string) => {
    setChanged(true); setContacts(contacts.map((item, position) => position === index ? { ...item, [field]: value } : item));
  };
  return <Dialog title={text('editTitle', { name: member.firstName })} closeLabel={text('close')} onClose={close} dismissible={!save.isPending} unsavedChanges={changed} size="wide">
    <form className="space-y-4" onChange={() => setChanged(true)} onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      {save.isError && <Alert variant="error" focusOnReveal role="alert">{text(conflict(save.error) ? 'changed' : 'failed')}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field prefix="member" name="firstName" label={text('firstName')} value={draft.values.firstName} onChange={event => draft.set('firstName', event.target.value)} required autoComplete="off" />
        <Field prefix="member" name="lastName" label={text('lastName')} value={draft.values.lastName} onChange={event => draft.set('lastName', event.target.value)} required autoComplete="off" />
        <Field prefix="member" name="email" label={text('email')} value={draft.values.email ?? ''} onChange={event => draft.set('email', event.target.value)} type="email" />
        <Field prefix="member" name="phone" label={text('phone')} value={draft.values.phone ?? ''} onChange={event => draft.set('phone', event.target.value)} type="tel" />
        <Field prefix="member" name="dateOfBirth" label={text('dateOfBirth')} value={draft.values.dateOfBirth ?? ''} onChange={event => draft.set('dateOfBirth', event.target.value)} type="date" />
      </div>
      <fieldset className="space-y-3"><legend className="font-semibold">{text('contacts')}</legend>
        {contacts.map((item, index) => <div key={index} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          {(['name', 'relationship', 'phone', 'email'] as const).map(field => <div key={field} className="min-w-0">
            <Label htmlFor={`contact-${index}-${field}`}>{text('contact_' + field)}</Label>
            <Input id={`contact-${index}-${field}`} type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'} required={field === 'name' || field === 'phone'}
              value={item[field] ?? ''} onChange={event => update(index, field, event.target.value)} />
          </div>)}
          <Button type="button" variant="outline" className="sm:col-span-2 sm:justify-self-start" onClick={() => { setChanged(true); setContacts(contacts.filter((_, position) => position !== index)); }}>{text('removeContact')}</Button>
        </div>)}
        <Button type="button" variant="outline" onClick={() => { setChanged(true); setContacts([...contacts, { name: '', relationship: '', phone: '' }]); }}>{text('addContact')}</Button>
      </fieldset>
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={save.isPending}>{text('save')}</Button>
        <DialogCancel variant="outline" disabled={save.isPending}>{text('close')}</DialogCancel></div>
    </form>
  </Dialog>;
}
