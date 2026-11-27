// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountEmailSchema, type AccountSummary } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { t } from '../../lib/i18n.js';
import { instantLabel } from '../../lib/instant.js';
import { Button } from '../../components/ui/button.js';
import { Alert, FormMessage } from '../../components/ui/alert.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { AccountRequestError, createAccountClient, type AccountClient } from './client.js';

const text = (key: string, values?: Record<string, string>) => t('auth/account:' + key, values);
const defaultClient = createAccountClient();
export const accountKey = (userId: string) => ['account', userId] as const;

function errorText(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.details?.newEmail?.includes('same_email')) return text('errorSame');
    if (error.details?.currentPassword?.includes('wrong_password')) return text('passwordWrong');
    if (error.details?.currentPassword?.includes('required')) return text('errorPasswordRequired');
    if (error.status === 429) return text('errorRateLimited');
    if (error.status === 503) return text('unavailableNoEmail');
  }
  return text('errorGeneric');
}
const formatTime = (instant: string) => instantLabel(instant);
/** What a pending change waits for: the link to the current address first, or the one to the new address. */
const pendingText = (pending: { email: string; expiresAt: string; awaiting: 'current_address' | 'new_address' }) =>
  text(pending.awaiting === 'current_address' ? 'pendingCurrent' : 'pending', { email: pending.email, time: formatTime(pending.expiresAt) });

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:gap-4">
    <dt className="text-sm font-medium sm:w-40 sm:shrink-0">{label}</dt>
    <dd className="min-w-0 text-sm text-muted-foreground">{children}</dd>
  </div>;
}

function ChangeEmail({ account, client, userId }: { account: AccountSummary; client: AccountClient; userId: string }) {
  const cache = useQueryClient();
  const [value, setValue] = useState(''), [current, setCurrent] = useState('');
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  // With the `password` proof the login's current password goes with the request; otherwise its current address gets a link first.
  const withPassword = account.emailChangeProof === 'password';
  const change = useMutation({
    mutationFn: (args: [newEmail: string, currentPassword?: string]) => client.requestEmailChange(...args),
    onSuccess: async (sent) => {
      setValue('');
      setMessage({ kind: 'status', text: pendingText(sent) });
      await cache.invalidateQueries({ queryKey: accountKey(userId) });
    },
    // A request that fails after it was recorded (503) has withdrawn the earlier link too, so read the summary again.
    onError: async (error) => {
      setMessage({ kind: 'alert', text: errorText(error) });
      await cache.invalidateQueries({ queryKey: accountKey(userId) });
    },
    // The password is never kept in the form after it was sent, whatever the answer.
    onSettled: () => setCurrent(''),
  });
  if (account.emailChange !== 'available') return <Alert>{text(account.emailChange === 'several_gyms' ? 'unavailableSeveralGyms' : 'unavailableNoEmail')}</Alert>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = accountEmailSchema.safeParse(value.trim());
    if (!parsed.success) { setMessage({ kind: 'alert', text: text('invalidEmail') }); return; }
    if (withPassword && !current) { setMessage({ kind: 'alert', text: text('errorPasswordRequired') }); return; }
    setMessage(null);
    change.mutate(withPassword ? [parsed.data, current] : [parsed.data]);
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{text(withPassword ? 'changeHelp' : 'changeHelpCurrent')}</p>
    {account.googleLinked && <p className="text-sm text-muted-foreground">{text('changeGoogle')}</p>}
    {account.pendingEmail && message?.kind !== 'status' && <p role="status" className="rounded-md border border-border p-3 text-sm">
      {pendingText(account.pendingEmail)}</p>}
    <FormMessage message={message} />
    <form className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end" onSubmit={submit} noValidate>
      <div className="min-w-0 flex-1 space-y-1 sm:min-w-56">
        <Label htmlFor="account-new-email">{text('newEmail')}</Label>
        <Input id="account-new-email" type="email" autoComplete="email" inputMode="email" maxLength={254} required value={value}
          onChange={(event) => setValue(event.target.value)} />
      </div>
      {withPassword && <div className="min-w-0 flex-1 sm:min-w-56">
        <PasswordField id="account-email-current-password" label={text('currentPassword')} value={current} onChange={setCurrent} autoComplete="current-password" />
      </div>}
      <Button type="submit" className="min-h-11" disabled={change.isPending || !value.trim() || (withPassword && !current)}>{text('changeSubmit')}</Button>
    </form>
  </div>;
}

