// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import type { StaffProfile, StaffRoleRecord, StaffProfileListResponse, AssignableStaffRole } from '@plaingym/shared/contracts';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Label } from '../../components/ui/label.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { CheckboxField, Select, Textarea } from '../../components/ui/select.js';
import { EmptyState, LoadingState } from '../../components/ui/states.js';
import { Badge, StackedItem, StackedList } from '../../components/ui/table.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { createStaffClient, StaffRequestError, type StaffClient } from './client.js';
import { resizeStaffPhoto } from './photo.js';
const client = createStaffClient();
const label = (key: string) => t('staff/profiles:' + key);
const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
function Field({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  return <Label className={'grid min-w-0 gap-2 ' + (className ?? '')}>{text}{children}</Label>;
}
function RoleSelect({ initial = 'coach' }: { initial?: AssignableStaffRole }) {
  return <Field text={label('role')}><Select name="role" defaultValue={initial}>
    {(['admin', 'coach', 'front_desk'] as const).map((role) => <option key={role} value={role}>{label(role)}</option>)}
  </Select></Field>;
}
function Notice({ message }: { message: string }) {
  return message ? <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm print:hidden">{message}</p> : null;
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
  const closeEditor = () => { setEditing(null); setCreating(false); };
  if (!allowed) return <Page><Alert>{label('forbidden')}</Alert></Page>;
  const nameFor = (role: StaffRoleRecord) => profiles?.data.find((profile) => profile.userId === role.userId)?.displayName;
  return <Page>
    <PageHeader className="print:hidden" title={label('title')} actions={<Button variant="outline" disabled={busy}
      onClick={() => void action(async () => { closeEditor(); setRevoking(null); })}>{label('reload')}</Button>}/>
    {!(creating || editing) && <Notice message={message}/>}
    <PageSection title={label('invite')} className="print:space-y-0"><div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
      <form className="print:hidden" onSubmit={(event) => submit(event, async (data) => {
        setInvitationUrl(''); const result = await services.invite({ email: value(data, 'email'), role: value(data, 'role') as AssignableStaffRole, delivery: value(data, 'delivery') as 'email' | 'print' });
        if (result.delivery === 'print') setInvitationUrl(result.invitationUrl);
      })}><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_auto] lg:items-end">
        <Field text={label('email')}><Input name="email" type="email" required autoComplete="email"/></Field><RoleSelect/>
        <Field text={label('delivery')}><Select name="delivery" defaultValue="print"><option value="print">{label('printLink')}</option><option value="email">{label('sendEmail')}</option></Select></Field>
        <Button type="submit">{label('invite')}</Button></fieldset></form>
      {invitationUrl && <div className="space-y-3 border-t border-border pt-4">
        <Field text={label('invitationUrl')}><Textarea className="break-all font-mono text-sm" rows={4} readOnly value={invitationUrl} onFocus={(event) => event.currentTarget.select()}/></Field>
        <p className="text-sm">{label('printHelp')}</p>
        <div className="grid grid-cols-2 gap-2 sm:flex print:hidden"><Button onClick={() => window.print()}>{label('print')}</Button><Button variant="outline" onClick={() => setInvitationUrl('')}>{label('dismiss')}</Button></div>
      </div>}
    </div></PageSection>
    <PageSection className="print:hidden" title={label('profiles')} actions={<Button disabled={busy} onClick={() => { setMessage(''); setEditing(null); setCreating(true); }}>{label('addProfile')}</Button>}>
      <form role="search" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(value(new FormData(event.currentTarget), 'search')); }} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field text={label('search')} className="flex-1"><Input name="search" type="search"/></Field><Button type="submit" variant="outline" disabled={busy}>{label('searchButton')}</Button></form>
      {!profiles ? busy && <LoadingState label={label('loading')}/> : profiles.data.length === 0
        ? <EmptyState title={label(search ? 'empty' : 'noProfiles')} description={label(search ? 'emptyHelp' : 'noProfilesHelp')}/>
        : <StackedList>{profiles.data.map((profile) => <StackedItem key={profile.id} className="flex-row items-center justify-between gap-3">
          <div className="min-w-0"><p className="break-words font-medium">{profile.displayName}</p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{profile.rank}{profile.isPublic && <Badge tone="muted">{label('public')}</Badge>}</p></div>
          <Button variant="outline" disabled={busy} aria-label={label('edit') + ' ' + profile.displayName} onClick={() => { setMessage(''); setEditing(profile); setCreating(false); }}>{label('edit')}</Button>
        </StackedItem>)}</StackedList>}
      {profiles && profiles.pagination.total > 25 && <div className="flex justify-between gap-3"><Button variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>{label('previous')}</Button>
        <Button variant="outline" disabled={busy || offset + 25 >= profiles.pagination.total} onClick={() => setOffset(offset + 25)}>{label('next')}</Button></div>}
    </PageSection>
    {(creating || editing) && <Dialog title={label(creating ? 'addProfile' : 'editProfile')} description={editing?.displayName} closeLabel={label('closeDialog')} dismissible={!busy} onClose={closeEditor}>
      <form key={editing?.id ?? 'new'} className="space-y-4" onSubmit={(event) => submit(event, async (data, form) => {
        const photoInput = form.elements.namedItem('photo');
        const file = photoInput instanceof HTMLInputElement ? photoInput.files?.[0] : undefined;
        const photo = file instanceof File && file.size > 0 ? await resizeStaffPhoto(file) : null;
        const input = { displayName: value(data, 'displayName'), bio: value(data, 'bio') || null, rank: value(data, 'rank') || null, ...(data.has('removePhoto') ? { photoKey: null } : {}), memberId: value(data, 'memberId') || null, userId: value(data, 'userId') || null, isPublic: data.has('isPublic') };
        const saved = editing ? await services.updateProfile(editing.id, { ...input, revision: editing.revision }) : await services.createProfile(input);
        // Keep the saved identity/revision if the separate storage request fails, so retrying cannot create a duplicate.
        setEditing(saved); setCreating(false);
        if (photo) await services.uploadPhoto(saved.id, saved.revision, photo);
        closeEditor();
      })}>
        <Notice message={message}/>
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <Field text={label('displayName')} className="sm:col-span-2"><Input name="displayName" defaultValue={editing?.displayName} required/></Field>
          <Field text={label('bio')} className="sm:col-span-2"><Textarea name="bio" defaultValue={editing?.bio ?? ''}/></Field>
          {(['rank', 'memberId', 'userId'] as const).map((key) => <Field key={key} text={label(key)} className={key === 'rank' ? 'sm:col-span-2' : ''}><Input name={key} defaultValue={editing?.[key] ?? ''}/></Field>)}
          {editing?.photoKey && <img className="size-24 rounded-lg object-cover" src={'/api/staff/profiles/' + encodeURIComponent(editing.id) + '/photo'} alt={editing.displayName}/>}
          <div className="space-y-2 sm:col-span-2"><Field text={label('photo')}><Input name="photo" type="file" accept="image/jpeg,image/png,image/webp" className="py-2"/></Field>
            <p className="text-sm text-muted-foreground">{label('photoHelp')}</p>
            {editing?.photoKey && <CheckboxField name="removePhoto" label={label('removePhoto')}/>}</div>
          <CheckboxField className="sm:col-span-2" name="isPublic" defaultChecked={editing?.isPublic} label={label('public')}/>
        </fieldset>
        <div className="flex flex-col gap-2 sm:flex-row"><Button type="submit" disabled={busy}>{label('save')}</Button><Button variant="outline" disabled={busy} onClick={closeEditor}>{label('cancel')}</Button></div>
      </form>
    </Dialog>}
    <PageSection className="print:hidden" title={label('access')} description={label('accessHelp')}>
      <form onSubmit={(event) => submit(event, (data) => services.grantRole(value(data, 'userId'), value(data, 'role') as AssignableStaffRole))}
        className="rounded-xl border border-border bg-card p-4 sm:p-6"><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <Field text={label('userId')}><Input name="userId" required/></Field><RoleSelect/><Button type="submit">{label('grantRole')}</Button></fieldset></form>
      {roles.length > 0 && <StackedList>{roles.map((role) => <StackedItem key={role.id} className="gap-3">
        <h3 className="flex flex-wrap items-center gap-2 font-semibold"><span className="break-all">{nameFor(role) ?? role.userId}</span><Badge>{label(role.role)}</Badge></h3>
        {role.role !== 'owner' && <><form key={role.revision} onSubmit={(event) => submit(event, (data) => services.changeRole(role.id, value(data, 'role') as AssignableStaffRole, role.revision))}>
          <fieldset disabled={busy} className="flex flex-col gap-2 sm:flex-row sm:items-end"><div className="sm:w-56"><RoleSelect initial={role.role}/></div><Button type="submit" variant="outline">{label('changeRole')}</Button></fieldset></form>
          {revoking !== role.id ? <Button variant="outline" className="self-start" disabled={busy} onClick={() => setRevoking(role.id)}>{label('revoke')}</Button>
            : <div role="group" aria-label={label('revoke')} className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"><p className="text-sm">{label('revokeConfirm')}</p>
              <div className="grid grid-cols-2 gap-2 sm:flex"><Button variant="destructive" disabled={busy} onClick={() => void action(async () => { await services.revokeRole(role.id, role.revision); setRevoking(null); })}>{label('confirmRevoke')}</Button>
                <Button variant="outline" onClick={() => setRevoking(null)}>{label('cancel')}</Button></div></div>}</>}
        {passwordEnabled && canResetStaffPassword(actorRoles, role.role) && <form onSubmit={(event) => submit(event, (data) => services.resetPassword(role.userId, String(data.get('password') ?? '')))} className="space-y-1">
          <fieldset disabled={busy} className="flex flex-col gap-2 sm:flex-row sm:items-end"><Field text={label('newPassword')} className="flex-1"><Input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password"/></Field>
            <Button type="submit" variant="outline">{label('resetPassword')}</Button></fieldset><p className="text-sm text-muted-foreground">{label('resetHelp')}</p></form>}
      </StackedItem>)}</StackedList>}
      {totalRoles > 25 && <div className="flex justify-between gap-3"><Button variant="outline" disabled={busy || roleOffset === 0} onClick={() => setRoleOffset(Math.max(0, roleOffset - 25))}>{label('previous')}</Button>
        <Button variant="outline" disabled={busy || roleOffset + 25 >= totalRoles} onClick={() => setRoleOffset(roleOffset + 25)}>{label('next')}</Button></div>}
    </PageSection>
  </Page>;
}
