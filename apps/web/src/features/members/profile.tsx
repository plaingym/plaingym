// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { canStaff, type StaffRole } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { createRegistries } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { memberRequest, resizeMemberPhoto } from './api.js';
import { ErrorMessage, Panel, selectClass, text, useDraft, useMemberSave } from './common.js';
import { MemberForm } from './member-form.js';
import { HouseholdDetails } from './households.js';

export function MemberTabs({ memberId, roles, enabledModules, registries = createRegistries() }: { memberId: string; roles: readonly StaffRole[]; enabledModules: ReadonlySet<string>; registries?: ReturnType<typeof createRegistries> }) {
  const entries = registries.memberTabs.forModules(enabledModules).filter((entry) => entry.enabled && entry.permission.kind === 'staff' && canStaff(roles, entry.permission.capability));
  const [activeId, setActive] = useState<string>();
  const active = entries.some((entry) => entry.id === activeId) ? activeId : entries[0]?.id;
  return <div className="space-y-4"><div role="tablist" aria-label={text('profileTabs')} className="flex flex-wrap gap-2">{entries.map((entry) => <Button type="button" key={entry.id} role="tab" id={'tab-' + entry.id} aria-controls={'panel-' + entry.id} aria-selected={active === entry.id} variant={active === entry.id ? 'default' : 'outline'} onClick={() => setActive(entry.id)}>{t(entry.labelKey)}</Button>)}</div>
    {entries.map((entry) => { const Component = entry.component; return <section role="tabpanel" id={'panel-' + entry.id} aria-labelledby={'tab-' + entry.id} hidden={active !== entry.id} key={entry.id}><Component memberId={memberId}/></section>; })}</div>;
}
export function MemberProfile({ memberId }: { memberId: string }) {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{text('loading')}</p>;
  if (bootstrap.isError) return <ErrorMessage error={bootstrap.error}/>;
  if (!bootstrap.data.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return <p>{text('noAccess')}</p>;
  // Keyed by member, so switching profiles never carries one member's drafts to another.
  return <Profile key={memberId} memberId={memberId} gymId={bootstrap.data.gym.id} roles={bootstrap.data.session.roles} enabledModules={new Set(bootstrap.data.gym.enabledModules)}/>;
}
function Profile({ memberId, gymId, roles, enabledModules }: { memberId: string; gymId: string; roles: readonly StaffRole[]; enabledModules: ReadonlySet<string> }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['members', gymId, memberId], queryFn: ({ signal }) => memberRequest(c.memberResponseSchema, `/api/members/${memberId}`, 'GET', undefined, signal) });
  const member = query.data?.data, manage = canStaff(roles, 'members.manage');
  return <main className="mx-auto max-w-6xl space-y-6 p-6"><div className="flex items-center justify-between gap-4"><Link to="/admin/members" className="underline">{text('title')}</Link><Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: ['members', gymId] })}>{text('refresh')}</Button></div>
    <ErrorMessage error={query.error}/>{query.isPending && <p role="status">{text('loading')}</p>}{member && <>
      <h1 className="text-2xl font-semibold">{member.firstName} {member.lastName}</h1>
      {member.anonymizedAt ? <p>{text('anonymized')}</p> : <div className="grid items-start gap-6 lg:grid-cols-2"><div className="space-y-6">
        <Panel title="profile">{manage ? <MemberForm member={member} householdId={member.householdId}/> : <dl className="space-y-2">{(['status', 'email', 'phone', 'dateOfBirth'] as const).map((field) => <div key={field}><dt className="text-muted-foreground">{text(field)}</dt><dd>{field === 'status' ? text('status.' + member.status) : member[field]}</dd></div>)}</dl>}
          {!manage && <><h3>{text('emergencyContacts')}</h3>{member.emergencyContacts.map((contact, index) => <p key={index}>{contact.name} {contact.relationship} {contact.phone} {contact.email}</p>)}</>}
        </Panel><Photo member={member} manage={manage}/><MemberTags gymId={gymId} memberId={memberId} manage={canStaff(roles, 'tags.manage')}/>
      </div><div className="space-y-6">{manage && <HouseholdDetails key={member.householdId} gymId={gymId} householdId={member.householdId}/>}
        {canStaff(roles, 'medical.read') && <MedicalNotes gymId={gymId} memberId={memberId} manage={manage}/>}
        {canStaff(roles, 'members.anonymize') && <Anonymize member={member}/>}
      </div></div>}
      <MemberTabs memberId={memberId} roles={roles} enabledModules={enabledModules}/>
    </>}</main>;
}
function Photo({ member, manage }: { member: c.Member; manage: boolean }) {
  const state = useMemberSave();
  return <Panel title="photo">{member.photoKey && <img className="h-40 w-40 rounded-lg object-cover" src={`/api/members/${member.id}/photo?revision=${member.revision}`} alt={text('photo')}/>}
    {manage && <><Label className="grid gap-2">{text('uploadPhoto')}<Input type="file" accept="image/jpeg,image/png,image/webp" disabled={state.busy} onChange={(event) => {
      const file = event.target.files?.[0]; if (file) void state.save(async () => memberRequest(c.memberResponseSchema, `/api/members/${member.id}/photo`, 'POST', { revision: member.revision, contentType: 'image/jpeg', base64: await resizeMemberPhoto(file) }));
      event.target.value = '';
    }}/></Label>{member.photoKey && <Button variant="outline" disabled={state.busy} onClick={() => void state.save(() => memberRequest(c.memberResponseSchema, `/api/members/${member.id}`, 'PATCH', { revision: member.revision, photoKey: null }))}>{text('removePhoto')}</Button>}</>}
    <ErrorMessage error={state.error}/>
  </Panel>;
}
function MedicalNotes({ gymId, memberId, manage }: { gymId: string; memberId: string; manage: boolean }) {
  const query = useQuery({ queryKey: ['members', gymId, memberId, 'medical'], queryFn: ({ signal }) => memberRequest(c.memberMedicalNotesResponseSchema, `/api/members/${memberId}/medical-notes`, 'GET', undefined, signal) });
  return <Panel title="medicalNotes"><ErrorMessage error={query.error}/>{query.data && <MedicalForm notes={query.data.data} manage={manage}/>}</Panel>;
}
function MedicalForm({ notes, manage }: { notes: c.MemberMedicalNotes; manage: boolean }) {
  const draft = useDraft({ medicalNotes: notes.medicalNotes ?? '' }), state = useMemberSave(), value = draft.values.medicalNotes;
  return manage ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void state.save(async () => {
    const { medicalNotes } = draft.changes();
    if (medicalNotes === undefined) return;
    await memberRequest(c.memberMedicalNotesResponseSchema, `/api/members/${notes.id}/medical-notes`, 'PATCH', c.updateMemberMedicalNotesRequestSchema.parse({ revision: notes.revision, medicalNotes: medicalNotes || null }));
  }, draft.reset); }}>
    <Label className="grid gap-2">{text('medicalNotes')}<textarea className="min-h-32 rounded-md border bg-background p-3" value={value} onChange={(event) => draft.set('medicalNotes', event.target.value)}/></Label><Button type="submit" disabled={state.busy}>{text('save')}</Button><ErrorMessage error={state.error}/></form> : <p className="whitespace-pre-wrap">{value}</p>;
}
function MemberTags({ gymId, memberId, manage }: { gymId: string; memberId: string; manage: boolean }) {
  const assigned = useQuery({ queryKey: ['members', gymId, memberId, 'tags'], queryFn: ({ signal }) => memberRequest(c.memberAssignedTagsResponseSchema, `/api/members/${memberId}/tags`, 'GET', undefined, signal) });
  const available = useQuery({ queryKey: ['members', gymId, 'tags'], enabled: manage, queryFn: ({ signal }) => memberRequest(c.memberTagListResponseSchema, '/api/member-tags?limit=100', 'GET', undefined, signal) });
  const state = useMemberSave(), [tagId, setTag] = useState('');
  return <Panel title="tags"><ErrorMessage error={assigned.error || state.error}/><ul className="flex flex-wrap gap-2">{assigned.data?.data.map((tag) => <li key={tag.id} className="flex items-center gap-2 rounded-md border px-3 py-2">{tag.name}{manage && <Button variant="outline" disabled={state.busy} onClick={() => void state.save(() => memberRequest(c.membersContracts.removeTag.response, `/api/members/${memberId}/tags/${tag.id}`, 'DELETE'))}>{text('remove')}</Button>}</li>)}</ul>
    {manage && <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void state.save(() => memberRequest(c.memberTagLinkResponseSchema, `/api/members/${memberId}/tags`, 'POST', c.addMemberTagRequestSchema.parse({ tagId }))); }}><Label className="grid gap-2">{text('tags')}<select className={selectClass} value={tagId} onChange={(event) => setTag(event.target.value)} required><option value="">{text('chooseTag')}</option>{available.data?.data.filter((tag) => !assigned.data?.data.some((entry) => entry.id === tag.id)).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></Label><Button type="submit" className="self-end" disabled={state.busy || !tagId}>{text('addTag')}</Button></form>}
  </Panel>;
}
function Anonymize({ member }: { member: c.Member }) {
  const [confirmed, setConfirmed] = useState(false), state = useMemberSave();
  return <Panel title="anonymize"><p>{text('anonymizeWarning')}</p><Label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/>{text('confirmAnonymize')}</Label><Button variant="outline" className="border-destructive text-destructive" disabled={!confirmed || state.busy} onClick={() => void state.save(() => memberRequest(c.memberResponseSchema, `/api/members/${member.id}/anonymize`, 'POST', { revision: member.revision }))}>{text('anonymize')}</Button><ErrorMessage error={state.error}/></Panel>;
}
