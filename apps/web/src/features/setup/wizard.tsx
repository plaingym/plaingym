// SPDX-License-Identifier: AGPL-3.0-only
import { smtpPresets } from '../../lib/integration-setup.js';
import { createContext, useContext, useState, useEffect, useMemo, useRef, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { setupBackupConfirmRequestSchema, type GoogleClientCheck, type SetupS3Credentials } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Select } from '../../components/ui/select.js';
import { LoadingState } from '../../components/ui/states.js';
import { Card } from '../../components/ui/card.js';
import { Alert, useRevealed } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { useShellServices, bootstrapKey } from '../../app/context.js';
import { createRegistries } from '../../lib/registries.js';
import { setupClient, type createSetupClient } from './api.js';
import { SetupActions, SetupSecondaryActions } from './actions.js';
import { hostTimezone } from './host-timezone.js';
import { DraftContext, Field } from './field.js';
import { BackupKeyPanel, ConfirmKeySection, confirmKeyLabels } from './backup-key.js';
import { GoogleClientFields, GoogleRedirect } from '../settings/auth.js';

type Client = ReturnType<typeof createSetupClient>;
const key = ['setup', 'status'];
const text = (data: FormData, name: string) => String(data.get(name) ?? '');
/** A message key in the wizard's own locale file, or a full `namespace:key`. */
const say = (message: string, values?: Record<string, string>) => t(message.includes(':') ? message : 'setup/setup:' + message, values);
function destination(data: FormData): SetupS3Credentials {
  return { endpoint: text(data, 'endpoint'), region: text(data, 'region'), bucket: text(data, 'bucket'),
    accessKeyId: text(data, 'accessKeyId'), secretAccessKey: text(data, 'secretAccessKey') };
}
function Destination() {
  return <><Field name="endpoint" type="url" hint={t('setup/setup:endpointHint')} /><Field name="region" value="auto" /><Field name="bucket" />
    <Field name="accessKeyId" /><Field name="secretAccessKey" type="password" /></>;
}

/**
 * The only fields a draft keeps: names, addresses, hostnames and the storage location. Never a password, secret, key or
 * the setup token, and never a username (some SMTP services use an API token as one).
 */
const draftFields = ['gymName', 'timezone', 'currency', 'address', 'primaryColor', 'existingSiteUrl', 'host', 'port', 'from', 'endpoint', 'region', 'bucket'] as const;
interface Draft { values: Readonly<Record<string, string>>; save(form: HTMLFormElement): void; clear(): void }
/** The open step's typed, non-secret values, kept in `localStorage` per gym and step until the step saves. */
function useDraft(gymId: string | undefined, step: number): Draft {
  const storageKey = gymId ? `setup.draft.${gymId}.${step}` : null;
  const values = useMemo(() => {
    if (!storageKey) return {};
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>;
      return Object.fromEntries(draftFields.flatMap((name) => typeof stored[name] === 'string' ? [[name, stored[name]]] : []));
    } catch { return {}; }
  }, [storageKey]);
  return useMemo(() => ({ values,
    save(form) {
      if (!storageKey) return;
      const kept = Object.fromEntries(draftFields.flatMap((name) => {
        const input = form.elements.namedItem(name);
        return input instanceof HTMLInputElement && input.type !== 'password' && input.value ? [[name, input.value]] : [];
      }));
      try { if (Object.keys(kept).length) localStorage.setItem(storageKey, JSON.stringify(kept)); else localStorage.removeItem(storageKey); } catch { /* storage full or off */ }
    },
    clear() { if (storageKey) try { localStorage.removeItem(storageKey); } catch { /* storage off */ } },
  }), [storageKey, values]);
}

const FormContext = createContext<{ busy: boolean; error: string | null; run(action: () => Promise<void>): Promise<void> } | null>(null);
/**
 * A step's form. `action` returns false when the step didn't save (it set its own message); otherwise the step's draft is
 * cleared, unless `keepDraft` (the backup destination stays until its key is confirmed).
 */
