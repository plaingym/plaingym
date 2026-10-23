// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import type { StaffProfile, StaffRoleRecord, StaffProfileListResponse, AssignableStaffRole } from '@plaingym/shared/contracts';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { createStaffClient, StaffRequestError, type StaffClient } from './client.js';
import { resizeStaffPhoto } from './photo.js';
const client = createStaffClient();
const label = (key: string) => t('staff/profiles:' + key);
const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
function RoleSelect({ initial = 'coach' }: { initial?: AssignableStaffRole }) {
  return <label className="block">{label('role')}<select className="block h-11 w-full rounded-md border px-3" name="role" defaultValue={initial}>
    {(['admin', 'coach', 'front_desk'] as const).map((role) => <option key={role} value={role}>{label(role)}</option>)}
  </select></label>;
}
export function canResetStaffPassword(actorRoles: readonly StaffRole[], target: StaffRole) {
  return target !== 'owner' && (actorRoles.includes('owner') || (actorRoles.includes('admin') && ['coach', 'front_desk'].includes(target)));
}
export function StaffManagement({ roles: actorRoles, passwordEnabled, services = client }: { roles: readonly StaffRole[]; passwordEnabled: boolean; services?: StaffClient }) {
  const [profiles, setProfiles] = useState<StaffProfileListResponse | null>(null), [roles, setRoles] = useState<StaffRoleRecord[]>([]);
  const [totalRoles, setTotalRoles] = useState(0), [offset, setOffset] = useState(0), [roleOffset, setRoleOffset] = useState(0), [search, setSearch] = useState('');
  const [editing, setEditing] = useState<StaffProfile | null>(null), [creating, setCreating] = useState(false);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [invitationUrl, setInvitationUrl] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const allowed = canStaff(actorRoles, 'staff.manage');
  function error(e: unknown) { setMessage(label((e instanceof StaffRequestError || e instanceof ApiError) && e.status === 409 ? 'conflict' : 'error')); }
  async function load() {
    const [p, r] = await Promise.all([services.profiles(offset, search), services.roles(roleOffset)]);
    setProfiles(p); setRoles(r.data); setTotalRoles(r.pagination.total);
  }
  useEffect(() => {
    if (!allowed) return;
    let active = true; setBusy(true);
    void Promise.all([services.profiles(offset, search), services.roles(roleOffset)]).then(([p, r]) => {
      if (active) { setProfiles(p); setRoles(r.data); setTotalRoles(r.pagination.total); }
    }).catch((e: unknown) => { if (active) error(e); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [allowed, offset, roleOffset, search, services]);
  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); await load(); setMessage(label('saved')); } catch (e) { error(e); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, work: (data: FormData, form: HTMLFormElement) => Promise<void>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    void action(async () => { try { await work(data, form); } finally { form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => { input.value = ''; }); } });
  }
  if (!allowed) return <Alert>{label('forbidden')}</Alert>;
  return <div className="space-y-6"><h1 className="text-2xl font-semibold">{label('title')}</h1>
    {message && <p role="status" className="print:hidden">{message}</p>}
    <Button className="print:hidden" disabled={busy} onClick={() => void action(async () => { setEditing(null); setCreating(false); setRevoking(null); })}>{label('reload')}</Button>
    <Card><h2 className="text-xl font-semibold">{label('invite')}</h2><form className="print:hidden" onSubmit={(event) => submit(event, async (data) => {
      setInvitationUrl(''); const result = await services.invite({ email: value(data, 'email'), role: value(data, 'role') as AssignableStaffRole, delivery: value(data, 'delivery') as 'email' | 'print' });
      if (result.delivery === 'print') setInvitationUrl(result.invitationUrl);
    })}><fieldset disabled={busy} className="space-y-3"><label className="block">{label('email')}<Input name="email" type="email" required autoComplete="email"/></label><RoleSelect/>
      <label className="block">{label('delivery')}<select className="block h-11 w-full rounded-md border px-3" name="delivery" defaultValue="print"><option value="print">{label('printLink')}</option><option value="email">{label('sendEmail')}</option></select></label>
      <Button type="submit">{label('invite')}</Button></fieldset></form>
      {invitationUrl && <div className="mt-4 space-y-2"><label className="block">{label('invitationUrl')}<textarea className="block w-full break-all rounded-md border p-3" rows={4} readOnly value={invitationUrl} onFocus={(event) => event.currentTarget.select()}/></label><p>{label('printHelp')}</p><Button className="print:hidden" onClick={() => window.print()}>{label('print')}</Button><Button className="print:hidden" onClick={() => setInvitationUrl('')}>{label('dismiss')}</Button></div>}
    </Card>
    <Card className="print:hidden"><h2 className="text-xl font-semibold">{label('profiles')}</h2><form onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(value(new FormData(event.currentTarget), 'search')); }} className="flex items-end gap-3"><label className="grow">{label('search')}<Input name="search"/></label><Button type="submit" disabled={busy}>{label('search')}</Button></form>
      <Button disabled={busy} onClick={() => { setEditing(null); setCreating(true); }}>{label('addProfile')}</Button>
      {!profiles && <p role="status">{label('loading')}</p>}
      {profiles?.data.length === 0 && <p>{label('empty')}</p>}
      <ul className="divide-y">{profiles?.data.map((profile) => <li key={profile.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><span>{profile.displayName}{profile.rank ? ' · ' + profile.rank : ''}{profile.isPublic ? ' · ' + label('public') : ''}</span><Button disabled={busy} onClick={() => { setEditing(profile); setCreating(false); }}>{label('edit')}</Button></li>)}</ul>
      <div className="flex gap-3"><Button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>{label('previous')}</Button><Button disabled={busy || !profiles || offset + 25 >= profiles.pagination.total} onClick={() => setOffset(offset + 25)}>{label('next')}</Button></div>
    </Card>
    {(creating || editing) && <Card className="print:hidden"><h2>{label(creating ? 'addProfile' : 'editProfile')}</h2><form key={editing?.id ?? 'new'} onSubmit={(event) => submit(event, async (data, form) => {
      const photoInput = form.elements.namedItem('photo');
      const file = photoInput instanceof HTMLInputElement ? photoInput.files?.[0] : undefined;
      const photo = file instanceof File && file.size > 0 ? await resizeStaffPhoto(file) : null;
      const input = { displayName: value(data, 'displayName'), bio: value(data, 'bio') || null, rank: value(data, 'rank') || null, ...(data.has('removePhoto') ? { photoKey: null } : {}), memberId: value(data, 'memberId') || null, userId: value(data, 'userId') || null, isPublic: data.has('isPublic') };
      const saved = editing ? await services.updateProfile(editing.id, { ...input, revision: editing.revision }) : await services.createProfile(input);
      // Keep the saved identity/revision if the separate storage request fails, so retrying cannot create a duplicate.
      setEditing(saved); setCreating(false);
      if (photo) await services.uploadPhoto(saved.id, saved.revision, photo);
      setEditing(null); setCreating(false);
    })}><fieldset disabled={busy} className="space-y-3">
      <label className="block">{label('displayName')}<Input name="displayName" defaultValue={editing?.displayName} required/></label>
      <label className="block">{label('bio')}<textarea className="block min-h-24 w-full rounded-md border p-3" name="bio" defaultValue={editing?.bio ?? ''}/></label>
      {(['rank', 'memberId', 'userId'] as const).map((key) => <label className="block" key={key}>{label(key)}<Input name={key} defaultValue={editing?.[key] ?? ''}/></label>)}
      {editing?.photoKey && <img className="size-24 rounded object-cover" src={'/api/staff/profiles/' + encodeURIComponent(editing.id) + '/photo'} alt={editing.displayName}/>}
      <label className="block">{label('photo')}<Input name="photo" type="file" accept="image/jpeg,image/png,image/webp"/></label>
      {editing?.photoKey && <label className="flex items-center gap-2"><input name="removePhoto" type="checkbox"/>{label('removePhoto')}</label>}
      <p>{label('photoHelp')}</p><label className="flex items-center gap-2"><input type="checkbox" name="isPublic" defaultChecked={editing?.isPublic}/>{label('public')}</label>
      <Button type="submit">{label('save')}</Button><Button type="button" onClick={() => { setEditing(null); setCreating(false); }}>{label('cancel')}</Button>
    </fieldset></form></Card>}
    <Card className="print:hidden"><h2 className="text-xl font-semibold">{label('access')}</h2><p>{label('accessHelp')}</p>
      <form onSubmit={(event) => submit(event, (data) => services.grantRole(value(data, 'userId'), value(data, 'role') as AssignableStaffRole))}><fieldset disabled={busy} className="space-y-3"><label>{label('userId')}<Input name="userId" required/></label><RoleSelect/><Button type="submit">{label('grantRole')}</Button></fieldset></form>
      <ul className="divide-y">{roles.map((role) => <li key={role.id} className="space-y-3 py-4"><h3 className="font-semibold">{profiles?.data.find((profile) => profile.userId === role.userId)?.displayName ?? role.userId} · {label(role.role)}</h3>
        {role.role !== 'owner' && <><form key={role.revision} onSubmit={(event) => submit(event, (data) => services.changeRole(role.id, value(data, 'role') as AssignableStaffRole, role.revision))}><fieldset disabled={busy} className="flex items-end gap-3"><RoleSelect initial={role.role}/><Button type="submit">{label('changeRole')}</Button></fieldset></form>
          {revoking !== role.id ? <Button disabled={busy} onClick={() => setRevoking(role.id)}>{label('revoke')}</Button> : <div><p>{label('revokeConfirm')}</p><Button disabled={busy} onClick={() => void action(async () => { await services.revokeRole(role.id, role.revision); setRevoking(null); })}>{label('confirmRevoke')}</Button><Button onClick={() => setRevoking(null)}>{label('cancel')}</Button></div>}</>}
        {passwordEnabled && canResetStaffPassword(actorRoles, role.role) && <form onSubmit={(event) => submit(event, (data) => services.resetPassword(role.userId, String(data.get('password') ?? '')))}><fieldset disabled={busy} className="flex items-end gap-3"><label className="grow">{label('newPassword')}<Input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password"/></label><Button type="submit">{label('resetPassword')}</Button></fieldset><p>{label('resetHelp')}</p></form>}
      </li>)}</ul><div className="flex gap-3"><Button disabled={busy || roleOffset === 0} onClick={() => setRoleOffset(Math.max(0, roleOffset - 25))}>{label('previous')}</Button><Button disabled={busy || roleOffset + 25 >= totalRoles} onClick={() => setRoleOffset(roleOffset + 25)}>{label('next')}</Button></div>
    </Card>
  </div>;
}
