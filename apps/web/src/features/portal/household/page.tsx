// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ComponentProps, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { portalContracts as contracts, type PortalContext, type PortalEmergencyContact, type PortalHousehold, type PortalMember } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Card } from '../../../components/ui/card.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { Badge, StackedItem, StackedList } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { conflict, gymToday, knownMinor, portalCall, portalReady, usePortalContext, usePortalKey } from './api.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/household:' + key, values);
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value + 'T00:00:00Z'));

export function PortalHousehold() {
  const context = usePortalContext();
  if (context.isPending) return <LoadingState />;
  if (context.isError) return <ErrorState onRetry={() => void context.refetch()} />;
  return <PortalHouseholdPage context={context.data} />;
}
export function PortalHouseholdPage({ context }: { context: PortalContext }) {
  const bootstrap = useBootstrap(), base = usePortalKey(), ready = portalReady(base), key = [...base, 'household'], payer = context.role === 'payer';
  const [editing, setEditing] = useState<PortalMember | null>(null), [saved, setSaved] = useState(false);
  const household = useQuery({ queryKey: [...key, 'details'], enabled: ready && payer, queryFn: async () => (await portalCall(contracts.household)).data });
  const members = useQuery({ queryKey: [...key, 'members'], enabled: ready, queryFn: async () => payer
    ? (await portalCall(contracts.members, undefined, {}, { limit: 100, offset: 0 })).data
    : [(await portalCall(contracts.profile, undefined, { memberId: context.memberId! })).data] });
  const timezone = bootstrap.data?.gym.timezone ?? 'UTC', today = gymToday(timezone);
  const editable = (member: PortalMember) => payer && (member.id === context.memberId || knownMinor(member.dateOfBirth, today));
  return <Page className="max-w-3xl">
    <PageHeader title={text(payer ? 'title' : 'profileTitle')} description={text(payer ? 'description' : 'profileDescription')} />
    {payer && (household.isPending ? <LoadingState /> : household.isError ? <ErrorState onRetry={() => void household.refetch()} />
      : <HouseholdForm key={household.data.revision} household={household.data} queryKey={key} saved={saved} setSaved={setSaved} />)}
    <PageSection title={text(payer ? 'members' : 'profile')}>
      {members.isPending && <LoadingState />}
      {members.isError && <ErrorState onRetry={() => void members.refetch()} />}
      {members.data?.length === 0 && <EmptyState title={text('noMembers')} />}
      {!!members.data?.length && <StackedList>{members.data.map(member => <StackedItem key={member.id} className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 break-words">
            <p className="font-semibold">{member.firstName} {member.lastName}{member.id === context.memberId && <span className="font-normal text-muted-foreground"> · {text('you')}</span>}</p>
            {member.dateOfBirth && <p className="text-sm text-muted-foreground">{text('born', { date: date(member.dateOfBirth) })}</p>}
            {(member.email || member.phone) && <p className="break-all text-sm">{[member.email, member.phone].filter(Boolean).join(' · ')}</p>}
          </div>
          <Badge tone={member.status === 'active' ? 'success' : 'muted'}>{text('status_' + member.status)}</Badge>
        </div>
        {member.emergencyContacts.length > 0 && <div className="text-sm"><p className="font-medium">{text('contacts')}</p>
          <ul className="space-y-1">{member.emergencyContacts.map((item, index) => <li key={index} className="break-words">{item.name}
            {item.relationship && <span className="text-muted-foreground"> · {item.relationship}</span>} · {item.phone}{item.email && ` · ${item.email}`}</li>)}</ul></div>}
        <Memberships memberId={member.id} queryKey={key} />
        {editable(member) && <div><Button variant="outline" onClick={() => setEditing(member)}>{text('edit')}</Button></div>}
      </StackedItem>)}</StackedList>}
      <p className="text-sm text-muted-foreground">{text(payer ? 'adultNote' : 'memberNote')}</p>
    </PageSection>
    {editing && <EditMember key={editing.id} member={editing} queryKey={key} close={() => setEditing(null)} />}
  </Page>;
}
/** Memberships are shown for reference; the gym makes every membership change. */
function Memberships({ memberId, queryKey }: { memberId: string; queryKey: readonly unknown[] }) {
  const [open, setOpen] = useState(false);
  const rows = useQuery({ queryKey: [...queryKey, 'memberships', memberId], enabled: open,
    queryFn: async () => (await portalCall(contracts.memberships, undefined, { memberId }, { limit: 50, offset: 0 })).data });
  return <div className="space-y-2">
    <Button variant="ghost" className="px-0" aria-expanded={open} onClick={() => setOpen(!open)}>{text(open ? 'hideMemberships' : 'showMemberships')}</Button>
    {open && (rows.isPending ? <LoadingState /> : rows.isError ? <ErrorState onRetry={() => void rows.refetch()} />
      : rows.data.length === 0 ? <p className="text-sm text-muted-foreground">{text('noMemberships')}</p>
      : <ul className="space-y-1 text-sm">{rows.data.map(row => <li key={row.id} className="rounded-lg bg-muted/50 p-3">
        <span className="font-medium">{text('interval_' + row.interval)}</span> · {text('membershipStatus_' + row.status)}
        <span className="block text-muted-foreground">{text('started', { date: date(row.startsOn) })}
          {['active', 'trial'].includes(row.status) && ` · ${text('nextDue', { date: date(row.nextDueOn) })}`}</span></li>)}</ul>)}
    {open && <p className="text-sm text-muted-foreground">{text('membershipNote')}</p>}
  </div>;
}
const addressFields = ['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'] as const;
/** Keyed by revision so a save shows the stored values; the confirmation lives in the parent and survives that remount. */
function HouseholdForm({ household, queryKey, saved, setSaved }: { household: PortalHousehold; queryKey: readonly unknown[]; saved: boolean; setSaved(value: boolean): void }) {
  const cache = useQueryClient();
  const save = useMutation({ mutationFn: async (form: FormData) => {
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const address = Object.fromEntries(addressFields.map(field => [field, field === 'countryCode' ? value(field).toUpperCase() : value(field)]).filter(([, entry]) => entry));
    await portalCall(contracts.updateHousehold, { name: value('name'), email: value('email') || null, phone: value('phone') || null, address, revision: household.revision });
  }, onSuccess: async () => { setSaved(true); await cache.invalidateQueries({ queryKey }); } });
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSaved(false); save.mutate(new FormData(event.currentTarget)); }
  return <Card className="p-4 sm:p-6"><form className="space-y-4" onSubmit={submit} aria-labelledby="household-contact">
    <h2 id="household-contact" className="text-lg font-semibold">{text('contactTitle')}</h2>
    {save.isError && <Alert role="alert">{text(conflict(save.error) ? 'changed' : 'failed')}</Alert>}
    {saved && <Alert role="status">{text('saved')}</Alert>}
    <div className="grid gap-4 sm:grid-cols-2">
      <Field name="name" label={text('householdName')} value={household.name} required />
      <Field name="email" label={text('email')} value={household.email ?? ''} type="email" autoComplete="email" />
      <Field name="phone" label={text('phone')} value={household.phone ?? ''} type="tel" autoComplete="tel" />
      {addressFields.map(field => <Field key={field} name={field} label={text('address_' + field)} value={household.address[field] ?? ''}
        {...(field === 'countryCode' ? { maxLength: 2, pattern: '[A-Za-z]{2}' } : {})} />)}
    </div>
    <p className="text-sm text-muted-foreground">{text('billingNote')}</p>
    <Button type="submit" disabled={save.isPending}>{text('save')}</Button>
  </form></Card>;
}
function Field({ name, label, value, prefix = 'household', ...props }: { name: string; label: string; value: string; prefix?: string }
  & Omit<ComponentProps<typeof Input>, 'name' | 'value' | 'defaultValue' | 'prefix'>) {
  return <div className="min-w-0"><Label htmlFor={`${prefix}-${name}`}>{label}</Label><Input id={`${prefix}-${name}`} name={name} defaultValue={value} {...props} /></div>;
}
function EditMember({ member, queryKey, close }: { member: PortalMember; queryKey: readonly unknown[]; close: () => void }) {
  const cache = useQueryClient();
  const [contacts, setContacts] = useState<PortalEmergencyContact[]>(member.emergencyContacts), [changed, setChanged] = useState(false);
  const save = useMutation({ mutationFn: async (form: FormData) => {
    const value = (name: string) => String(form.get(name) ?? '').trim();
    await portalCall(contracts.updateMember, { firstName: value('firstName'), lastName: value('lastName'), email: value('email') || null, phone: value('phone') || null,
      dateOfBirth: value('dateOfBirth') || null, revision: member.revision,
      emergencyContacts: contacts.map(item => ({ name: item.name.trim(), relationship: item.relationship?.trim() || null, phone: item.phone.trim(),
        ...(item.email?.trim() ? { email: item.email.trim() } : {}) })) }, { memberId: member.id });
  }, onSuccess: async () => { await cache.invalidateQueries({ queryKey }); close(); } });
  const update = (index: number, field: keyof PortalEmergencyContact, value: string) => {
    setChanged(true); setContacts(contacts.map((item, position) => position === index ? { ...item, [field]: value } : item));
  };
  return <Dialog title={text('editTitle', { name: member.firstName })} closeLabel={text('close')} onClose={close} dismissible={!save.isPending} unsavedChanges={changed} size="wide">
    <form className="space-y-4" onChange={() => setChanged(true)} onSubmit={event => { event.preventDefault(); save.mutate(new FormData(event.currentTarget)); }}>
      {save.isError && <Alert role="alert">{text(conflict(save.error) ? 'changed' : 'failed')}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field prefix="member" name="firstName" label={text('firstName')} value={member.firstName} required autoComplete="off" />
        <Field prefix="member" name="lastName" label={text('lastName')} value={member.lastName} required autoComplete="off" />
        <Field prefix="member" name="email" label={text('email')} value={member.email ?? ''} type="email" />
        <Field prefix="member" name="phone" label={text('phone')} value={member.phone ?? ''} type="tel" />
        <Field prefix="member" name="dateOfBirth" label={text('dateOfBirth')} value={member.dateOfBirth ?? ''} type="date" />
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
        <Button type="button" variant="outline" disabled={save.isPending} onClick={close}>{text('close')}</Button></div>
    </form>
  </Dialog>;
}
