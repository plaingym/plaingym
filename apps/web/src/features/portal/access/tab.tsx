// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memberResponseSchema, membersContracts, portalAccessContracts, type HouseholdUser } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import type { ExtensionViewProps } from '../../../lib/registries.js';
import { t } from '../../../lib/i18n.js';
import { memberRequest } from '../../members/api.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Select } from '../../../components/ui/select.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Alert } from '../../../components/ui/alert.js';
import { LoadingState, ErrorState, EmptyState } from '../../../components/ui/states.js';
const text = (key: string) => t('portal/access:' + key);
export function PortalAccessTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap(), cache = useQueryClient(), [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<'invite' | { kind: 'reset' | 'revoke'; login: HouseholdUser } | null>(null);
  const [email, setEmail] = useState(''), [scope, setScope] = useState<'payer' | 'member'>('member'), [delivery, setDelivery] = useState<'email' | 'print'>('print'), [password, setPassword] = useState(''), [invitation, setInvitation] = useState<string | null>(null);
  const person = useQuery({ queryKey: ['portal-access-member', memberId], enabled: !!memberId,
    queryFn: ({ signal }) => memberRequest(memberResponseSchema, '/api/members/' + memberId, 'GET', undefined, signal) });
  const householdId = person.data?.data.householdId, key = ['portal-access', householdId];
  const users = useQuery({ queryKey: [...key, offset], enabled: !!householdId,
    queryFn: ({ signal }) => memberRequest(portalAccessContracts.logins.response, `/api/households/${householdId}/portal-logins?offset=${offset}&limit=20`, 'GET', undefined, signal) });
  const operation = useMutation({ mutationFn: async () => {
    if (!householdId || !edit) return;
    if (edit === 'invite') {
      const result = await memberRequest(portalAccessContracts.invite.response, `/api/households/${householdId}/portal-invitations`, 'POST', { email, scope, memberId: scope === 'member' ? memberId : null, delivery });
      if (result.data.delivery === 'print') setInvitation(result.data.invitationUrl);
    } else if (edit.kind === 'revoke') await memberRequest(membersContracts.revokeHouseholdUser.response, `/api/households/${householdId}/users/${edit.login.id}`, 'DELETE');
    else await memberRequest(portalAccessContracts.resetPassword.response, `/api/households/${householdId}/users/${edit.login.id}/password`, 'POST', { newPassword: password });
  }, onSuccess: async () => { setEdit(null); setPassword(''); await cache.invalidateQueries({ queryKey: key }); }, onError: () => setPassword('') });
  const open = (value: typeof edit) => { operation.reset(); setInvitation(null); setEdit(value); setEmail(person.data?.data.email ?? ''); setPassword(''); };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!operation.isPending) operation.mutate(); };
  if (person.isPending || users.isPending) return <LoadingState />;
  if (person.isError || users.isError) return <ErrorState onRetry={() => { void person.refetch(); void users.refetch(); }} />;
  return <section className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('title')}</h2><p className="text-muted-foreground">{text('description')}</p></div><Button onClick={() => open('invite')}>{text('invite')}</Button></div>
    {operation.isSuccess && <p role="status">{text('saved')}</p>}
    {invitation && <div className="space-y-2 rounded-lg border border-border p-4"><p className="font-medium">{text('privateLink')}</p><p className="break-all select-all">{invitation}</p><Button variant="outline" onClick={() => window.print()}>{text('print')}</Button></div>}
    {!users.data.data.length && <EmptyState title={text('empty')} />}
    <ul className="space-y-3">{users.data.data.map(login => <li key={login.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"><div className="min-w-0"><p className="font-medium">{text(login.scope)}</p><p className="break-all text-sm text-muted-foreground">{login.email ?? text('account')}</p></div><div className="flex flex-wrap gap-2">{bootstrap.data?.login.password && <Button variant="outline" onClick={() => open({ kind: 'reset', login })}>{text('reset')}</Button>}<Button variant="outline" onClick={() => open({ kind: 'revoke', login })}>{text('revoke')}</Button></div></li>)}</ul>
    <div className="flex gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{text('previous')}</Button><Button variant="outline" disabled={offset + 20 >= users.data.pagination.total} onClick={() => setOffset(offset + 20)}>{text('next')}</Button></div>
    {edit && <Dialog title={text(edit === 'invite' ? 'invite' : edit.kind === 'reset' ? 'reset' : 'revoke')} closeLabel={text('cancel')} onClose={() => { setEdit(null); setPassword(''); }} dismissible={!operation.isPending}>
      <form onSubmit={submit} className="space-y-4">{edit === 'invite' ? <>
        <div className="space-y-2"><Label htmlFor="portal-email">{text('email')}</Label><Input id="portal-email" type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="portal-scope">{text('scope')}</Label><Select id="portal-scope" value={scope} onChange={event => setScope(event.target.value as 'payer' | 'member')}><option value="member">{text('member')}</option><option value="payer">{text('payer')}</option></Select></div>
        <div className="space-y-2"><Label htmlFor="portal-delivery">{text('delivery')}</Label><Select id="portal-delivery" value={delivery} onChange={event => setDelivery(event.target.value as 'email' | 'print')}><option value="print">{text('printDelivery')}</option><option value="email">{text('emailDelivery')}</option></Select></div>
      </> : edit.kind === 'reset' ? <div className="space-y-2"><Label htmlFor="portal-password">{text('password')}</Label><Input id="portal-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></div> : <p>{text('confirmRevoke')}</p>}
        {operation.isError && <Alert>{text('failed')}</Alert>}<Button type="submit" disabled={operation.isPending}>{text(edit === 'invite' ? 'invite' : edit.kind === 'reset' ? 'reset' : 'revoke')}</Button>
      </form>
    </Dialog>}
  </section>;
}
