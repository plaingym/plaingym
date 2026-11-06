// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Card } from '../components/ui/card.js';
import { Alert } from '../components/ui/alert.js';
import { LoadingState, ErrorState } from '../components/ui/states.js';
import { PageHeader } from '../components/ui/page.js';
import { ApiError } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { bootstrapKey, useBootstrap, useShellServices } from '../app/context.js';
import { sessionDestination } from '../app/services.js';
import { DemoSignInLink } from '../features/demo/sign-in-link.js';
/** Messages for the error codes a sign-in returns with: Google's, and those of an email sign-in link (Better Auth's magic-link
 * verify codes). Any other code gets the generic message. */
const returnedErrors: Record<string, string> = {
  account_not_linked: 'auth/google:notLinked', signup_disabled: 'auth/google:noAccount', access_denied: 'auth/google:cancelled',
  // A used, expired or unknown link, or one tried too often.
  INVALID_TOKEN: 'shell/shell:linkUsed', EXPIRED_TOKEN: 'shell/shell:linkUsed', ATTEMPTS_EXCEEDED: 'shell/shell:linkUsed',
  new_user_signup_disabled: 'shell/shell:linkNoAccount',
  failed_to_create_user: 'shell/shell:linkFailed', failed_to_create_session: 'shell/shell:linkFailed', user_not_found: 'shell/shell:linkFailed',
};
function LoginPage() {
  const bootstrap = useBootstrap();
  const services = useShellServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  // The browser is on its way to Google: the request has resolved, but the page hasn't left yet.
  const [leaving, setLeaving] = useState(false);
  // A failed Google or email link sign-in returns here with an error code; only known codes pick their message.
  const returned = (Route.useSearch() as { error?: unknown }).error;
  const returnedError = typeof returned === 'string' && returned ? returnedErrors[returned] ?? 'auth/google:failed' : null;
  const clearReturnedError = async () => {
    if (returned === undefined) return;
    await navigate({ to: '/login', replace: true,
      search: (previous: Record<string, unknown>) => { const rest = { ...previous }; delete rest.error; return rest; } });
  };
  const google = useMutation({
    mutationFn: async () => {
      if (!services.signInWithGoogle) throw new Error('Google sign-in is not available');
      const url = await services.signInWithGoogle();
      await clearReturnedError();
      setLeaving(true);
      window.location.assign(url);
    },
  });
  const { reset: resetGoogle } = google;
  // A page restored from the back-forward cache keeps this state, so coming back from Google starts afresh.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) { setLeaving(false); resetGoogle(); } };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [resetGoogle]);
  // Do not time out a navigation: a slow load must not mint a second OAuth state.
  // If the visitor stops the load, they can reload; returning from Google resets via pageshow.
  const googleBusy = google.isPending || leaving;
  const login = useMutation({
    mutationFn: async (mode: 'password' | 'magic') => {
      if (mode === 'magic') { await services.requestMagicLink(email); return null; }
      await services.signInWithPassword(email, password);
      setPassword('');
      // Clear all gym/user data before another identity's session is loaded.
      await queryClient.cancelQueries();
      queryClient.clear();
      const state = await queryClient.fetchQuery({ queryKey: bootstrapKey, queryFn: ({ signal }) => services.loadBootstrap(signal) });
      if (!state.session || !sessionDestination(state.session)) throw new Error('No account access');
      return sessionDestination(state.session);
    },
    onSuccess: (destination, mode) => {
      if (mode === 'magic') setSent(true);
      else if (destination) void navigate({ to: destination, replace: true });
    },
    onError: () => setPassword(''),
  });
  if (bootstrap.isPending) return <main id="main-content" className="mx-auto w-full max-w-md p-4 sm:p-6"><LoadingState /></main>;
  if (bootstrap.isError) return <main id="main-content" className="mx-auto w-full max-w-md p-4 sm:p-6">
    <ErrorState message={t('shell/shell:loadFailed')} onRetry={() => void bootstrap.refetch()} /></main>;
  const destination = bootstrap.data.session && sessionDestination(bootstrap.data.session);
  if (destination) return <Navigate to={destination} replace />;
  const methods = bootstrap.data.login;
  const googleOn = Boolean(methods.google && services.signInWithGoogle);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending || googleBusy) return;
    void clearReturnedError();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const mode = submitter instanceof HTMLButtonElement ? submitter.value : methods.password ? 'password' : 'magic';
    if (mode === 'password' && methods.password) login.mutate('password');
    if (mode === 'magic' && methods.magicLink) login.mutate('magic');
  };
  return <main id="main-content" className="flex flex-1 items-start justify-center px-4 py-6 sm:items-center sm:p-6">
    <Card className="w-full min-w-0 max-w-md space-y-6 p-4 sm:p-6">
      <PageHeader title={t('shell/shell:title')} description={bootstrap.data.gym.name} />
      {returnedError && !sent && <Alert>{t(returnedError)}</Alert>}
      {googleOn && !sent && <div className="space-y-4">
        <Button type="button" variant="outline" className="w-full" disabled={googleBusy || login.isPending} onClick={() => { google.mutate(); }}>
          {t(googleBusy ? 'auth/google:pending' : 'auth/google:signIn')}</Button>
        {google.isError && <Alert>{t('auth/google:startFailed')}</Alert>}
        {(methods.password || methods.magicLink) && <p className="text-center text-sm text-muted-foreground">{t('auth/google:or')}</p>}
      </div>}
      {sent ? <div className="space-y-4"><p role="status">{t('shell/shell:sent')}</p><DemoSignInLink email={email} />
        <Button variant="outline" className="w-full" onClick={() => { setSent(false); setEmail(''); login.reset(); }}>{t('shell/shell:sendAgain')}</Button></div>
      : methods.password || methods.magicLink ? <form onSubmit={submit} className="space-y-4" aria-busy={login.isPending || googleBusy}>
        <div className="space-y-2"><Label htmlFor="login-email">{t('shell/shell:email')}</Label>
          <Input id="login-email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} disabled={login.isPending || googleBusy} /></div>
        {methods.password && <div className="space-y-2"><Label htmlFor="login-password">{t('shell/shell:password')}</Label>
          <Input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={login.isPending || googleBusy} /></div>}
        {login.isError && <Alert>{t(login.error instanceof ApiError && login.error.status === 429 ? 'shell/shell:rateLimited' : 'shell/shell:failed')}</Alert>}
        {methods.password && <Button type="submit" value="password" className="w-full" disabled={login.isPending || googleBusy || !password}>{t(login.isPending ? 'shell/shell:pending' : 'shell/shell:passwordSubmit')}</Button>}
        {methods.magicLink && <><p className="text-sm text-muted-foreground">{t('shell/shell:magicHint')}</p>
          <Button type="submit" value="magic" variant="outline" className="w-full" disabled={login.isPending || googleBusy}>{t('shell/shell:magicSubmit')}</Button></>}
      </form> : !googleOn && <Alert>{t('shell/shell:unavailable')}</Alert>}
    </Card>
  </main>;
}
export const Route = createFileRoute('/login')({ component: LoginPage });
