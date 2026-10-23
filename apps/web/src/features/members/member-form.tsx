// SPDX-License-Identifier: AGPL-3.0-only
import type { FormEvent } from 'react';
import * as c from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { memberRequest } from './api.js';
import { ErrorMessage, Field, selectClass, text, useDraft, useMemberSave } from './common.js';

export function MemberForm({ member, householdId, onSaved }: { member?: c.Member; householdId: string; onSaved?: (member: c.Member) => void }) {
  const draft = useDraft({ firstName: member?.firstName ?? '', lastName: member?.lastName ?? '', email: member?.email ?? '',
    phone: member?.phone ?? '', dateOfBirth: member?.dateOfBirth ?? '', status: member?.status ?? ('prospect' as c.MemberStatus),
    emailOptOut: member?.emailOptOut ?? false, emergencyContacts: member?.emergencyContacts ?? ([] as c.EmergencyContact[]) });
  const state = useMemberSave(), { values, set } = draft, contacts = values.emergencyContacts;
  function submit(event: FormEvent) {
    event.preventDefault();
    void state.save(async () => {
      // Empty text inputs clear optional fields.
      const changed = member ? draft.changes() : values;
      if (member && !Object.keys(changed).length) return;
      const { email, phone, dateOfBirth, ...rest } = changed;
      const fields = { ...rest, ...(email === undefined ? {} : { email: email || null }), ...(phone === undefined ? {} : { phone: phone || null }),
        ...(dateOfBirth === undefined ? {} : { dateOfBirth: dateOfBirth || null }) };
      const result = member ? await memberRequest(c.memberResponseSchema, `/api/members/${member.id}`, 'PATCH', c.updateMemberRequestSchema.parse({ ...fields, revision: member.revision }))
        : await memberRequest(c.memberResponseSchema, '/api/members', 'POST', c.createMemberRequestSchema.parse({ ...fields, householdId }));
      onSaved?.(result.data);
    }, draft.reset);
  }
  return <form className="space-y-4" onSubmit={submit}><ErrorMessage error={state.error}/>
    <div className="grid gap-3 sm:grid-cols-2"><Field name="firstName" value={values.firstName} onChange={(value) => set('firstName', value)} required/><Field name="lastName" value={values.lastName} onChange={(value) => set('lastName', value)} required/>
      <Field name="email" type="email" value={values.email} onChange={(value) => set('email', value)}/><Field name="phone" value={values.phone} onChange={(value) => set('phone', value)}/><Field name="dateOfBirth" type="date" value={values.dateOfBirth} onChange={(value) => set('dateOfBirth', value)}/>
      <Label className="grid gap-2">{text('status')}<select className={selectClass} value={values.status} onChange={(event) => set('status', c.memberStatusSchema.parse(event.target.value))}>{c.memberStatusSchema.options.map((value) => <option key={value} value={value}>{text('status.' + value)}</option>)}</select></Label>
    </div><Label className="flex items-center gap-2"><input type="checkbox" checked={values.emailOptOut} onChange={(event) => set('emailOptOut', event.target.checked)}/>{text('emailOptOut')}</Label>
    <fieldset className="space-y-3"><legend className="font-medium">{text('emergencyContacts')}</legend>{contacts.map((contact, index) => {
      const change = (key: keyof c.EmergencyContact, value: string) => set('emergencyContacts', contacts.map((entry, position) => position === index ? { ...entry, [key]: value || (key === 'name' || key === 'phone' ? '' : null) } : entry));
      return <div key={index} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">{(['name', 'relationship', 'phone', 'email'] as const).map((key) => <Field key={key} name={'contact.' + key} value={contact[key] ?? ''} required={key === 'name' || key === 'phone'} type={key === 'email' ? 'email' : 'text'} onChange={(value) => change(key, value)}/>)}<Button type="button" variant="outline" onClick={() => set('emergencyContacts', contacts.filter((_, position) => position !== index))}>{text('removeContact')}</Button></div>;
    })}<Button type="button" variant="outline" onClick={() => set('emergencyContacts', [...contacts, { name: '', phone: '', email: null, relationship: null }])}>{text('addContact')}</Button></fieldset>
    <Button type="submit" disabled={state.busy}>{text(member ? 'save' : 'createMember')}</Button>
  </form>;
}
