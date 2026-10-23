// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { canStaff } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { memberRequest } from './api.js';
import { ErrorMessage, Field, Panel, selectClass, text, useMemberSave } from './common.js';
import { HouseholdForm, HouseholdsManager } from './households.js';
import { MemberForm } from './member-form.js';

export function MembersPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{text('loading')}</p>;
  if (bootstrap.isError) return <ErrorMessage error={bootstrap.error}/>;
  const session = bootstrap.data.session;
  if (!session || !canStaff(session.roles, 'members.read')) return <p>{text('noAccess')}</p>;
  return <Roster gymId={bootstrap.data.gym.id} manage={canStaff(session.roles, 'members.manage')}/>;
}
function Roster({ gymId, manage }: { gymId: string; manage: boolean }) {
  const [search, setSearch] = useState(''), [status, setStatus] = useState(''), [tagId, setTag] = useState(''), [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false), [householdId, setHousehold] = useState(''), [showHouseholds, setShowHouseholds] = useState(false);
  const params = new URLSearchParams({ limit: '50', offset: String(offset), ...(search ? { search } : {}), ...(status ? { status } : {}), ...(tagId ? { tagId } : {}) });
  const roster = useQuery({ queryKey: ['members', gymId, 'roster', params.toString()], queryFn: ({ signal }) => memberRequest(c.memberListResponseSchema, '/api/members?' + params, 'GET', undefined, signal) });
  const tags = useQuery({ queryKey: ['members', gymId, 'tags'], queryFn: ({ signal }) => memberRequest(c.memberTagListResponseSchema, '/api/member-tags?limit=100', 'GET', undefined, signal) });
  const households = useQuery({ queryKey: ['members', gymId, 'households'], enabled: manage, queryFn: ({ signal }) => memberRequest(c.householdListResponseSchema, '/api/households?limit=100', 'GET', undefined, signal) });
  const [homeSearch, setHomeSearch] = useState('');
  const homes = useQuery({ queryKey: ['members', gymId, 'household-search', homeSearch], enabled: manage && creating && !!homeSearch, queryFn: ({ signal }) => memberRequest(c.householdListResponseSchema, '/api/households?limit=100&search=' + encodeURIComponent(homeSearch), 'GET', undefined, signal) });
  return <main className="mx-auto max-w-6xl space-y-6 p-6">
    <div className="flex items-center justify-between gap-3"><h1 className="text-2xl font-semibold">{text('title')}</h1>{manage && <Button onClick={() => setCreating(!creating)}>{text(creating ? 'close' : 'addMember')}</Button>}</div>
    {creating && <Panel title="addMember"><div className="grid gap-6 lg:grid-cols-2"><div className="space-y-4">
      <Field name="searchHouseholds" value={homeSearch} onChange={setHomeSearch}/>
      <Label className="grid gap-2">{text('household')}<select className={selectClass} value={householdId} onChange={(event) => setHousehold(event.target.value)}><option value="">{text('chooseHousehold')}</option>{(homeSearch ? homes.data?.data : households.data?.data)?.map((home) => <option key={home.id} value={home.id}>{home.name}</option>)}</select></Label>
      <details><summary className="cursor-pointer">{text('createHousehold')}</summary><HouseholdForm onSaved={(home) => setHousehold(home.id)}/></details>
    </div>{householdId && <MemberForm householdId={householdId} onSaved={() => setCreating(false)}/>}</div></Panel>}
    <div className="grid gap-3 sm:grid-cols-3"><Field name="search" value={search} onChange={(value) => { setSearch(value); setOffset(0); }}/>
      <Label className="grid gap-2">{text('status')}<select className={selectClass} value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="">{text('allStatuses')}</option>{c.memberStatusSchema.options.map((value) => <option key={value} value={value}>{text('status.' + value)}</option>)}</select></Label>
      <Label className="grid gap-2">{text('tags')}<select className={selectClass} value={tagId} onChange={(event) => { setTag(event.target.value); setOffset(0); }}><option value="">{text('allTags')}</option>{tags.data?.data.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></Label></div>
    <ErrorMessage error={roster.error}/>{roster.isPending && <p role="status">{text('loading')}</p>}
    <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="bg-muted"><tr><th className="p-3">{text('name')}</th><th className="p-3">{text('status')}</th><th className="p-3">{text('email')}</th></tr></thead><tbody>{roster.data?.data.map((member) => <tr key={member.id} className="border-t"><td className="p-3"><Link to="/admin/members/$memberId" params={{ memberId: member.id }} className="font-medium underline">{member.firstName} {member.lastName}</Link></td><td className="p-3">{text('status.' + member.status)}</td><td className="p-3">{member.email}</td></tr>)}</tbody></table></div>
    {roster.data?.data.length === 0 && <p>{text('empty')}</p>}
    <div className="flex items-center gap-3"><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>{text('previous')}</Button><span>{roster.data?.pagination.total ?? 0} {text('total')}</span><Button variant="outline" disabled={!roster.data || offset + 50 >= roster.data.pagination.total} onClick={() => setOffset(offset + 50)}>{text('next')}</Button></div>
    {manage && <TagManager tags={tags.data?.data ?? []}/>}
    {manage && <><Button variant="outline" onClick={() => setShowHouseholds(!showHouseholds)}>{text('manageHouseholds')}</Button>{showHouseholds && <HouseholdsManager gymId={gymId}/>}</>}
  </main>;
}
function TagManager({ tags }: { tags: c.MemberTag[] }) {
  const [name, setName] = useState(''), [color, setColor] = useState('#64748b'), [selected, setSelected] = useState(''), [confirmDelete, setConfirmDelete] = useState(false), state = useMemberSave();
  return <Panel title="manageTags"><form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void state.save(async () => {
    const existing = tags.find((tag) => tag.id === selected);
    await memberRequest(c.memberTagResponseSchema, existing ? `/api/member-tags/${existing.id}` : '/api/member-tags', existing ? 'PATCH' : 'POST', existing ? c.updateMemberTagRequestSchema.parse({ name, color, revision: existing.revision }) : c.createMemberTagRequestSchema.parse({ name, color }));
  }); }}><Label className="grid gap-2">{text('tags')}<select className={selectClass} value={selected} onChange={(event) => { const tag = tags.find((entry) => entry.id === event.target.value); setSelected(event.target.value); setName(tag?.name ?? ''); setColor(tag?.color ?? '#64748b'); }}><option value="">{text('newTag')}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></Label>
    <Field name="tagName" value={name} onChange={setName} required/><Field name="color" type="color" value={color} onChange={setColor}/><Button type="submit" disabled={state.busy}>{text('save')}</Button></form>
    {selected && <div className="flex flex-wrap items-center gap-3"><Label className="flex gap-2"><input type="checkbox" checked={confirmDelete} onChange={(event) => setConfirmDelete(event.target.checked)}/>{text('confirmDeleteTag')}</Label><Button variant="outline" disabled={!confirmDelete || state.busy} onClick={() => void state.save(async () => {
      const tag = tags.find((tag) => tag.id === selected); if (!tag) return;
      await memberRequest(c.membersContracts.deleteTag.response, `/api/member-tags/${tag.id}`, 'DELETE', { revision: tag.revision });
    }, () => { setSelected(''); setName(''); setConfirmDelete(false); })}>{text('deleteTag')}</Button></div>}<ErrorMessage error={state.error}/></Panel>;
}