function Form({ children, action, submit = 'continue', submitText, secondary, draft, keepDraft = false }: {
  children: ReactNode; action: (data: FormData) => Promise<void | false>; submit?: string; submitText?: string | undefined; secondary?: ReactNode;
  draft?: Draft | undefined; keepDraft?: boolean;
}) {
  const state = useContext(FormContext)!;
  return <form className="space-y-4" onChange={(event) => draft?.save(event.currentTarget)} onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void state.run(async () => { if (await action(data) !== false && !keepDraft) draft?.clear(); });
  }}><DraftContext.Provider value={draft?.values ?? {}}><fieldset disabled={state.busy} className="min-w-0 space-y-4">{children}</fieldset></DraftContext.Provider>
    <SetupActions>{state.error && <p className="w-full text-sm font-medium">{t('setup/setup:seeError')}</p>}
      <Button type="submit" disabled={state.busy}>{state.busy ? t('setup/setup:saving') : submitText ?? t('setup/setup:' + submit)}</Button>{secondary}</SetupActions></form>;
}
/**
 * A step that worked waits here, with what it did, until the owner continues (the server has already moved on). Only
 * the email test's address and Google's answer are held, never a secret.
 */
type Held = { kind: 'email'; to: string } | { kind: 'google'; check: GoogleClientCheck } | { kind: 'backups' };
const heldStep = { email: 5, google: 6, backups: 7 } as const;
/** Step 6 is the registered Stripe step; step 8 is the registered import step, which finishes setup itself. */
const stripeStep = 'setupSteps.setup.stripe', finalStep = 'setupSteps.setup.import';
export function SetupWizard({ client = setupClient, registries = createRegistries() }: { client?: Client; registries?: ReturnType<typeof createRegistries> }) {
  const services = useShellServices(), queries = useQueryClient();
  const status = useQuery({ queryKey: key, queryFn: () => client.call('status'), retry: false });
  const [override, setOverride] = useState<number | null>(null), [held, setHeld] = useState<Held | null>(null);
  const step = Math.min(8, held ? heldStep[held.kind] : override ?? status.data?.currentStep ?? 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const registered = (id: string) => registries.setupSteps.all().find((entry) => entry.id === id && entry.enabled)?.component;
  const Stripe = registered(stripeStep), Final = registered(finalStep);
  const session = useQuery({ queryKey: bootstrapKey, queryFn: () => services.loadBootstrap(), enabled: step >= 2, retry: false });
  const catalog = useQuery({ queryKey: ['setup', 'catalog'], queryFn: () => client.catalog(), enabled: step === 3 });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const errorBox = useRevealed<HTMLDivElement>(error);
  const [restore, setRestore] = useState(false), [jobId, setJobId] = useState<string | null>(() => sessionStorage.getItem('setup.restore'));
  const [restoreState, setRestoreState] = useState<'running' | 'failed' | 'restored' | null>(null);
  const [sent, setSent] = useState(false);
  const [hostZone] = useState(hostTimezone), [zoneEdited, setZoneEdited] = useState(false);
  // The new key pair lives only in this component's state until the owner confirms it.
  const [backupKey, setBackupKey] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [done, setDone] = useState(false);
  // Saved in this visit: the page stays gone even before the refreshed bootstrap says Google sign-in is on.
  const [googleSaved, setGoogleSaved] = useState(false);
  const draft = useDraft(step >= 2 ? session.data?.gym?.id : undefined, step);
  // The optional Google page after the email step: shown until saved or skipped (recorded on the server), and never when
  // Google sign-in is already on (the install's configuration sets it) or payments are done.
  const googlePage = held?.kind === 'google' || (step === 6 && !held && !googleSaved && session.data !== undefined && session.data.login.google !== true
    && status.data?.googleSkipped !== true && !status.data?.completedSteps.includes(6));
  const revision = status.data?.revision ?? 1;
  const refresh = async () => { setOverride(null); await status.refetch(); };
  const proceed = () => { setHeld(null); void refresh(); };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (failure) {
      const reasons = failure instanceof ApiError ? failure.reason : [];
      setError(failure instanceof ApiError && failure.status === 403 ? 'setupLink' : failure instanceof ApiError && failure.status === 409 ? 'changed'
        : reasons.includes('unreachable') ? 'unreachable' : reasons.includes('google_rejected') ? 'googleRejected' : 'failed');
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
  useEffect(() => { heading.current?.focus(); }, [step, restore, googlePage, held]);
  const deferBackups = <Button type="button" disabled={busy} variant="outline" onClick={() => void run(async () => {
    await client.call('decide', { revision, decision: 'backups_later' }); setBackupKey(null); draft.clear(); await refresh();
  })}>{t('setup/setup:skipBackups')}</Button>;
  const backToBackups = () => status.data?.backupsLater
    ? void run(async () => { await client.call('decide', { revision, decision: 'backups_now' }); await refresh(); }) : setOverride(7);
  const continueHeld = <SetupActions><Button onClick={proceed}>{t('setup/setup:next')}</Button></SetupActions>;
  return <FormContext.Provider value={{ busy, error, run }}><main id="main-content" className="mx-auto w-full max-w-2xl min-w-0 flex-1 p-3 sm:p-6"><Card className="space-y-5 p-4 sm:space-y-6 sm:p-6">
    <h1 className="text-2xl font-semibold">{t('setup/setup:title')}</h1>
    {complete ? <><p role="status">{t(restoreState === 'restored' ? 'setup/setup:restored' : 'setup/setup:finished')}</p>
      <a href="/login" className="inline-flex min-h-11 items-center underline">{t('setup/setup:signIn')}</a></>
    : unavailable ? <><Alert>{t('setup/setup:unavailable')}</Alert><a href="/login" className="inline-flex min-h-11 items-center underline">{t('setup/setup:signIn')}</a></>
    : status.isPending && !jobId ? <LoadingState label={t('setup/setup:loading')} />
    : jobId || restoreState === 'running' ? <LoadingState label={t('setup/setup:restoring')} />
    : <>
      <p className="text-sm text-muted-foreground">{t('setup/setup:step')} {(googlePage ? 5 : step) + 1} / 9</p>
      <h2 ref={heading} tabIndex={-1} className="scroll-mt-4 text-xl font-semibold focus:outline-none">{googlePage ? t('setup/google-step:title') : t('setup/setup:step' + step)}</h2>
      {error && <Alert ref={errorBox} tabIndex={-1} variant="error">{say(error)}</Alert>}
      {restoreState === 'failed' && <Alert variant="error">{t('setup/setup:restoreFailed')}</Alert>}
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
      }}><Field name="ownerName" /><Field name="email" type="email" /><Field name="password" type="password" minLength={12} maxLength={128} /></Form>}
      {step >= 2 && session.isPending ? <LoadingState label={t('setup/setup:loading')} />
      : step >= 2 && !session.data?.session?.roles.includes('owner') ? <>
        <p>{t('setup/setup:ownerRequired')}</p>{sent && <p role="status">{t('setup/setup:sent')}</p>}
        <Form submit="signIn" action={async (data) => {
          const email = text(data, 'email');
          if (session.data?.login.magicLink && !session.data.login.password) { await client.magicLink(email); setSent(true); }
          else { await services.signInWithPassword(email, text(data, 'password')); await session.refetch(); }
        }}><Field name="email" type="email" />{session.data?.login.password !== false && <Field name="password" type="password" check={null} minLength={12} maxLength={128} />}</Form>
      </> : <>
        {step === 2 && <Form draft={draft} action={async (data) => {
          await client.call('gym', { name: text(data, 'gymName'), timezone: text(data, 'timezone'), currency: text(data, 'currency').toUpperCase(),
            address: text(data, 'address').trim() ? { line1: text(data, 'address').trim() } : {}, branding: { logoKey: null, primaryColor: text(data, 'primaryColor') || null }, revision }); await refresh();
        }}><Field name="gymName" /><Field name="timezone" value={hostZone.zone} hint={hostZone.fallback && !zoneEdited ? t('setup/setup:timezoneFallback') : undefined} onEdit={() => setZoneEdited(true)} />
          <Field name="currency" value="USD" maxLength={3} /><Field name="address" required={false} /><Field name="primaryColor" type="color" value="#2563eb" check={null} /></Form>}
        {step === 3 && <Form action={async (data) => {
          const selected = data.getAll('packs').map(String);
          await client.call('packs', { revision, packs: (catalog.data ?? []).filter((pack) => selected.includes(pack.id)).map((pack) => ({ packId: pack.id, version: pack.version })) }); await refresh();
        }}><p>{t('setup/setup:packHint')}</p>{catalog.isPending ? <p>{t('setup/setup:loading')}</p>
          : catalog.isError ? <Alert variant="error"><p>{t('setup/setup:failed')}</p><Button type="button" onClick={() => void catalog.refetch()}>{t('setup/setup:retry')}</Button></Alert>
          : catalog.data.map((pack) => <CheckboxField key={pack.id} name="packs" value={pack.id} label={<span>{pack.name}<span className="block text-sm font-normal">{pack.summary}</span></span>} />)}</Form>}
        {step === 4 && <Form draft={draft} action={async (data) => {
          await client.call('website', text(data, 'website') === 'builtin' ? { websiteEnabled: true, existingSiteUrl: null, revision }
            : { websiteEnabled: false, existingSiteUrl: text(data, 'existingSiteUrl') || null, revision }); await refresh();
        }}>{/* A draft that kept a site address reopens on "I already have a website", so saving doesn't drop the address. */}
          <Label className="flex min-h-11 items-center gap-3"><input type="radio" name="website" value="builtin" defaultChecked={!draft.values.existingSiteUrl} />{t('setup/setup:builtin')}</Label>
          <Label className="flex min-h-11 items-center gap-3"><input type="radio" name="website" value="existing" defaultChecked={Boolean(draft.values.existingSiteUrl)} />{t('setup/setup:existing')}</Label><Field name="existingSiteUrl" type="url" required={false} />
          <p>{t('setup/setup:websiteHint')}</p><p className="font-mono text-sm">/portal · /join · /trial · /drop-in</p></Form>}
        {step === 5 && (held?.kind === 'email' ? <><p role="status">{t('setup/setup:emailSent', { address: held.to })}</p>{continueHeld}</>
          : <><p>{t('setup/setup:smtpHint')}</p><p>{t('setup/setup:dnsHint')}</p><p>{t('setup/setup:loginHint')}</p>
          <Form draft={draft} submit="testAndSave" secondary={<Button type="button" disabled={busy} variant="outline" onClick={() => void run(async () => { await client.call('smtp', { choice: 'skip', revision }); draft.clear(); await refresh(); })}>{t('setup/setup:skipEmail')}</Button>} action={async (data) => {
            const testTo = text(data, 'testTo');
            const result = await client.call('smtp', { choice: 'configure', revision, host: text(data, 'host'), port: Number(text(data, 'port')),
              secure: data.has('secure'), username: text(data, 'username'), password: text(data, 'smtpPassword'), from: text(data, 'from'), testTo });
            if (result.test === 'failed') { setError('smtpFailed'); return false; }
            // The settings are saved and the server has moved on; this screen stays until the owner continues.
            setHeld({ kind: 'email', to: testTo }); await refresh();
          }}><Label htmlFor="smtp-preset">{t('setup/setup:preset')}</Label><Select id="smtp-preset" defaultValue="" onChange={(event) => {
            const form = event.currentTarget.form;
            const host = form?.elements.namedItem('host');
            if (host instanceof HTMLInputElement) host.value = event.target.value;
          }}><option value="">{t('setup/setup:custom')}</option>{smtpPresets.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</Select>
            <Field name="host" /><Field name="port" type="number" value="587" hint={t('setup/setup:portHint')} /><CheckboxField name="secure" label={t('setup/setup:secure')} />
            <Field name="username" /><Field name="smtpPassword" type="password" /><Field name="from" type="email" /><Field name="testTo" type="email" /></Form>
          </>)}
        {googlePage && (held?.kind === 'google' ? <><p role="status">{t(held.check === 'unknown' ? 'setup/google-step:unchecked' : 'setup/google-step:saved')}</p>{continueHeld}</>
          : <Form submit="saveGoogle" secondary={<Button type="button" disabled={busy} variant="outline" onClick={() => void run(async () => {
            await client.call('decide', { revision, decision: 'skip_google' }); await refresh();
          })}>{t('setup/google-step:skip')}</Button>} action={async (data) => {
            const result = await client.call('google', { revision, clientId: text(data, 'clientId').trim(), clientSecret: text(data, 'clientSecret').trim() });
            setGoogleSaved(true); setHeld({ kind: 'google', check: result.check }); await queries.invalidateQueries({ queryKey: bootstrapKey }); await refresh();
          }}><p>{t('setup/google-step:intro')}</p><GoogleRedirect /><p className="text-sm text-muted-foreground">{t('auth/google:setupHelp')}</p>
            <GoogleClientFields idPrefix="setup-google" rejected={error === 'googleRejected'} /></Form>)}
        {step === 6 && !googlePage && (Stripe ? <Stripe />
          : <><p>{t('setup/setup:stripeHint')}</p><SetupActions><Button disabled={busy} onClick={() => void run(async () => { await client.call('stripe', { choice: 'skip', revision }); await refresh(); })}>{t('setup/setup:continue')}</Button></SetupActions></>)}
        {step === 7 && <><p>{t('setup/setup:backupHint')}</p><p>{t('setup/setup:retention')}</p>
          {held?.kind === 'backups' ? <><p role="status">{t('setup/setup:backupsOn')}</p>{continueHeld}</>
          : backupKey ? <><BackupKeyPanel idPrefix="setup-backup" privateKey={backupKey.privateKey} publicKey={backupKey.publicKey} closingReplaces />
            <ConfirmKeySection idPrefix="setup-backup"><Form submitText={confirmKeyLabels.submit()} secondary={deferBackups} action={async (data) => {
              const privateKey = text(data, 'privateKey').trim();
              const mismatch = () => { setError('setup/backup-key:mismatch'); return false as const; };
              if (!setupBackupConfirmRequestSchema.safeParse({ revision, privateKey }).success) return mismatch();
              try { await client.call('confirmBackupKey', { revision, privateKey }); }
              catch (failure) { if (failure instanceof ApiError && failure.status === 400) return mismatch(); throw failure; }
              setBackupKey(null); draft.clear(); setHeld({ kind: 'backups' }); await refresh();
            }}><Field name="privateKey" id="setup-confirm-key" type="password" check={null} label={confirmKeyLabels.field()} /><CheckboxField required label={t('setup/setup:savedKey')} /></Form></ConfirmKeySection></>
          : <Form draft={draft} keepDraft submit="generateKey" secondary={deferBackups} action={async (data) => { setBackupKey(await client.call('backups', { revision, destination: destination(data) })); await refresh(); }}><Destination /></Form>}
          {/* Step 8 sends `skipBackups` when the backup step was not completed. */}
          </>}
        {step === 8 && <SetupSecondaryActions.Provider value={!status.data?.completedSteps.includes(7) && <Button variant="outline" disabled={busy} onClick={backToBackups}>{t('setup/setup:backToBackups')}</Button>}>
          {Final ? <Final /> : <SetupActions><Button disabled={busy} onClick={() => void run(async () => {
            const deferred = status.data?.completedSteps.includes(7) ? {} : { skipBackups: true as const };
            await client.call('finish', { choice: 'fresh', revision, ...deferred }); setDone(true);
          })}>{t('setup/setup:finish')}</Button></SetupActions>}
        </SetupSecondaryActions.Provider>}
      </>}
    </>}
  </Card></main></FormContext.Provider>;
}
