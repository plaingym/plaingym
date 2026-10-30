// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { canStaff, type StaffRole } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { createRegistries } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { cn } from '../../lib/utils.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { CheckboxField, Select, Textarea } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { memberRequest, resizeMemberPhoto } from './api.js';
import { ErrorMessage, Panel, StatusBadge, text, useDraft, useMemberSave } from './common.js';
import { MemberForm } from './member-form.js';
import { HouseholdDetails } from './households.js';

export function MemberTabs({ memberId, roles, enabledModules, registries = createRegistries() }: { memberId: string; roles: readonly StaffRole[]; enabledModules: ReadonlySet<string>; registries?: ReturnType<typeof createRegistries> }) {
  const entries = registries.memberTabs.forModules(enabledModules).filter((entry) => entry.enabled && entry.permission.kind === 'staff' && canStaff(roles, entry.permission.capability));
  // A link may name the tab to open (`#memberTabs.portal-access`), such as the dashboard's confirmation shortlist.
  const [activeId, setActive] = useState<string | undefined>(() => {
    try { return decodeURIComponent(window.location.hash.slice(1)) || undefined; } catch { return undefined; }
  });
  const active = entries.some((entry) => entry.id === activeId) ? activeId : entries[0]?.id;
  if (!entries.length) return null;
  return <div className="space-y-4"><div role="tablist" aria-label={text('profileTabs')} className="flex flex-wrap gap-2 border-b border-border pb-3">{entries.map((entry) => <Button type="button" key={entry.id} role="tab" id={'tab-' + entry.id} aria-controls={'panel-' + entry.id} aria-selected={active === entry.id} variant={active === entry.id ? 'default' : 'outline'} onClick={() => setActive(entry.id)}>{t(entry.labelKey)}</Button>)}</div>
    {entries.map((entry) => { const Component = entry.component; return <section role="tabpanel" id={'panel-' + entry.id} aria-labelledby={'tab-' + entry.id} hidden={active !== entry.id} key={entry.id} className="min-w-0"><Component memberId={memberId}/></section>; })}</div>;
}
export function MemberProfile({ memberId }: { memberId: string }) {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={text('loading')}/></Page>;
  if (bootstrap.isError) return <Page><ErrorState message={text('loadFailed')} onRetry={() => void bootstrap.refetch()}/></Page>;
  if (!bootstrap.data.session || !canStaff(bootstrap.data.session.roles, 'members.read')) return <Page><Alert>{text('noAccess')}</Alert></Page>;
  // Keyed by member, so switching profiles never carries one member's drafts to another.
  return <Profile key={memberId} memberId={memberId} gymId={bootstrap.data.gym.id} roles={bootstrap.data.session.roles} enabledModules={new Set(bootstrap.data.gym.enabledModules)}/>;
}
function Profile({ memberId, gymId, roles, enabledModules }: { memberId: string; gymId: string; roles: readonly StaffRole[]; enabledModules: ReadonlySet<string> }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['members', gymId, memberId], queryFn: ({ signal }) => memberRequest(c.memberResponseSchema, `/api/members/${memberId}`, 'GET', undefined, signal) });
  const member = query.data?.data, manage = canStaff(roles, 'members.manage');
  return <Page>
    <Link to="/admin/members" className="-my-2 inline-flex min-h-11 items-center gap-1 text-sm font-medium underline underline-offset-4"><span aria-hidden="true">‹</span>{text('backToMembers')}</Link>
    {query.isPending ? <LoadingState label={text('loading')}/> : query.isError ? <ErrorState message={text('loadFailed')} onRetry={() => void query.refetch()}/> : member && <>
      <PageHeader title={`${member.firstName} ${member.lastName}`} description={member.anonymizedAt ? undefined : <StatusBadge status={member.status}/>}
        actions={<Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: ['members', gymId] })}>{text('refresh')}</Button>}/>
      {member.anonymizedAt ? <Alert>{text('anonymized')}</Alert> : <div className="grid items-start gap-6 lg:grid-cols-2"><div className="min-w-0 space-y-6">
        <Panel title="profile">{manage ? <MemberForm member={member} householdId={member.householdId}/> : <>
          <dl className="grid gap-3 sm:grid-cols-2">{(['status', 'email', 'phone', 'dateOfBirth'] as const).map((field) => <div key={field} className="min-w-0"><dt className="text-sm text-muted-foreground">{text(field)}</dt>
            <dd className="break-words">{field === 'status' ? text('status.' + member.status) : member[field] || '—'}</dd></div>)}</dl>
          <h3 className="font-medium">{text('emergencyContacts')}</h3>
          {member.emergencyContacts.length ? <ul className="space-y-2">{member.emergencyContacts.map((contact, index) => <li key={index} className="rounded-lg border border-border p-3">
            <p className="font-medium">{contact.name}{contact.relationship && <span className="font-normal text-muted-foreground"> · {contact.relationship}</span>}</p>
            <p className="break-words text-sm">{contact.phone}{contact.email && ' · ' + contact.email}</p></li>)}</ul>
            : <p className="text-sm text-muted-foreground">{text('noContacts')}</p>}
        </>}</Panel>
        <Photo member={member} manage={manage}/><MemberTags gymId={gymId} memberId={memberId} manage={canStaff(roles, 'tags.manage')}/>
      </div><div className="min-w-0 space-y-6">{manage && <HouseholdDetails key={member.householdId} gymId={gymId} householdId={member.householdId}/>}
        {canStaff(roles, 'medical.read') && <MedicalNotes gymId={gymId} memberId={memberId} manage={manage}/>}
        {canStaff(roles, 'members.anonymize') && <Anonymize member={member}/>}
      </div></div>}
      <MemberTabs memberId={memberId} roles={roles} enabledModules={enabledModules}/>
    </>}
  </Page>;
}
function Photo({ member, manage }: { member: c.Member; manage: boolean }) {
  const state = useMemberSave();
  return <Panel title="photo">{member.photoKey ? <img className="size-40 rounded-lg object-cover" src={`/api/members/${member.id}/photo?revision=${member.revision}`} alt={text('photo')}/>
    : <p className="text-sm text-muted-foreground">{text('noPhoto')}</p>}
    {manage && <div className="space-y-3"><Label className="grid gap-2">{text('uploadPhoto')}<Input type="file" accept="image/jpeg,image/png,image/webp" className="py-2" disabled={state.busy} onChange={(event) => {
      const file = event.target.files?.[0]; if (file) void state.save(async () => memberRequest(c.memberResponseSchema, `/api/members/${member.id}/photo`, 'POST', { revision: member.revision, contentType: 'image/jpeg', base64: await resizeMemberPhoto(file) }));
      event.target.value = '';
    }}/></Label>{member.photoKey && <Button variant="outline" disabled={state.busy} onClick={() => void state.save(() => memberRequest(c.memberResponseSchema, `/api/members/${member.id}`, 'PATCH', { revision: member.revision, photoKey: null }))}>{text('removePhoto')}</Button>}</div>}
    <ErrorMessage error={state.error}/>
  </Panel>;
}
function MedicalNotes({ gymId, memberId, manage }: { gymId: string; memberId: string; manage: boolean }) {
  const query = useQuery({ queryKey: ['members', gymId, memberId, 'medical'], queryFn: ({ signal }) => memberRequest(c.memberMedicalNotesResponseSchema, `/api/members/${memberId}/medical-notes`, 'GET', undefined, signal) });
  return <Panel title="medicalNotes"><ErrorMessage error={query.error}/>{query.isPending && <LoadingState label={text('loading')}/>}{query.data && <MedicalForm notes={query.data.data} manage={manage}/>}</Panel>;
}
function MedicalForm({ notes, manage }: { notes: c.MemberMedicalNotes; manage: boolean }) {
  const draft = useDraft({ medicalNotes: notes.medicalNotes ?? '' }), state = useMemberSave(), value = draft.values.medicalNotes;
  if (!manage) return value ? <p className="whitespace-pre-wrap break-words">{value}</p> : <p className="text-sm text-muted-foreground">{text('noMedicalNotes')}</p>;
  return <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void state.save(async () => {
    const { medicalNotes } = draft.changes();
    if (medicalNotes === undefined) return;
    await memberRequest(c.memberMedicalNotesResponseSchema, `/api/members/${notes.id}/medical-notes`, 'PATCH', c.updateMemberMedicalNotesRequestSchema.parse({ revision: notes.revision, medicalNotes: medicalNotes || null }));
  }, draft.reset); }}>
    <Label className="grid gap-2">{text('medicalNotes')}<Textarea className="min-h-32" value={value} onChange={(event) => draft.set('medicalNotes', event.target.value)}/></Label>
    <Button type="submit" className="w-full sm:w-auto" disabled={state.busy}>{text('save')}</Button><ErrorMessage error={state.error}/></form>;
}
function MemberTags({ gymId, memberId, manage }: { gymId: string; memberId: string; manage: boolean }) {
  const assigned = useQuery({ queryKey: ['members', gymId, memberId, 'tags'], queryFn: ({ signal }) => memberRequest(c.memberAssignedTagsResponseSchema, `/api/members/${memberId}/tags`, 'GET', undefined, signal) });
  const available = useQuery({ queryKey: ['members', gymId, 'tags'], enabled: manage, queryFn: ({ signal }) => memberRequest(c.memberTagListResponseSchema, '/api/member-tags?limit=100', 'GET', undefined, signal) });
  const state = useMemberSave(), [tagId, setTag] = useState('');
  const choices = available.data?.data.filter((tag) => !assigned.data?.data.some((entry) => entry.id === tag.id)) ?? [];
  return <Panel title="tags"><ErrorMessage error={assigned.error || state.error}/>
    {assigned.data?.data.length === 0 && <p className="text-sm text-muted-foreground">{text('noTags')}</p>}
    <ul className="flex flex-wrap gap-2">{assigned.data?.data.map((tag) => <li key={tag.id} className={cn('flex min-h-11 items-center gap-2 rounded-full border border-border pl-3', !manage && 'pr-3')}>
      <span aria-hidden="true" className="size-3 rounded-full border border-border" style={{ backgroundColor: tag.color ?? undefined }}/>{tag.name}
      {manage && <Button variant="ghost" size="icon" className="rounded-full" aria-label={text('removeTag') + ' ' + tag.name} disabled={state.busy}
        onClick={() => void state.save(() => memberRequest(c.membersContracts.removeTag.response, `/api/members/${memberId}/tags/${tag.id}`, 'DELETE'))}><span aria-hidden="true">×</span></Button>}</li>)}</ul>
    {manage && <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void state.save(() => memberRequest(c.memberTagLinkResponseSchema, `/api/members/${memberId}/tags`, 'POST', c.addMemberTagRequestSchema.parse({ tagId })), () => setTag('')); }}>
      <Label className="grid flex-1 gap-2">{text('tags')}<Select value={tagId} onChange={(event) => setTag(event.target.value)} required><option value="">{text('chooseTag')}</option>{choices.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</Select></Label>
      <Button type="submit" disabled={state.busy || !tagId}>{text('addTag')}</Button></form>}
  </Panel>;
}
function Anonymize({ member }: { member: c.Member }) {
  const [confirmed, setConfirmed] = useState(false), state = useMemberSave();
  return <Panel title="anonymize"><p className="text-sm">{text('anonymizeWarning')}</p><CheckboxField label={text('confirmAnonymize')} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/>
    <Button variant="outline" className="w-full border-destructive text-destructive sm:w-auto" disabled={!confirmed || state.busy} onClick={() => void state.save(() => memberRequest(c.memberResponseSchema, `/api/members/${member.id}/anonymize`, 'POST', { revision: member.revision }))}>{text('anonymize')}</Button><ErrorMessage error={state.error}/></Panel>;
}
