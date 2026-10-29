// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useBootstrap } from '../../../app/context.js';
import { createJsonTransport } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Alert } from '../../../components/ui/alert.js';
import { LoadingState, ErrorState } from '../../../components/ui/states.js';
import { PageHeader } from '../../../components/ui/page.js';
const text = (key: string) => t('portal/shell:' + key);
export function PortalClaim() {
  const bootstrap = useBootstrap(), [token] = useState(() => location.hash.slice(1)), [password, setPassword] = useState('');
  useEffect(() => { history.replaceState(null, '', location.pathname); }, []);
  const claim = useMutation({ mutationFn: () => createJsonTransport()('/api/portal/invitations/accept', { token, ...(bootstrap.data?.login.password ? { password } : {}) }), onSuccess: () => setPassword(''), onError: () => setPassword('') });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!claim.isPending) claim.mutate(); };
  return <main id="main-content" className="mx-auto w-full max-w-md space-y-6 px-4 py-8"><PageHeader title={text('claimTitle')} description={text('claimDescription')} />
    {bootstrap.isPending ? <LoadingState /> : bootstrap.isError ? <ErrorState onRetry={() => void bootstrap.refetch()} /> : claim.isSuccess ? <><p role="status">{text('claimed')}</p><a className="inline-flex min-h-11 items-center underline" href="/login">{text('signIn')}</a></> :
      <form className="space-y-4" onSubmit={submit}>{bootstrap.data.login.password && <div className="space-y-2"><Label htmlFor="claim-password">{text('password')}</Label><Input id="claim-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></div>}
        {claim.isError && <Alert>{text('claimFailed')}</Alert>}<Button type="submit" className="w-full" disabled={claim.isPending || !token}>{text('claim')}</Button></form>}
  </main>;
}
