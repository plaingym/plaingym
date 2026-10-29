// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { portalAccessContracts } from '@plaingym/shared/contracts';
import { bootstrapKey, useBootstrap } from '../../../app/context.js';
import { createJsonTransport } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Alert } from '../../../components/ui/alert.js';
import { LoadingState, ErrorState } from '../../../components/ui/states.js';
import { PageHeader } from '../../../components/ui/page.js';
const text = (key: string) => t('portal/shell:' + key);
/** The login link's callback: the signed-in user completes the claim its code names, then opens the portal. */
function CompleteClaim({ code }: { code: string }) {
  const cache = useQueryClient();
  const complete = useMutation({ mutationFn: async () => {
    await createJsonTransport()('/api/portal/claims/complete', { claim: code });
    await cache.cancelQueries(); cache.clear();
    location.assign('/portal');
  } });
  const { mutate } = complete;
  useEffect(() => { mutate(); }, [mutate]);
  return complete.isError ? <><Alert>{text('completeFailed')}</Alert><a className="inline-flex min-h-11 items-center underline" href="/login">{text('signIn')}</a></> : <LoadingState />;
}
export function PortalClaim() {
  const bootstrap = useBootstrap(), cache = useQueryClient(), [token] = useState(() => location.hash.slice(1)), [password, setPassword] = useState('');
  const [code] = useState(() => new URLSearchParams(location.search).get('claim'));
  // Neither the invitation token nor the claim code stays in the address bar or history.
  useEffect(() => { history.replaceState(null, '', location.pathname); }, []);
  const claim = useMutation({
    mutationFn: async () => portalAccessContracts.claim.response.parse(await createJsonTransport()('/api/portal/invitations/accept', { token, ...(bootstrap.data?.login.password ? { password } : {}) })).data,
    onSuccess: () => setPassword(''), onError: () => setPassword(''),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!claim.isPending) claim.mutate(); };
  const signIn = <a className="inline-flex min-h-11 items-center underline" href="/login" onClick={() => void cache.invalidateQueries({ queryKey: bootstrapKey })}>{text('signIn')}</a>;
  return <main id="main-content" className="mx-auto w-full max-w-md space-y-6 px-4 py-8"><PageHeader title={text('claimTitle')} description={text(code ? 'completeDescription' : bootstrap.data?.login.password ? 'claimDescription' : 'claimEmailDescription')} />
    {code ? <CompleteClaim code={code} /> : bootstrap.isPending ? <LoadingState /> : bootstrap.isError ? <ErrorState onRetry={() => void bootstrap.refetch()} />
      : claim.isSuccess ? claim.data.status === 'email_sent' ? <p role="status">{text('claimEmailSent')}</p> : <><p role="status">{text('claimed')}</p>{signIn}</> :
      <form className="space-y-4" onSubmit={submit}>{bootstrap.data.login.password && <div className="space-y-2"><Label htmlFor="claim-password">{text('password')}</Label><Input id="claim-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></div>}
        {claim.isError && <Alert>{text('claimFailed')}</Alert>}<Button type="submit" className="w-full" disabled={claim.isPending || !token}>{text('claim')}</Button></form>}
  </main>;
}
