// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { googleCallbackPath, googleLoginResponseSchema, type GoogleLogin } from '@plaingym/shared/contracts';
import { bootstrapKey } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Alert, FormMessage } from '../../components/ui/alert.js';
import { ErrorState } from '../../components/ui/states.js';
import { useGymSettings } from './gym-settings.js';
import { Field } from '../setup/field.js';

export const googleLoginKey = ['settings', 'google-login'] as const;
const label = (key: string, values?: Record<string, string>) => t('auth/google:' + key, values);
type Message = { kind: 'status' | 'alert'; text: string };
type Reply = { response: { ok: boolean; status: number }; data?: unknown; error?: unknown };

async function fetchGoogleLogin(): Promise<GoogleLogin> {
  const result = await api.GET('/api/settings/integrations/google');
  if (!result.response.ok) throw new Error('The Google sign-in request failed');
  return parseResponse(googleLoginResponseSchema, result.data).data;
}
/** The gym's Google sign-in settings, shared by the section and the settings page's decision to list it. */
export function useGoogleLogin(enabled: boolean) {
  return useQuery({ queryKey: googleLoginKey, queryFn: fetchGoogleLogin, enabled, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
/** Whether the settings page lists the section: not where the gym can't have Google sign-in (no client, and none to enter). */
export const googleSectionListed = (google: GoogleLogin | undefined) => google !== undefined && (google.source !== 'none' || google.editable || google.installProblem !== undefined);
/** The server's refusal reason (`details` codes, never its message). */
const reasonOf = (body: unknown) => {
  const details = (body as { error?: { details?: Record<string, unknown> } } | undefined)?.error?.details;
  const first = details ? Object.values(details)[0] : undefined;
  return Array.isArray(first) && typeof first[0] === 'string' ? first[0] : null;
};
const refusals: Record<string, string> = { only_sign_in: 'onlySignIn', install_configured: 'installConfigured', not_configured: 'notConfigured', google_rejected: 'rejected' };

/** The redirect URI the gym's OAuth client must list. The admin runs on the gym's canonical origin, the one Google returns to. */
export function GoogleRedirect() {
  return <div className="min-w-0 space-y-1">
    <p className="text-sm font-medium" id="google-redirect-label">{label('redirect')}</p>
    <code aria-labelledby="google-redirect-label" className="block break-all rounded-md bg-muted px-3 py-2 text-sm">{window.location.origin + googleCallbackPath}</code>
    <p className="text-sm text-muted-foreground">{label('redirectHelp')}</p>
  </div>;
}
/**
 * The client ID and secret fields, shared by this section and the setup wizard's Google page. Each checks its format as
 * the owner leaves it; `rejected` marks both when Google's token endpoint refused the pair.
 */
export function GoogleClientFields({ idPrefix, rejected = false }: { idPrefix: string; rejected?: boolean }) {
  const refusal = rejected ? idPrefix + '-rejected' : undefined;
  return <>
    <Field name="clientId" id={idPrefix + '-client-id'} label={label('clientId')} maxLength={512} invalid={rejected} describedBy={refusal}/>
    <Field name="clientSecret" type="password" id={idPrefix + '-client-secret'} label={label('clientSecret')} maxLength={512} hint={label('secretHint')}
      invalid={rejected} describedBy={refusal}/>
    {refusal && <p id={refusal} className="text-sm font-medium text-destructive">{label('rejected')}</p>}
  </>;
}
/** What a save's reply says of Google's check: accepted, or saved unchecked. Both name the one thing left to try. */
export const googleCheckText = (check: GoogleLogin['check']) => label(check === 'unknown' ? 'savedUnchecked' : 'savedChecked');

/**
 * Settings → Google sign-in (owners only). When the install's configuration sets the OAuth client, the section says so
 * and offers no form. On a single-gym install without it, the owner stores the gym's own client: the client ID is shown,
 * the secret only as set, and a save replaces both or removes them. Multi-gym installs without an install client, and
 * demos, have nothing to show, and the settings page hides the empty section.
 */
export function GoogleLoginSettings() {
  const cache = useQueryClient(), gym = useGymSettings();
  const query = useGoogleLogin(true);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null), [message, setMessage] = useState<Message | null>(null), [open, setOpen] = useState(false);
  const [rejected, setRejected] = useState(false);
  if (query.isError) return <ErrorState message={label('loadError')} onRetry={() => void query.refetch()} retryLabel={label('reload')}/>;
  const google = query.data;
  if (!google || !googleSectionListed(google)) return null;

  /** Goes through the settings page's save queue with its one gym revision; the reply's revision is adopted. */
  async function change(send: (revision: number, signal: AbortSignal) => Promise<Reply>): Promise<{ status: number; reason: string | null; check?: GoogleLogin['check'] }> {
    const saved = await gym.save(async (revision, signal) => {
      const reply = await send(revision, signal);
      return { response: reply.response, data: reply.response.ok ? reply.data : reply.error };
    }, { adopt: (data, current) => ({ ...current, revision: parseResponse(googleLoginResponseSchema, data).data.revision }) });
    if (saved.status < 300) {
      const { check, ...stored } = parseResponse(googleLoginResponseSchema, saved.data).data;
      cache.setQueryData(googleLoginKey, stored);
      // The login page offers Google from the bootstrap, which now says otherwise.
      await cache.invalidateQueries({ queryKey: bootstrapKey });
      return { status: saved.status, reason: null, check };
    }
    if (saved.status === 409) await query.refetch();
    return { status: saved.status, reason: reasonOf(saved.data) };
  }
  const failure = (status: number, reason: string | null) =>
    setMessage({ kind: 'alert', text: label(reason && refusals[reason] ? refusals[reason] : status === 409 ? 'conflict' : 'error') });
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null); setRejected(false);
    const form = new FormData(event.currentTarget), field = (name: string) => String(form.get(name) ?? '').trim();
    setBusy('save');
    try {
      const reply = await change((revision, signal) => api.PUT('/api/settings/integrations/google', { signal, body: { revision, clientId: field('clientId'), clientSecret: field('clientSecret') } }));
      if (reply.status < 300) { setMessage({ kind: 'status', text: googleCheckText(reply.check) }); setOpen(false); }
      else { setRejected(reply.reason === 'google_rejected'); failure(reply.status, reply.reason); }
    } catch { setMessage({ kind: 'alert', text: label('error') }); }
    finally { setBusy(null); }
  }
  async function remove() {
    setMessage(null); setBusy('remove');
    try {
      const reply = await change((revision, signal) => api.DELETE('/api/settings/integrations/google', { signal, body: { revision } }));
      if (reply.status < 300) setMessage({ kind: 'status', text: label('removed') });
      else failure(reply.status, reply.reason);
    } catch { setMessage({ kind: 'alert', text: label('error') }); }
    finally { setBusy(null); }
  }
  const formOpen = google.editable && (google.source === 'none' || open);
  return <div className="min-w-0 space-y-3">
    <h2 className="text-lg font-semibold">{label('title')}</h2>
    {google.source === 'none' ? <p className="text-sm">{label('off')}</p> : <p className="text-sm">{label('on')}</p>}
    {google.source === 'install' && <p className="text-sm text-muted-foreground">{label('source')}</p>}
    {google.source === 'gym' && <div className="min-w-0 space-y-1 text-sm">
      <p>{label('sourceGym')}</p>
      <p className="[overflow-wrap:anywhere]">{label('clientIdShown', { clientId: google.clientId ?? '' })}</p>
      <p>{label('secretSet')}</p>
    </div>}
    {google.installProblem && <Alert variant="error" role="note">{label('installProblem.' + google.installProblem.reason, { variable: google.installProblem.variable })}</Alert>}
    {google.unreadable && <p role="alert" className="text-sm">{label('unreadable')}</p>}
    <FormMessage message={message}/>
    <GoogleRedirect/>
    {(google.source === 'gym' || google.unreadable) && <div className="grid min-w-0 gap-2">
      {google.removeBlocked && <p className="text-sm text-muted-foreground">{label('onlySignIn')}</p>}
      <div className="flex flex-col gap-3 sm:flex-row">
        {!formOpen && <Button type="button" variant="outline" disabled={busy !== null} onClick={() => { setMessage(null); setOpen(true); }}>{label('replace')}</Button>}
        <Button type="button" variant="outline" disabled={busy !== null || google.removeBlocked} onClick={() => void remove()}>{label(busy === 'remove' ? 'removing' : 'remove')}</Button>
      </div>
    </div>}
    {formOpen && <form onSubmit={(event) => void save(event)} aria-label={label(google.source === 'gym' ? 'replace' : 'setUp')}>
      <fieldset disabled={busy !== null} className="grid min-w-0 gap-4">
        <p className="text-sm text-muted-foreground">{label('setupHelp')}</p>
        <GoogleClientFields idPrefix="settings-google" rejected={rejected}/>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit">{label(busy === 'save' ? 'saving' : 'save')}</Button>
          {google.source === 'gym' && <Button type="button" variant="outline" onClick={() => setOpen(false)}>{label('cancel')}</Button>}
        </div>
      </fieldset>
    </form>}
  </div>;
}
