// SPDX-License-Identifier: AGPL-3.0-only
import { dateLabel } from '../../../lib/instant.js';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memberResponseSchema, membersContracts, portalAccessContracts, type HouseholdUser, type PortalOutstandingInvitation as OutstandingInvitation } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import type { ExtensionViewProps } from '../../../lib/registries.js';
import { t } from '../../../lib/i18n.js';
import { ApiError } from '../../../lib/api.js';
import { useSendGeneration } from '../../../lib/send-generation.js';
import { memberRequest } from '../../members/api.js';
import { Button } from '../../../components/ui/button.js';
import { Pager } from '../../../components/ui/pager.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Select } from '../../../components/ui/select.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Alert } from '../../../components/ui/alert.js';
import { LoadingState, ErrorState, EmptyState } from '../../../components/ui/states.js';
const text = (key: string) => t('portal/access:' + key);
const refusalReasons = ['already_linked_household', 'member_has_login', 'staff_account', 'adult_birth_date_required'] as const;

export function PortalAccessTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap(), cache = useQueryClient(), [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<'invite' | { kind: 'reset' | 'revoke'; login: HouseholdUser } | { kind: 'withdraw'; invitation: OutstandingInvitation; resendCurrent?: boolean } | null>(null);
  const [email, setEmail] = useState(''), [scope, setScope] = useState<'payer' | 'member'>('member'), [delivery, setDelivery] = useState<'email' | 'print'>('print'), [password, setPassword] = useState(''), [invitation, setInvitation] = useState<string | null>(null);
  const gymId = bootstrap.data?.gym.id;
  const personKey = ['members', gymId, memberId] as const;
  const person = useQuery({ queryKey: personKey, enabled: !!gymId && !!memberId,
    queryFn: ({ signal }) => memberRequest(memberResponseSchema, '/api/members/' + memberId, 'GET', undefined, signal) });
  const householdId = person.data?.data.householdId, key = ['portal-access', householdId];
  const users = useQuery({ queryKey: [...key, offset], enabled: !!householdId,
    queryFn: ({ signal }) => memberRequest(portalAccessContracts.logins.response, `/api/households/${householdId}/portal-logins?offset=${offset}&limit=20`, 'GET', undefined, signal) });
  const pending = useQuery({ queryKey: [...key, 'invitations'], enabled: !!householdId,
    queryFn: ({ signal }) => memberRequest(portalAccessContracts.invitations.response, `/api/households/${householdId}/portal-invitations`, 'GET', undefined, signal) });
  const inviteSend = useSendGeneration('portal-invitation'), { uncertain } = inviteSend;
  const operation = useMutation({ mutationFn: async () => {
    if (!householdId || !edit) return;
    if (edit === 'invite') {
      const request = { email, scope, memberId: scope === 'member' ? memberId : null };
      if (uncertain && delivery === 'email') inviteSend.resend();
      const result = await memberRequest(portalAccessContracts.invite.response, `/api/households/${householdId}/portal-invitations`, 'POST',
        delivery === 'email' ? { ...request, delivery, sendGeneration: inviteSend.generation({ householdId, ...request }) } : { ...request, delivery });
      const unknown = result.data.delivery === 'email' ? inviteSend.settle(result.data) : false;
      if (result.data.delivery === 'print') inviteSend.reset();
      if (result.data.delivery === 'print') setInvitation(result.data.invitationUrl);
      return unknown;
    } else if (edit.kind === 'withdraw') await memberRequest(portalAccessContracts.revokeInvitation.response, `/api/households/${householdId}/portal-invitations/${edit.invitation.id}`, 'DELETE');
    else if (edit.kind === 'revoke') await memberRequest(membersContracts.revokeHouseholdUser.response, `/api/households/${householdId}/users/${edit.login.id}`, 'DELETE');
    else await memberRequest(portalAccessContracts.resetPassword.response, `/api/households/${householdId}/users/${edit.login.id}/password`, 'POST', { newPassword: password });
  }, onSuccess: async (unknown) => {
    const resend = edit && edit !== 'invite' && edit.kind === 'withdraw' && edit.resendCurrent;
    if (!unknown && !resend) setEdit(null);
    setPassword('');
    await cache.invalidateQueries({ queryKey: key });
    if (resend) open('invite', cache.getQueryData<typeof person.data>(personKey)?.data.email ?? '');
  }, onError: () => setPassword('') });
  // Every dialog starts from member-only access, so a payer grant is always a deliberate choice.
  const open = (value: typeof edit, address = person.data?.data.email ?? '') => {
    operation.reset(); inviteSend.reset(); setInvitation(null); setEdit(value); setEmail(address); setScope('member'); setDelivery('print'); setPassword('');
  };
  // A password-mode join: after checking the person, staff issue the printed payer invitation for the household's address.
  const confirm = (address: string | null) => { open('invite', address ?? ''); setScope('payer'); };
  const awaiting = users.data?.awaitingConfirmation;
  const currentEmail = person.data?.data.email?.trim();
  const usesOlderEmail = (entry: Pick<HouseholdUser, 'scope' | 'memberId'> & { email?: string | undefined }) =>
    !!currentEmail && entry.scope === 'member' && entry.memberId === memberId && !!entry.email
    && entry.email.trim().toLowerCase() !== currentEmail.toLowerCase();
  const currentEmailNote = currentEmail && <p className="wrap-anywhere text-sm text-muted-foreground">{t('portal/access:notCurrentEmail', { current: currentEmail })}</p>;
  const error = operation.error;
  const refusal = edit === 'invite' && error instanceof ApiError ? refusalReasons.find(reason => error.reason.includes(reason)) : undefined;
  const label = edit === 'invite' ? 'invite' : edit?.kind === 'reset' ? 'reset' : edit?.kind === 'withdraw' ? 'withdraw' : 'revoke';
  const submit = (event: FormEvent) => { event.preventDefault(); if (!operation.isPending) operation.mutate(); };
  if (person.isPending || users.isPending) return <LoadingState />;
  if (person.isError || users.isError) return <ErrorState onRetry={() => { void person.refetch(); void users.refetch(); }} />;
  return <section className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('title')}</h2><p className="text-muted-foreground">{text('description')}</p></div><Button onClick={() => open('invite')}>{text('invite')}</Button></div>
    {awaiting && <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted p-4"><p className="font-medium">{text('awaitingTitle')}</p><p className="break-all">{awaiting.email ?? text('noAddress')}</p><p>{text('awaitingHelp')}</p><Button variant="outline" onClick={() => confirm(awaiting.email)}>{text('confirm')}</Button></div>}
    {users.data.inviteRefused && <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted p-4"><p>{text('inviteRefused')}</p><Button variant="outline" onClick={() => open('invite', '')}>{text('invite')}</Button></div>}
    {operation.isSuccess && !uncertain && <p role="status">{text('saved')}</p>}
    {invitation && <div className="space-y-2 rounded-lg border border-border p-4"><p className="font-medium">{text('privateLink')}</p><p className="break-all select-all">{invitation}</p><Button variant="outline" onClick={() => window.print()}>{text('print')}</Button></div>}
    {!users.data.data.length && <EmptyState title={text('empty')} />}
    {pending.isError && <Alert variant="error">{text('pendingFailed')} <Button variant="outline" onClick={() => void pending.refetch()}>{text('retry')}</Button></Alert>}
    {pending.data && pending.data.data.length > 0 && <div className="space-y-3"><h3 className="font-medium">{text('pendingTitle')}</h3><p className="text-sm text-muted-foreground">{text('pendingHelp')}</p>
      <ul className="space-y-3">{pending.data.data.map(invitation => {
        const older = usesOlderEmail(invitation);
        return <li key={invitation.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
          <div className="min-w-0"><p className="font-medium">{text(invitation.scope)}{invitation.memberName && <span className="font-normal text-muted-foreground"> · {invitation.memberName}</span>}</p><p className="break-all text-sm text-muted-foreground">{invitation.email}</p>
            {older && currentEmailNote}<p className="text-sm text-muted-foreground">{text('expires')} <time dateTime={invitation.expiresAt}>{dateLabel(invitation.expiresAt, bootstrap.data?.gym.timezone)}</time></p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => open({ kind: 'withdraw', invitation })}>{text('withdraw')}</Button>
            {older && <Button variant="outline" onClick={() => open({ kind: 'withdraw', invitation, resendCurrent: true })}>{text('resendCurrent')}</Button>}
          </div>
        </li>;
      })}</ul></div>}
    <ul className="space-y-3">{users.data.data.map(login => <li key={login.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"><div className="min-w-0"><p className="font-medium">{text(login.scope)}</p><p className="break-all text-sm text-muted-foreground">{login.email ?? text('account')}</p>{usesOlderEmail(login) && currentEmailNote}</div><div className="flex flex-wrap gap-2">{bootstrap.data?.login.password && <Button variant="outline" onClick={() => open({ kind: 'reset', login })}>{text('reset')}</Button>}<Button variant="outline" onClick={() => open({ kind: 'revoke', login })}>{text('revoke')}</Button></div></li>)}</ul>
    <Pager offset={offset} total={users.data.pagination.total} onChange={setOffset} previousLabel={text('previous')} nextLabel={text('next')}/>
    {edit && <Dialog key={label} title={text(label)} closeLabel={text('cancel')} onClose={() => { setEdit(null); setPassword(''); }} dismissible={!operation.isPending}>
      <form onSubmit={submit} className="space-y-4">{edit === 'invite' ? <>
        <div className="space-y-2"><Label htmlFor="portal-email">{text('email')}</Label><Input id="portal-email" type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="portal-scope">{text('scope')}</Label><Select id="portal-scope" value={scope} onChange={event => setScope(event.target.value as 'payer' | 'member')}><option value="member">{text('member')}</option><option value="payer">{text('payer')}</option></Select></div>
        <div className="space-y-2"><Label htmlFor="portal-delivery">{text('delivery')}</Label><Select id="portal-delivery" value={delivery} onChange={event => setDelivery(event.target.value as 'email' | 'print')}><option value="print">{text('printDelivery')}</option><option value="email">{text('emailDelivery')}</option></Select></div>
      </> : edit.kind === 'reset' ? <div className="space-y-2"><Label htmlFor="portal-password">{text('password')}</Label><Input id="portal-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></div> : <p>{text(edit.kind === 'withdraw' ? 'confirmWithdraw' : 'confirmRevoke')}</p>}
        {operation.isError && <Alert variant="error" focusOnReveal>{text(refusal ? 'refused_' + refusal : 'failed')}</Alert>}{uncertain && edit === 'invite' && <Alert>{text('sendUncertain')}</Alert>}<Button type="submit" disabled={operation.isPending}>{text(uncertain && edit === 'invite' ? 'sendAgain' : label)}</Button>
      </form>
    </Dialog>}
  </section>;
}