function passwordErrorText(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.details?.currentPassword?.includes('wrong_password')) return text('passwordWrong');
    if (error.status === 429) return text('passwordRateLimited');
    if (error.status === 403) return text('passwordOff');
  }
  return text('passwordError');
}

function PasswordField({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <div className="min-w-0 space-y-1">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="password" autoComplete={autoComplete} maxLength={128} required value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}

/** The login changes its own password with the current one; its other sessions here end. */
function ChangePassword({ client }: { client: AccountClient }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  const change = useMutation({
    mutationFn: (input: { current: string; next: string }) => client.changePassword(input.current, input.next),
    onSuccess: () => {
      setCurrent(''); setNext(''); setConfirm('');
      setMessage({ kind: 'status', text: text('passwordChanged') });
    },
    onError: (error) => setMessage({ kind: 'alert', text: passwordErrorText(error) }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (next.length < 12) { setMessage({ kind: 'alert', text: text('passwordLength') }); return; }
    if (next !== confirm) { setMessage({ kind: 'alert', text: text('passwordMismatch') }); return; }
    setMessage(null);
    change.mutate({ current, next });
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{text('passwordHelp')}</p>
    <FormMessage message={message} />
    <form className="flex flex-col gap-3 sm:max-w-sm" onSubmit={submit} noValidate>
      <PasswordField id="account-current-password" label={text('currentPassword')} value={current} onChange={setCurrent} autoComplete="current-password" />
      <PasswordField id="account-new-password" label={text('newPassword')} value={next} onChange={setNext} autoComplete="new-password" />
      <PasswordField id="account-confirm-password" label={text('confirmPassword')} value={confirm} onChange={setConfirm} autoComplete="new-password" />
      <Button type="submit" className="min-h-11 sm:self-start" disabled={change.isPending || !current || !next || !confirm}>{text('passwordSubmit')}</Button>
    </form>
  </div>;
}

/** The signed-in login's own account: its sign-in email, methods and access, its password change and the verified email change. */
export function AccountPage({ login, userId, client = defaultClient }: { login: ShellBootstrap['login']; userId: string; client?: AccountClient }) {
  const account = useQuery({ queryKey: accountKey(userId), queryFn: () => client.summary() });
  if (account.isPending) return <Page><LoadingState label={text('loading')} /></Page>;
  if (account.isError) return <Page><ErrorState message={text('loadError')} onRetry={() => void account.refetch()} /></Page>;
  const data = account.data;
  const roles = data.roles.map((role) => t('staff/profiles:' + role)).join(', ');
  const households = data.households.map((household) => text(household.scope === 'payer' ? 'householdPayer' : 'householdMember', { name: household.name })).join(', ');
  return <Page className="max-w-3xl">
    <PageHeader title={text('title')} description={text('description')} />
    <PageSection>
      <dl>
        <Row label={text('emailLabel')}><span className="font-medium text-foreground">{data.email}</span></Row>
      </dl>
    </PageSection>
    <PageSection title={text('methodsTitle')}>
      <dl>
        <Row label={text('methodEmailLink')}>{text(login.magicLink ? 'emailLinkOn' : 'emailLinkOff')}</Row>
        <Row label={text('methodPassword')}>{text(!data.password ? 'passwordNone' : login.password ? 'passwordOn' : 'passwordOff')}</Row>
        {(login.google || data.googleLinked) && <Row label={text('methodGoogle')}>{text(data.googleLinked ? 'googleLinked' : 'googleNotLinked')}</Row>}
      </dl>
    </PageSection>
    {data.password && login.password && <PageSection title={text('passwordTitle')}>
      <ChangePassword client={client} />
    </PageSection>}
    <PageSection title={text('accessTitle')}>
      {data.roles.length === 0 && data.households.length === 0 ? <p className="text-sm text-muted-foreground">{text('noAccess')}</p> : <dl>
        {data.roles.length > 0 && <Row label={text('rolesLabel')}>{roles}</Row>}
        {data.households.length > 0 && <Row label={text('householdsLabel')}>{households}</Row>}
      </dl>}
    </PageSection>
    <PageSection title={text('changeTitle')}>
      <ChangeEmail account={data} client={client} userId={userId} />
    </PageSection>
  </Page>;
}
