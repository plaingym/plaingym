// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountEmailSchema, type AccountSummary } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { t } from '../../lib/i18n.js';
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
    if (error.details?.newEmail?.includes('email_in_use')) return text('errorInUse');
    if (error.details?.newEmail?.includes('same_email')) return text('errorSame');
    if (error.status === 429) return text('errorRateLimited');
    if (error.status === 503) return text('unavailableNoEmail');
  }
  return text('errorGeneric');
}
const formatTime = (instant: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:gap-4">
    <dt className="text-sm font-medium sm:w-40 sm:shrink-0">{label}</dt>
    <dd className="min-w-0 break-words text-sm text-muted-foreground">{children}</dd>
  </div>;
}

function ChangeEmail({ account, client, userId }: { account: AccountSummary; client: AccountClient; userId: string }) {
  const cache = useQueryClient();
  const [value, setValue] = useState(''), [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  const change = useMutation({
    mutationFn: (newEmail: string) => client.requestEmailChange(newEmail),
    onSuccess: async (sent) => {
      setValue('');
      setMessage({ kind: 'status', text: text('pending', { email: sent.email, time: formatTime(sent.expiresAt) }) });
      await cache.invalidateQueries({ queryKey: accountKey(userId) });
    },
    onError: (error) => setMessage({ kind: 'alert', text: errorText(error) }),
  });
  if (account.emailChange !== 'available') return <Alert>{text(account.emailChange === 'several_gyms' ? 'unavailableSeveralGyms' : 'unavailableNoEmail')}</Alert>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = accountEmailSchema.safeParse(value.trim());
    if (!parsed.success) { setMessage({ kind: 'alert', text: errorText(null) }); return; }
    setMessage(null);
    change.mutate(parsed.data);
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{text('changeHelp')}</p>
    {account.googleLinked && <p className="text-sm text-muted-foreground">{text('changeGoogle')}</p>}
    {account.pendingEmail && !message && <p role="status" className="rounded-md border border-border p-3 text-sm">
      {text('pending', { email: account.pendingEmail.email, time: formatTime(account.pendingEmail.expiresAt) })}</p>}
    <FormMessage message={message} />
    <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit} noValidate>
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor="account-new-email">{text('newEmail')}</Label>
        <Input id="account-new-email" type="email" autoComplete="email" inputMode="email" maxLength={254} required value={value}
          onChange={(event) => setValue(event.target.value)} />
      </div>
      <Button type="submit" className="min-h-11" disabled={change.isPending || !value.trim()}>{text('changeSubmit')}</Button>
    </form>
  </div>;
}

/** The signed-in login's own account: its sign-in email, methods and access, and the verified email change. */
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
