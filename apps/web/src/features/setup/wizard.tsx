// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetupS3Credentials } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Select } from '../../components/ui/select.js';
import { LoadingState } from '../../components/ui/states.js';
import { Card } from '../../components/ui/card.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { useShellServices, bootstrapKey } from '../../app/context.js';
import { createRegistries } from '../../lib/registries.js';
import { setupClient, type createSetupClient } from './api.js';
import { SetupActions, SetupSecondaryActions } from './actions.js';

type Client = ReturnType<typeof createSetupClient>;
const key = ['setup', 'status'];
const text = (data: FormData, name: string) => String(data.get(name) ?? '');
function destination(data: FormData): SetupS3Credentials {
  return { endpoint: text(data, 'endpoint'), region: text(data, 'region'), bucket: text(data, 'bucket'),
    accessKeyId: text(data, 'accessKeyId'), secretAccessKey: text(data, 'secretAccessKey') };
}
function Field({ name, type = 'text', value, required = true, maxLength }: {
  name: string; type?: string; value?: string; required?: boolean; maxLength?: number;
}) {
  return <div className="space-y-2"><Label htmlFor={'setup-' + name}>{t('setup/setup:' + name)}</Label>
    <Input id={'setup-' + name} name={name} type={type} defaultValue={value} required={required} maxLength={maxLength}
      minLength={name === 'password' ? 12 : undefined}
      autoComplete={type === 'password' ? 'new-password' : 'off'} /></div>;
}
function Destination() {
  return <><Field name="endpoint" type="url" /><Field name="region" value="auto" /><Field name="bucket" />
    <Field name="accessKeyId" /><Field name="secretAccessKey" type="password" /></>;
}
const FormContext = createContext<{ busy: boolean; run(action: () => Promise<void>): Promise<void> } | null>(null);
function Form({ children, action, submit = 'continue', secondary }: { children: ReactNode; action: (data: FormData) => Promise<void>; submit?: string; secondary?: ReactNode }) {
  const state = useContext(FormContext)!;
  return <form className="space-y-4" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); void state.run(() => action(data));
  }}><fieldset disabled={state.busy} className="min-w-0 space-y-4">{children}</fieldset>
    <SetupActions><Button type="submit" disabled={state.busy}>{t('setup/setup:' + (state.busy ? 'saving' : submit))}</Button>{secondary}</SetupActions></form>;
}
/** Step 6 is the registered Stripe step; step 8 is the registered import step, which finishes setup itself. */
const stripeStep = 'setupSteps.setup.stripe', finalStep = 'setupSteps.setup.import';
export function SetupWizard({ client = setupClient, registries = createRegistries() }: { client?: Client; registries?: ReturnType<typeof createRegistries> }) {
  const services = useShellServices(), queries = useQueryClient();
  const status = useQuery({ queryKey: key, queryFn: () => client.call('status'), retry: false });
  const [override, setOverride] = useState<number | null>(null);
  const step = Math.min(8, override ?? status.data?.currentStep ?? 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const registered = (id: string) => registries.setupSteps.all().find((entry) => entry.id === id && entry.enabled)?.component;
  const Stripe = registered(stripeStep), Final = registered(finalStep);
  const session = useQuery({ queryKey: bootstrapKey, queryFn: () => services.loadBootstrap(), enabled: step >= 2, retry: false });
  const catalog = useQuery({ queryKey: ['setup', 'catalog'], queryFn: () => client.catalog(), enabled: step === 3 });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState(false), [jobId, setJobId] = useState<string | null>(() => sessionStorage.getItem('setup.restore'));
  const [restoreState, setRestoreState] = useState<'running' | 'failed' | 'restored' | null>(null);
  const [sent, setSent] = useState(false);
  const [backupKey, setBackupKey] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [backupReady, setBackupReady] = useState(false), [done, setDone] = useState(false);
  const revision = status.data?.revision ?? 1;
  const refresh = async () => { setOverride(null); await status.refetch(); };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (failure) {
      setError(failure instanceof ApiError && failure.status === 403 ? 'setupLink' : failure instanceof ApiError && failure.status === 409 ? 'changed' : 'failed');
      if (failure instanceof ApiError && failure.status === 409) await refresh();
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const poll = async () => {
      try {
        const state = await client.call('restoreStatus', undefined, jobId);
        if (!alive) return;
        setRestoreState(state.status);
        if (state.status !== 'running') { sessionStorage.removeItem('setup.restore'); setJobId(null); }
      } catch { if (alive) { setError('pollFailed'); setJobId(null); } }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, jobId]);
  const complete = done || restoreState === 'restored';
  const unavailable = status.isError && !jobId && !restoreState && !done;
  useEffect(() => { heading.current?.focus(); }, [step, restore]);
  const deferBackups = <Button type="button" disabled={busy} variant="outline" onClick={() => { setBackupKey(null); setOverride(8); }}>{t('setup/setup:skipBackups')}</Button>;
  return <FormContext.Provider value={{ busy, run }}><main id="main-content" className="mx-auto w-full max-w-2xl min-w-0 flex-1 p-3 sm:p-6"><Card className="space-y-5 p-4 sm:space-y-6 sm:p-6">
    <h1 className="text-2xl font-semibold">{t('setup/setup:title')}</h1>
    {complete ? <><p role="status">{t(restoreState === 'restored' ? 'setup/setup:restored' : 'setup/setup:finished')}</p>
      <a href="/login" className="inline-flex min-h-11 items-center underline">{t('setup/setup:signIn')}</a></>
    : unavailable ? <><Alert>{t('setup/setup:unavailable')}</Alert><a href="/login" className="inline-flex min-h-11 items-center underline">{t('setup/setup:signIn')}</a></>
    : status.isPending && !jobId ? <LoadingState label={t('setup/setup:loading')} />
    : jobId || restoreState === 'running' ? <LoadingState label={t('setup/setup:restoring')} />
    : <>
      <p className="text-sm text-muted-foreground">{t('setup/setup:step')} {step + 1} / 9</p>
      <h2 ref={heading} tabIndex={-1} className="scroll-mt-4 text-xl font-semibold focus:outline-none">{t('setup/setup:step' + step)}</h2>
      {error && <Alert>{t('setup/setup:' + error)}</Alert>}
      {restoreState === 'failed' && <Alert>{t('setup/setup:restoreFailed')}</Alert>}
      {step === 0 && (restore ? <Form action={async (data) => {
        const result = await client.call('restore', { choice: 'restore', source: destination(data), snapshotPrefix: text(data, 'snapshotPrefix'), privateKey: text(data, 'privateKey') });
        setRestoreState(result.status); setJobId(result.jobId); sessionStorage.setItem('setup.restore', result.jobId);
      }} submit="restore" secondary={<Button type="button" variant="outline" disabled={busy} onClick={() => setRestore(false)}>{t('setup/setup:back')}</Button>}>
        <p>{t('setup/setup:restoreHint')}</p><Destination /><Field name="snapshotPrefix" /><Field name="privateKey" type="password" />
      </Form> : <SetupActions><Button disabled={busy} onClick={() => void run(async () => { await client.call('start', { choice: 'fresh' }); setOverride(1); })}>{t('setup/setup:fresh')}</Button>
        <Button variant="outline" onClick={() => { setRestore(true); setRestoreState(null); }}>{t('setup/setup:restore')}</Button></SetupActions>)}
      {step === 1 && <Form action={async (data) => {
        const email = text(data, 'email'), password = text(data, 'password');
        await client.call('owner', { name: text(data, 'ownerName'), email, password });
        const bootstrap = await services.loadBootstrap();
        if (bootstrap.login.password) await services.signInWithPassword(email, password);
        else { await client.magicLink(email); setSent(true); }
        await queries.invalidateQueries({ queryKey: bootstrapKey }); await refresh();
      }}><Field name="ownerName" /><Field name="email" type="email" /><Field name="password" type="password" maxLength={128} /></Form>}
      {step >= 2 && session.isPending ? <LoadingState label={t('setup/setup:loading')} />
      : step >= 2 && !session.data?.session?.roles.includes('owner') ? <>
        <p>{t('setup/setup:ownerRequired')}</p>{sent && <p role="status">{t('setup/setup:sent')}</p>}
        <Form submit="signIn" action={async (data) => {
          const email = text(data, 'email');
          if (session.data?.login.magicLink && !session.data.login.password) { await client.magicLink(email); setSent(true); }
          else { await services.signInWithPassword(email, text(data, 'password')); await session.refetch(); }
        }}><Field name="email" type="email" />{session.data?.login.password !== false && <Field name="password" type="password" maxLength={128} />}</Form>
      </> : <>
        {step === 2 && <Form action={async (data) => {
          await client.call('gym', { name: text(data, 'gymName'), timezone: text(data, 'timezone'), currency: text(data, 'currency').toUpperCase(),
            address: text(data, 'address').trim() ? { line1: text(data, 'address').trim() } : {}, branding: { logoKey: null, primaryColor: text(data, 'primaryColor') || null }, revision }); await refresh();
        }}><Field name="gymName" /><Field name="timezone" value={Intl.DateTimeFormat().resolvedOptions().timeZone} />
          <Field name="currency" value="USD" maxLength={3} /><Field name="address" required={false} /><Field name="primaryColor" type="color" value="#2563eb" /></Form>}
        {step === 3 && <Form action={async (data) => {
          const selected = data.getAll('packs').map(String);
          await client.call('packs', { revision, packs: (catalog.data ?? []).filter((pack) => selected.includes(pack.id)).map((pack) => ({ packId: pack.id, version: pack.version })) }); await refresh();
        }}><p>{t('setup/setup:packHint')}</p>{catalog.isPending ? <p>{t('setup/setup:loading')}</p>
          : catalog.isError ? <Alert>{t('setup/setup:failed')}<Button type="button" onClick={() => void catalog.refetch()}>{t('setup/setup:retry')}</Button></Alert>
          : catalog.data.map((pack) => <CheckboxField key={pack.id} name="packs" value={pack.id} label={<span>{pack.name}<span className="block text-sm font-normal">{pack.summary}</span></span>} />)}</Form>}
        {step === 4 && <Form action={async (data) => {
          await client.call('website', text(data, 'website') === 'builtin' ? { websiteEnabled: true, existingSiteUrl: null, revision }
            : { websiteEnabled: false, existingSiteUrl: text(data, 'existingSiteUrl') || null, revision }); await refresh();
        }}><Label className="flex min-h-11 items-center gap-3"><input type="radio" name="website" value="builtin" defaultChecked />{t('setup/setup:builtin')}</Label>
          <Label className="flex min-h-11 items-center gap-3"><input type="radio" name="website" value="existing" />{t('setup/setup:existing')}</Label><Field name="existingSiteUrl" type="url" required={false} />
          <p>{t('setup/setup:websiteHint')}</p><p className="font-mono text-sm">/portal · /join · /trial · /drop-in</p></Form>}
        {step === 5 && <><p>{t('setup/setup:smtpHint')}</p><p>{t('setup/setup:dnsHint')}</p><p>{t('setup/setup:loginHint')}</p>
          <Form submit="testAndSave" secondary={<Button type="button" disabled={busy} variant="outline" onClick={() => void run(async () => { await client.call('smtp', { choice: 'skip', revision }); await refresh(); })}>{t('setup/setup:skipEmail')}</Button>} action={async (data) => {
            const result = await client.call('smtp', { choice: 'configure', revision, host: text(data, 'host'), port: Number(text(data, 'port')),
              secure: data.has('secure'), username: text(data, 'username'), password: text(data, 'smtpPassword'), from: text(data, 'from'), testTo: text(data, 'testTo') });
            if (result.test === 'failed') { setError('smtpFailed'); return; } await refresh();
          }}><Label htmlFor="smtp-preset">{t('setup/setup:preset')}</Label><Select id="smtp-preset" defaultValue="" onChange={(event) => {
            const form = event.currentTarget.form;
            const host = form?.elements.namedItem('host');
            if (host instanceof HTMLInputElement) host.value = event.target.value;
          }}><option value="">{t('setup/setup:custom')}</option><option value="smtp.postmarkapp.com">Postmark</option><option value="smtp-relay.brevo.com">Brevo</option><option value="email-smtp.us-east-1.amazonaws.com">Amazon SES</option><option value="smtp.gmail.com">Gmail</option></Select>
            <Field name="host" /><Field name="port" type="number" value="587" /><CheckboxField name="secure" label={t('setup/setup:secure')} />
            <Field name="username" /><Field name="smtpPassword" type="password" /><Field name="from" type="email" /><Field name="testTo" type="email" /></Form>
          </>}
        {step === 6 && (Stripe ? <Stripe />
          : <><p>{t('setup/setup:stripeHint')}</p><SetupActions><Button disabled={busy} onClick={() => void run(async () => { await client.call('stripe', { choice: 'skip', revision }); await refresh(); })}>{t('setup/setup:continue')}</Button></SetupActions></>)}
        {step === 7 && <><p>{t('setup/setup:backupHint')}</p><p>{t('setup/setup:retention')}</p>
          {backupReady || status.data?.completedSteps.includes(7) ? <SetupActions><Button disabled={busy} onClick={() => { setBackupKey(null); setOverride(8); }}>{t('setup/setup:next')}</Button></SetupActions>
          : backupKey ? <><p>{t('setup/setup:keyWarning')}</p><pre className="overflow-x-auto rounded bg-muted p-3 text-sm">{backupKey.privateKey}</pre>
            <p className="break-all text-sm">{backupKey.publicKey}</p><Button variant="outline" onClick={() => {
              const url = URL.createObjectURL(new Blob([backupKey.privateKey + '\n'], { type: 'text/plain' }));
              const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'plaingym-backup-key.txt'; anchor.click(); URL.revokeObjectURL(url);
            }}>{t('setup/setup:downloadKey')}</Button><Form submit="confirmKey" secondary={deferBackups} action={async (data) => {
              await client.call('confirmBackupKey', { revision, privateKey: text(data, 'privateKey').trim() }); setBackupKey(null); setBackupReady(true); await refresh();
            }}><Field name="privateKey" type="password" /><CheckboxField required label={t('setup/setup:savedKey')} /></Form></>
          : <Form submit="generateKey" secondary={deferBackups} action={async (data) => { setBackupKey(await client.call('backups', { revision, destination: destination(data) })); await refresh(); }}><Destination /></Form>}
          {/* Step 8 sends `skipBackups` when the backup step was not completed. */}
          </>}
        {step === 8 && <SetupSecondaryActions.Provider value={!status.data?.completedSteps.includes(7) && <Button variant="outline" disabled={busy} onClick={() => setOverride(7)}>{t('setup/setup:backToBackups')}</Button>}>
          {Final ? <Final /> : <SetupActions><Button disabled={busy} onClick={() => void run(async () => {
            const deferred = status.data?.completedSteps.includes(7) ? {} : { skipBackups: true as const };
            await client.call('finish', { choice: 'fresh', revision, ...deferred }); setDone(true);
          })}>{t('setup/setup:finish')}</Button></SetupActions>}
        </SetupSecondaryActions.Provider>}
      </>}
    </>}
  </Card></main></FormContext.Provider>;
}
