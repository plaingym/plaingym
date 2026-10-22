// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Card } from '../components/ui/card.js';
import { Alert } from '../components/ui/alert.js';
import { ApiError } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { bootstrapKey, useBootstrap, useShellServices } from '../app/context.js';
import { sessionDestination } from '../app/services.js';
function LoginPage() {
  const bootstrap = useBootstrap();
  const services = useShellServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
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
  if (bootstrap.isPending) return <main id="main-content" className="p-6" role="status">{t('shell/shell:loading')}</main>;
  if (bootstrap.isError) return <main id="main-content" className="p-6"><Alert>{t('shell/shell:loadFailed')}</Alert>
    <Button onClick={() => void bootstrap.refetch()}>{t('shell/shell:retry')}</Button></main>;
  const destination = bootstrap.data.session && sessionDestination(bootstrap.data.session);
  if (destination) return <Navigate to={destination} replace />;
  const methods = bootstrap.data.login;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const mode = submitter instanceof HTMLButtonElement ? submitter.value : methods.password ? 'password' : 'magic';
    if (mode === 'password' && methods.password) login.mutate('password');
    if (mode === 'magic' && methods.magicLink) login.mutate('magic');
  };
  return <main id="main-content" className="flex flex-1 items-center justify-center p-6">
    <Card className="w-full max-w-md space-y-6">
      <div><p className="text-sm text-muted-foreground">{bootstrap.data.gym.name}</p>
        <h1 className="mt-2 text-2xl font-semibold">{t('shell/shell:title')}</h1></div>
      {sent ? <div className="space-y-4"><p role="status">{t('shell/shell:sent')}</p>
        <Button variant="outline" onClick={() => { setSent(false); setEmail(''); login.reset(); }}>{t('shell/shell:sendAgain')}</Button></div>
      : methods.password || methods.magicLink ? <form onSubmit={submit} className="space-y-4" aria-busy={login.isPending}>
        <div className="space-y-2"><Label htmlFor="login-email">{t('shell/shell:email')}</Label>
          <Input id="login-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={login.isPending} /></div>
        {methods.password && <div className="space-y-2"><Label htmlFor="login-password">{t('shell/shell:password')}</Label>
          <Input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={login.isPending} /></div>}
        {login.isError && <Alert>{t(login.error instanceof ApiError && login.error.status === 429 ? 'shell/shell:rateLimited' : 'shell/shell:failed')}</Alert>}
        {methods.password && <Button type="submit" value="password" className="w-full" disabled={login.isPending || !password}>{t(login.isPending ? 'shell/shell:pending' : 'shell/shell:passwordSubmit')}</Button>}
        {methods.magicLink && <><p className="text-sm text-muted-foreground">{t('shell/shell:magicHint')}</p>
          <Button type="submit" value="magic" variant="outline" className="w-full" disabled={login.isPending}>{t('shell/shell:magicSubmit')}</Button></>}
      </form> : <Alert>{t('shell/shell:unavailable')}</Alert>}
    </Card>
  </main>;
}
export const Route = createFileRoute('/login')({ component: LoginPage });
