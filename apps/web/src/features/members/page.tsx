// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { canStaff } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Autocomplete } from '../../components/ui/autocomplete.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { CheckboxField, Select } from '../../components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states.js';
import { TableContainer } from '../../components/ui/table.js';
import { memberRequest } from './api.js';
import { ErrorMessage, Field, StatusBadge, text, useMemberSave } from './common.js';
import { HouseholdForm, HouseholdsManager } from './households.js';
import { MemberForm } from './member-form.js';

const pageSize = 50;
export function MembersPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={text('loading')}/></Page>;
  if (bootstrap.isError) return <Page><ErrorState message={text('loadFailed')} onRetry={() => void bootstrap.refetch()}/></Page>;
  const session = bootstrap.data.session;
  if (!session || !canStaff(session.roles, 'members.read')) return <Page><Alert>{text('noAccess')}</Alert></Page>;
  return <Roster gymId={bootstrap.data.gym.id} manage={canStaff(session.roles, 'members.manage')}/>;
}
function Roster({ gymId, manage }: { gymId: string; manage: boolean }) {
  const [search, setSearch] = useState(''), [status, setStatus] = useState(''), [tagId, setTag] = useState(''), [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false), [created, setCreated] = useState<c.Member>(), [showHouseholds, setShowHouseholds] = useState(false);
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset), ...(search ? { search } : {}), ...(status ? { status } : {}), ...(tagId ? { tagId } : {}) });
  const roster = useQuery({ queryKey: ['members', gymId, 'roster', params.toString()], queryFn: ({ signal }) => memberRequest(c.memberListResponseSchema, '/api/members?' + params, 'GET', undefined, signal) });
  const tags = useQuery({ queryKey: ['members', gymId, 'tags'], queryFn: ({ signal }) => memberRequest(c.memberTagListResponseSchema, '/api/member-tags?limit=100', 'GET', undefined, signal) });
  const filtered = !!(search || status || tagId), total = roster.data?.pagination.total ?? 0, rows = roster.data?.data ?? [];
  const clear = () => { setSearch(''); setStatus(''); setTag(''); setOffset(0); };
  return <Page>
    <PageHeader title={text('title')} actions={manage && <Button onClick={() => { setCreated(undefined); setCreating(true); }}>{text('addMember')}</Button>}/>
    {created && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{text('created')}{' '}
      <Link to="/admin/members/$memberId" params={{ memberId: created.id }} className="font-medium underline underline-offset-4">{created.firstName} {created.lastName}</Link></p>}
    <div role="search" className="grid gap-3 sm:grid-cols-3" aria-label={text('filters')}>
      <Field name="search" type="search" value={search} onChange={(value) => { setSearch(value); setOffset(0); }}/>
      <Label className="grid gap-2">{text('status')}<Select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
        <option value="">{text('allStatuses')}</option>{c.memberStatusSchema.options.map((value) => <option key={value} value={value}>{text('status.' + value)}</option>)}</Select></Label>
      <Label className="grid gap-2">{text('tags')}<Select value={tagId} onChange={(event) => { setTag(event.target.value); setOffset(0); }}>
        <option value="">{text('allTags')}</option>{tags.data?.data.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</Select></Label>
    </div>
    {roster.isPending ? <LoadingState label={text('loading')}/>
      : roster.isError ? <ErrorState message={text('loadFailed')} onRetry={() => void roster.refetch()}/>
      : rows.length === 0 ? <EmptyState title={text(filtered ? 'empty' : 'noMembers')} description={text(filtered ? 'emptyHelp' : manage ? 'noMembersHelp' : 'noMembersReadOnly')}
        action={filtered ? <Button variant="outline" onClick={clear}>{text('clearFilters')}</Button>
          : manage ? <Button onClick={() => setCreating(true)}>{text('addMember')}</Button> : undefined}/>
      : <div className="space-y-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">{t('members/members:showing', { from: offset + 1, to: offset + rows.length, total })}</p>
        <ul className="divide-y divide-border rounded-xl border border-border md:hidden" aria-label={text('title')}>{rows.map((member) => <li key={member.id}>
          <Link to="/admin/members/$memberId" params={{ memberId: member.id }} className="flex min-h-11 items-center justify-between gap-3 p-4 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0"><span className="block break-words font-medium">{member.firstName} {member.lastName}</span>
              {member.email && <span className="block truncate text-sm text-muted-foreground">{member.email}</span>}</span>
            <StatusBadge status={member.status}/>
          </Link></li>)}</ul>
        <TableContainer label={text('title')} className="hidden md:block"><table className="w-full text-left text-sm">
          <thead className="bg-muted"><tr><th scope="col" className="p-3">{text('name')}</th><th scope="col" className="p-3">{text('status')}</th><th scope="col" className="p-3">{text('email')}</th></tr></thead>
          <tbody>{rows.map((member) => <tr key={member.id} className="border-t border-border">
            <td className="p-1"><Link to="/admin/members/$memberId" params={{ memberId: member.id }} className="flex min-h-11 items-center rounded-md px-2 font-medium underline underline-offset-4 hover:bg-muted">{member.firstName} {member.lastName}</Link></td>
            <td className="p-3"><StatusBadge status={member.status}/></td><td className="break-all p-3">{member.email}</td></tr>)}</tbody>
        </table></TableContainer>
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - pageSize))}>{text('previous')}</Button>
          <Button variant="outline" disabled={offset + pageSize >= total} onClick={() => setOffset(offset + pageSize)}>{text('next')}</Button>
        </div>
      </div>}
    {manage && <TagManager tags={tags.data?.data ?? []}/>}
    {manage && <PageSection title={text('manageHouseholds')} actions={<Button variant="outline" aria-expanded={showHouseholds} aria-controls="households-manager"
      onClick={() => setShowHouseholds(!showHouseholds)}>{text(showHouseholds ? 'hideHouseholds' : 'showHouseholds')}</Button>}>
      <div id="households-manager" hidden={!showHouseholds}>{showHouseholds && <HouseholdsManager gymId={gymId}/>}</div>
    </PageSection>}
    {creating && <Dialog title={text('addMember')} closeLabel={text('closeDialog')} onClose={() => setCreating(false)}>
      <AddMember gymId={gymId} onCreated={(member) => { setCreating(false); setCreated(member); }}/>
    </Dialog>}
  </Page>;
}
/** Choose or create the household first, then the member's details. */
function AddMember({ gymId, onCreated }: { gymId: string; onCreated: (member: c.Member) => void }) {
  const [householdId, setHousehold] = useState(''), [homeSearch, setHomeSearch] = useState('');
  const homes = useQuery({ queryKey: ['members', gymId, 'household-search', homeSearch], queryFn: ({ signal }) => memberRequest(c.householdListResponseSchema,
    '/api/households?limit=100' + (homeSearch ? '&search=' + encodeURIComponent(homeSearch) : ''), 'GET', undefined, signal) });
  return <div className="space-y-6">
    <fieldset className="space-y-3"><legend className="font-semibold">{text('step.household')}</legend>
      <Autocomplete label={text('searchHouseholds')} query={homeSearch} value={householdId} onQueryChange={setHomeSearch} onChange={setHousehold}
        options={(homes.data?.data ?? []).map(home => ({ id: home.id, label: home.name }))} loading={homes.isPending} />
      <ErrorMessage error={homes.error}/>
      <details className="rounded-xl border border-border"><summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">{text('createHousehold')}</summary>
        <div className="border-t border-border p-4"><HouseholdForm onSaved={(home) => { setHomeSearch(home.name); setHousehold(home.id); }}/></div></details>
    </fieldset>
    {householdId ? <fieldset className="space-y-3 border-t border-border pt-6"><legend className="font-semibold">{text('step.member')}</legend>
      <MemberForm householdId={householdId} onSaved={onCreated}/></fieldset>
      : <p className="text-sm text-muted-foreground">{text('chooseHouseholdFirst')}</p>}
  </div>;
}
function TagManager({ tags }: { tags: c.MemberTag[] }) {
  const [name, setName] = useState(''), [color, setColor] = useState('#64748b'), [selected, setSelected] = useState(''), [confirmDelete, setConfirmDelete] = useState(false), state = useMemberSave();
  return <PageSection title={text('manageTags')}><div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
    <form className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void state.save(async () => {
      const existing = tags.find((tag) => tag.id === selected);
      await memberRequest(c.memberTagResponseSchema, existing ? `/api/member-tags/${existing.id}` : '/api/member-tags', existing ? 'PATCH' : 'POST', existing ? c.updateMemberTagRequestSchema.parse({ name, color, revision: existing.revision }) : c.createMemberTagRequestSchema.parse({ name, color }));
    }); }}>
      <Label className="grid gap-2">{text('tag')}<Select value={selected} onChange={(event) => { const tag = tags.find((entry) => entry.id === event.target.value); setSelected(event.target.value); setName(tag?.name ?? ''); setColor(tag?.color ?? '#64748b'); setConfirmDelete(false); }}>
        <option value="">{text('newTag')}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</Select></Label>
      <Field name="tagName" value={name} onChange={setName} required/>
      <Label className="grid gap-2">{text('color')}<Input type="color" value={color} onChange={(event) => setColor(event.target.value)} className="p-1"/></Label>
      <Button type="submit" disabled={state.busy}>{text(selected ? 'save' : 'createTag')}</Button>
    </form>
    {selected && <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
      <CheckboxField label={text('confirmDeleteTag')} checked={confirmDelete} onChange={(event) => setConfirmDelete(event.target.checked)}/>
      <Button variant="outline" className="border-destructive text-destructive" disabled={!confirmDelete || state.busy} onClick={() => void state.save(async () => {
        const tag = tags.find((entry) => entry.id === selected); if (!tag) return;
        await memberRequest(c.membersContracts.deleteTag.response, `/api/member-tags/${tag.id}`, 'DELETE', { revision: tag.revision });
      }, () => { setSelected(''); setName(''); setConfirmDelete(false); })}>{text('deleteTag')}</Button>
    </div>}
    <ErrorMessage error={state.error}/>
  </div></PageSection>;
}
