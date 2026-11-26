// SPDX-License-Identifier: AGPL-3.0-only
import { smtpPresets } from '../../lib/integration-setup.js';
import { createContext, useCallback, useContext, useState, useEffect, useMemo, useRef, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { setupBackupConfirmRequestSchema, type GoogleClientCheck, type SetupRestoreFailureReason, type SetupRestoreResponse, type SetupS3Credentials } from '@plaingym/shared/contracts';
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
import { takeBucketAddress } from './checks.js';
import { SetupFinishingContext, SetupHoldContext } from './hold.js';
import { SmtpPortHint } from './smtp-port-hint.js';
import { BackupKeyPanel, ConfirmKeySection, confirmKeyLabels } from './backup-key.js';
import { GoogleClientFields, GoogleRedirect } from '../settings/auth.js';

type Client = ReturnType<typeof createSetupClient>;
const key = ['setup', 'status'];
/** Sign-in or magic-link failure after the owner account was already saved on step 1. */
class OwnerSavedSignInError extends Error {
  constructor(options?: ErrorOptions) {
    super('Owner saved; sign-in failed', options);
    this.name = 'OwnerSavedSignInError';
  }
}
/** A restore request that may be running: after no definite answer, a status read or a resend's refusal suggests it. */
class RestoreUnansweredError extends Error {
  constructor(options?: ErrorOptions) {
    super('Restore request unanswered', options);
    this.name = 'RestoreUnansweredError';
  }
}
/** How long the status read after an unanswered restore request is waited for before the form shows the save error. */
const restoreReadLimit = 10_000;
const text = (data: FormData, name: string) => String(data.get(name) ?? '');
/** A message key in the wizard's own locale file, or a full `namespace:key`. */
const say = (message: string, values?: Record<string, string>) => t(message.includes(':') ? message : 'setup/setup:' + message, values);
function destination(data: FormData): SetupS3Credentials {
  return { endpoint: text(data, 'endpoint'), region: text(data, 'region'), bucket: text(data, 'bucket'),
    accessKeyId: text(data, 'accessKeyId'), secretAccessKey: text(data, 'secretAccessKey') };
}
const bucketRecheck = ['bucket'] as const;
function Destination() {
  /** R2's per-bucket address fills both fields, unless the owner has already typed another bucket. */
  const takeBucket = (input: HTMLInputElement) => {
    const bucket = takeBucketAddress(input);
    return bucket !== null ? t('setup/setup:check.bucketFromEndpoint', { bucket }) : null;
  };
  return <><Field name="endpoint" type="url" hint={t('setup/setup:endpointHint')} onLeave={takeBucket} recheckWith={bucketRecheck} />
    <Field name="region" value="auto" /><Field name="bucket" />
    <Field name="accessKeyId" confirmOk={false} /><Field name="secretAccessKey" type="password" confirmOk={false} /></>;
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
 * the email test's address, Google's answer, and the Stripe step's mode and webhook flag are held, never a secret or key.
 */
type Held = { kind: 'email'; to: string } | { kind: 'google'; check: GoogleClientCheck } | { kind: 'stripe'; mode: 'test' | 'live' | null; webhookRegistered: boolean } | { kind: 'backups' };
const heldStep = { email: 5, google: 6, stripe: 6, backups: 7 } as const;
/** Step 6 is the registered Stripe step; step 8 is the registered import step, which finishes setup itself. */
const stripeStep = 'setupSteps.setup.stripe', finalStep = 'setupSteps.setup.import';
/** Routes an existing website links to: paths, not translatable text. */
const appPaths = ['/portal', '/join', '/trial', '/drop-in'].join(' · ');
export function SetupWizard({ client = setupClient, registries = createRegistries() }: { client?: Client; registries?: ReturnType<typeof createRegistries> }) {
  const services = useShellServices(), queries = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(() => sessionStorage.getItem('setup.restore'));
  const [restoreSending, setRestoreSending] = useState(false);
  // A restore request got no answer, then a status read met a restore's hold, or a resend failed without ruling out
  // that restore: the form stays.
  const [restoreUnanswered, setRestoreUnanswered] = useState(false);
  // When the last restore request went unanswered, until a status read works: a later 404 or 503 keeps the form too.
  const [unansweredAt, setUnansweredAt] = useState<number | null>(null);
  // The status read failures counted when a resend after an unanswered request failed with its own message; a later read
  // that meets a restore's hold brings the "may be running" message back.
  const [failedAtReads, setFailedAtReads] = useState<number | null>(null);
  // A restore, from its request on, makes the status answer 404, and that answer would outlive a restore that then fails.
  const status = useQuery({ queryKey: key, queryFn: () => client.call('status'), retry: false,
    refetchOnWindowFocus: !jobId && !restoreSending, refetchOnReconnect: !jobId && !restoreSending });
  const [override, setOverride] = useState<number | null>(null), [held, setHeld] = useState<Held | null>(null);
  // Saved in this visit: while the status can't be reloaded its old answer would bring the owner form back.
  const [ownerSaved, setOwnerSaved] = useState(false);
  const step = Math.min(8, held ? heldStep[held.kind]
    : override ?? Math.max(status.data?.currentStep ?? 0, ownerSaved && status.isError ? 2 : 0));
  const heading = useRef<HTMLHeadingElement>(null);
  const registered = (id: string) => registries.setupSteps.all().find((entry) => entry.id === id && entry.enabled)?.component;
  const Stripe = registered(stripeStep), Final = registered(finalStep);
  const session = useQuery({ queryKey: bootstrapKey, queryFn: () => services.loadBootstrap(), enabled: step >= 2, retry: false });
  const catalog = useQuery({ queryKey: ['setup', 'catalog'], queryFn: () => client.catalog(), enabled: step === 3 });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // Counts the failed status reloads the owner asked for: each takes focus to the reload alert, and nothing else does.
  const [failedReloads, setFailedReloads] = useState(0);
  const reloadBox = useRevealed<HTMLDivElement>(failedReloads);
  // A save refused as stale whose reload failed: the owner is told once a later status read works.
  const [conflictPending, setConflictPending] = useState(false);
  // That late message leaves the focus alone when the owner has put it somewhere else by then.
  const [quietError, setQuietError] = useState(false);
  const errorBox = useRevealed<HTMLDivElement>(quietError ? null : error);
  const [restore, setRestore] = useState(false);
  const [restoreState, setRestoreState] = useState<'running' | 'failed' | 'restored' | null>(null);
  const [restoreFailure, setRestoreFailure] = useState<{ reason: SetupRestoreFailureReason; staged: boolean } | null>(null);
  // The last `running` answer's phase; null until one arrives (after a reload, say), so an unreachable server isn't guessed at.
  const [phase, setPhase] = useState<string | null>(null), [unreachable, setUnreachable] = useState(false), [throttled, setThrottled] = useState(false);
  const restoreAnswer = useCallback((state: SetupRestoreResponse['data']) => {
    setRestoreState(state.status);
    if (state.status === 'failed') setRestoreFailure({ reason: state.reason, staged: state.staged });
    if (state.status === 'running') setPhase(state.phase);
  }, []);
  // The job a poll last settled for: switching between answering and unreachable only changes the interval, without an extra poll.
  const polledJob = useRef<string | null>(null);
  // The website step's choice once the owner picks one; until then the draft's.
  const [siteChoice, setSiteChoice] = useState<'builtin' | 'existing' | null>(null);
  // Reopened, the step's radios start again from the draft, so the address follows the draft too.
  useEffect(() => setSiteChoice(null), [step]);
  const [sent, setSent] = useState(false);
  const [hostZone] = useState(hostTimezone), [zoneEdited, setZoneEdited] = useState(false);
  // The new key pair lives only in this component's state until the owner confirms it.
  const [backupKey, setBackupKey] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [done, setDone] = useState(false);
  const [finalFinishing, setFinalFinishing] = useState(false);
  // Saved in this visit: the page stays gone even before the refreshed bootstrap says Google sign-in is on.
  const [googleSaved, setGoogleSaved] = useState(false);
  const draft = useDraft(step >= 2 ? session.data?.gym?.id : undefined, step);
  const ownSite = (siteChoice ?? (draft.values.existingSiteUrl ? 'existing' : 'builtin')) === 'existing';
  // The optional Google page after the email step: shown until saved or skipped (recorded on the server), and never when
  // Google sign-in is already on (the install's configuration sets it) or payments are done.
  const googlePage = held?.kind === 'google' || (step === 6 && !held && !googleSaved && session.data !== undefined && session.data.login.google !== true
    && status.data?.googleSkipped !== true && !status.data?.completedSteps.includes(6));
  const revision = status.data?.revision ?? 1;
  const readAgain = async () => {
    const result = await status.refetch();
    if (result.isError) setFailedReloads((count) => count + 1);
    return result;
  };
  const refresh = () => { setOverride(null); return readAgain(); };
  const proceed = () => { setHeld(null); void refresh(); };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null); setConflictPending(false); setQuietError(false);
    try { await action(); }
    catch (failure) {
      const reasons = failure instanceof ApiError ? failure.reason : [];
      const emailUnavailable = failure instanceof ApiError && failure.status === 503 && failure.code === 'EMAIL_UNAVAILABLE';
      // No link went out this time, so an earlier "check your inbox" note would contradict the alert.
      if (emailUnavailable) setSent(false);
      if (failure instanceof ApiError && failure.status === 409) {
        // "Your progress has been refreshed" only when it was; otherwise the reload alert says what failed.
        const reloaded = await refresh();
        if (reloaded.isError) { setError(null); setConflictPending(true); } else setError('changed');
      } else setError(failure instanceof RestoreUnansweredError ? 'restoreUnanswered'
        : failure instanceof OwnerSavedSignInError ? 'ownerSavedSignInFailed'
        : emailUnavailable ? 'emailUnavailable'
        : failure instanceof ApiError && failure.status === 429 ? 'rateLimited'
        : failure instanceof ApiError && failure.status === 403 ? 'setupLink'
        : reasons.includes('unreachable') ? 'unreachable' : reasons.includes('google_rejected') ? 'googleRejected' : 'failed');
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    // A read already running may have met the restore's hold, and a refetch would join one that has no data yet.
    const reread = async () => { await queries.cancelQueries({ queryKey: key }); await queries.refetchQueries({ queryKey: key }); };
    const poll = async () => {
      try {
        const state = await client.call('restoreStatus', undefined, jobId);
        if (!alive) return;
        polledJob.current = jobId;
        setUnreachable(false);
        setThrottled(false);
        restoreAnswer(state);
        if (state.status !== 'running') { sessionStorage.removeItem('setup.restore'); setJobId(null); }
        // A status read that met the restore's hold on the gym answers 404, which says nothing once the restore has failed.
        const read = queries.getQueryState(key);
        if (state.status === 'failed' && (read?.status === 'error' || read?.fetchStatus === 'fetching')) void reread();
      } catch (failure) {
        if (!alive) return;
        polledJob.current = jobId;
        // Rate limited: not an answer about the restore, so the view stays as it is and the checks slow down.
        if (failure instanceof ApiError && failure.status === 429) { setThrottled(true); return; }
        // No answer, the proxy's answer for an app that is down, or a server error: the restore may still be running, so keep checking.
        if (failure instanceof TypeError || (failure instanceof ApiError && failure.status >= 500)) { setUnreachable(true); return; }
        setError('pollFailed'); setJobId(null); setRestoreState(null); setUnreachable(false); setThrottled(false); sessionStorage.removeItem('setup.restore');
        // A cached 404 from while the restore held the gym would hide that message.
        void reread();
      }
    };
    if (polledJob.current !== jobId) void poll();
    const timer = setInterval(() => { void poll(); }, unreachable || throttled ? 5000 : 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, queries, jobId, unreachable, throttled, restoreAnswer]);
  const complete = done || restoreState === 'restored';
  const finished = status.error instanceof ApiError && status.error.status === 404;
  // The status read answers 503 while a restore holds the server: the reload alert says so only for the app's own
  // answer (code `unavailable`), since a proxy in front of the install can answer 503 too. After an unanswered restore
  // request the form stays for any 503.
  const gateClosed = status.error instanceof ApiError && status.error.status === 503;
  const restoreHold = status.error instanceof ApiError && status.error.status === 503 && status.error.code === 'unavailable';
  // With no status data, any restore answer keeps its screen. Once the status was read, a 404 ends the steps unless a
  // restore is running, done, or failed with a staged copy while step 0 is still on screen.
  const stagedFailure = restoreState === 'failed' && Boolean(restoreFailure?.staged) && step === 0;
  const restoreStays = finished && status.data ? restoreState === 'running' || restoreState === 'restored' || stagedFailure
    : Boolean(restoreState);
  // Known in the render where the 404 or 503 arrives, so the form is never swapped out and keeps its values.
  const awaitingAnswer = unansweredAt !== null && (finished || gateClosed);
  const noSteps = !jobId && !restoreSending && !restoreUnanswered && !awaitingAnswer && !done && !finalFinishing && !restoreStays;
  const unavailable = finished && noSteps;
  // A first read that failed for any other reason says nothing about the install, so it offers only another try.
  const loadFailed = status.isError && !status.data && !finished && noSteps;
  const reloadShown = loadFailed || (status.isError && Boolean(status.data) && !finished && !awaitingAnswer && !finalFinishing)
    // Beside a failed restore with no status behind it too, so the steps never pass as if the status were known.
    || (status.isError && !status.data && !finished && restoreState === 'failed');
  // Before the heading's effect: after a retry removed the reload alert, the message takes the focus nothing else holds.
  useEffect(() => {
    if (!conflictPending || status.isError || !status.data) return;
    setQuietError(document.activeElement !== null && document.activeElement !== document.body);
    setConflictPending(false); setError('changed');
  }, [conflictPending, status.data, status.dataUpdatedAt, status.isError]);
  // The reload alert and a save error are focused by earlier effects: a step that changes along with one, or after it,
  // must not take the focus back.
  useEffect(() => {
    if (!reloadBox.current?.contains(document.activeElement) && !errorBox.current?.contains(document.activeElement)) heading.current?.focus();
  }, [step, restore, googlePage, held, reloadBox, errorBox]);
  // A retry from the first-load error or the unavailable screen swaps that screen out, so focus goes to what replaces it.
  const retried = useRef(false), unavailableBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!retried.current || status.fetchStatus !== 'idle') return;
    retried.current = false;
    if (unavailable) unavailableBox.current?.focus();
    // A failed read's reload alert takes the focus through `failedReloads`.
    else if (!reloadShown) heading.current?.focus();
    // The error count and the screens also change when a read settles before its loading state was ever rendered.
  }, [status.fetchStatus, status.errorUpdateCount, unavailable, reloadShown]);
  // Back from the restore form onto the unavailable screen: the screen is there at once, so its focus waits for no read.
  const backedOut = useRef(false);
  useEffect(() => {
    if (!backedOut.current) return;
    backedOut.current = false;
    unavailableBox.current?.focus();
  }, [restore]);
  // A 404 or 503 read after the request's own wait was over: its message replaces the earlier error, and takes the focus
  // only when nothing else holds it, as after a retry removed the reload alert. A message a failed resend left on screen
  // takes the focus the same way. While a request is being sent, its own action decides the message and takes the focus
  // to it.
  useEffect(() => {
    if (!awaitingAnswer || restoreSending) return;
    const unfocused = document.activeElement === null || document.activeElement === document.body;
    if (restoreUnanswered) { if (unfocused) errorBox.current?.focus(); return; }
    setQuietError(!unfocused); setRestoreUnanswered(true); setError('restoreUnanswered');
  }, [awaitingAnswer, restoreSending, restoreUnanswered, errorBox]);
  // That resend's message is replaced once a read that failed after it meets the hold. The read count is watched only
  // here, so a further read with the same answer doesn't pull the focus back to a message already shown.
  useEffect(() => {
    if (!awaitingAnswer || restoreSending || failedAtReads === null || status.errorUpdateCount <= failedAtReads) return;
    setFailedAtReads(null); setQuietError(document.activeElement !== null && document.activeElement !== document.body);
    setError('restoreUnanswered');
  }, [awaitingAnswer, restoreSending, failedAtReads, status.errorUpdateCount]);
  // A status read that works ends the unanswered state and its message, so a still later 404 is news of its own.
  useEffect(() => {
    if (!status.isSuccess || unansweredAt === null || status.dataUpdatedAt < unansweredAt) return;
    setUnansweredAt(null); setFailedAtReads(null); setRestoreUnanswered(false);
    // Removing the focused message would leave the focus on the page body, so the step's heading takes it.
    if (error === 'restoreUnanswered' && errorBox.current?.contains(document.activeElement)) heading.current?.focus();
    setError((shown) => shown === 'restoreUnanswered' ? null : shown);
  }, [status.isSuccess, status.dataUpdatedAt, unansweredAt, error, errorBox]);
  const retryStatus = <Button type="button" disabled={status.isFetching}
    onClick={() => { retried.current = unavailable || !status.data; void readAgain(); }}>{t('setup/setup:retry')}</Button>;
  const reloadAlert = <Alert ref={reloadBox} variant="error"><p>{t(restoreHold ? 'setup/setup:restoreHeld' : 'setup/setup:reloadFailed')}</p>{retryStatus}</Alert>;
  const deferBackups = <Button type="button" disabled={busy} variant="outline" onClick={() => void run(async () => {
    await client.call('decide', { revision, decision: 'backups_later' }); setBackupKey(null); draft.clear(); await refresh();
  })}>{t('setup/setup:skipBackups')}</Button>;
  const backToBackups = () => status.data?.backupsLater
    ? void run(async () => { await client.call('decide', { revision, decision: 'backups_now' }); await refresh(); }) : setOverride(7);
  const continueHeld = <SetupActions><Button onClick={proceed}>{t('setup/setup:next')}</Button></SetupActions>;
  return <FormContext.Provider value={{ busy, error, run }}><main id="main-content" className="mx-auto w-full max-w-2xl min-w-0 flex-1 p-3 sm:p-6"><Card className="space-y-5 p-4 sm:space-y-6 sm:p-6">
    <h1 className="text-2xl font-semibold">{t('setup/setup:title')}</h1>
    {complete ? <><h2 className="text-xl font-semibold">{t('setup/setup:completeTitle')}</h2><p role="status">{t(restoreState === 'restored' ? 'setup/setup:restored' : 'setup/setup:finished')}</p>
      {restoreState === 'restored' ? <Button asChild><a href="/login">{t('setup/setup:signIn')}</a></Button>
        : <Button asChild><a href="/admin">{t('setup/setup:openAdmin')}</a></Button>}</>
    : unavailable ? <><Alert ref={unavailableBox} tabIndex={-1} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('setup/setup:unavailable')}</Alert><div className="flex flex-wrap items-center gap-4">{retryStatus}
      <a href="/login" className="inline-flex min-h-11 items-center underline">{t('setup/setup:signIn')}</a></div></>
    : loadFailed ? reloadAlert
    : status.isPending && !jobId ? <LoadingState label={t('setup/setup:loading')} />
    : jobId || restoreState === 'running' ? unreachable
      ? <Alert role="status"><p>{t('setup/setup:restoreUnreachable')}</p>
        {phase && <p>{t(phase === 'verifying' ? 'setup/setup:restoreUnreachableVerifying' : 'setup/setup:restoreUnreachableStaged')}</p>}</Alert>
      : <LoadingState label={t('setup/setup:restoring')} />
    : <>
      {reloadShown && reloadAlert}
      <p className="text-sm text-muted-foreground">{t('setup/setup:step')} {googlePage ? t('setup/setup:googleStepNumber') : step + 1} / 9</p>
      <h2 ref={heading} tabIndex={-1} className="scroll-mt-4 text-xl font-semibold focus:outline-none">{googlePage ? t('setup/google-step:title') : t('setup/setup:step' + step)}</h2>
      {error && <Alert ref={errorBox} tabIndex={-1} variant="error">{say(error)}</Alert>}
      {/* A failed restore is step 0's news: once the owner starts fresh, later steps don't repeat it. */}
      {step === 0 && (restoreFailure ? <Alert variant="error"><p>{t('setup/setup:restoreFailure.' + restoreFailure.reason)}</p>
        {restoreFailure.staged && <p>{t('setup/setup:restoreStaged')}</p>}</Alert>
        : restoreState === 'failed' && <Alert variant="error">{t('setup/setup:restoreFailed')}</Alert>)}
      {step === 0 && (restore ? <Form action={async (data) => {
        // The request takes the restore's hold on the gym: no status read runs until it has answered.
        const wasUnanswered = restoreUnanswered || unansweredAt !== null;
        setRestoreSending(true); setRestoreUnanswered(false); setUnansweredAt(null); setFailedAtReads(null); await queries.cancelQueries({ queryKey: key });
        try {
          const result = await client.call('restore', { choice: 'restore', source: destination(data), snapshotPrefix: text(data, 'snapshotPrefix'), privateKey: text(data, 'privateKey') });
          setRestoreFailure(null); setUnreachable(false); setThrottled(false); setPhase(null);
          restoreAnswer(result); setJobId(result.jobId); sessionStorage.setItem('setup.restore', result.jobId);
        } catch (failure) {
          // No answer, or a proxy's (its own 503 page lacks the app's code), doesn't say the server refused the restore.
          const unanswered = failure instanceof TypeError || (failure instanceof ApiError && ([502, 504, 520, 522, 524].includes(failure.status) || (failure.status === 503 && failure.code !== 'unavailable')));
          if (!unanswered) {
            // After an unanswered request, a 409 (a restore is already running) or a 404 (it holds the gym, or has
            // closed setup) is most likely that restore's doing. Any other refusal (a 400 for the snapshot ID and a 403
            // for the setup link are checked before a running restore is; a 429; a server error), a request that never
            // went out or an answer the page couldn't read doesn't rule that restore out, so it may still be running
            // while the owner is told what failed.
            if (wasUnanswered && failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) {
              setUnansweredAt(Date.now()); setRestoreUnanswered(true);
              throw new RestoreUnansweredError({ cause: failure });
            }
            if (wasUnanswered) {
              setUnansweredAt(Date.now()); setRestoreUnanswered(true);
              setFailedAtReads(queries.getQueryState(key)?.errorUpdateCount ?? 0);
              throw failure;
            }
            void status.refetch(); throw failure;
          }
          setUnansweredAt(Date.now());
          // Awaited with the request still counted as pending, so a 404 can't swap the form out first; not forever.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const read = await Promise.race([status.refetch(),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), restoreReadLimit); })])
            .finally(() => clearTimeout(timer));
          if (read?.error instanceof ApiError && (read.error.status === 404 || read.error.status === 503)) {
            setRestoreUnanswered(true);
            throw new RestoreUnansweredError({ cause: failure });
          }
          throw failure;
        } finally { setRestoreSending(false); }
      }} submit="restore" secondary={<Button type="button" variant="outline" disabled={busy}
        onClick={() => {
          setRestore(false); setRestoreUnanswered(false); setUnansweredAt(null); setFailedAtReads(null);
          // Where this swaps in the unavailable screen, the focus goes to it; where the steps stay, no focus moves later.
          if (finished && !restoreStays) backedOut.current = true;
          // Only the form's own request can have gone unanswered: the choice screen mustn't say a restore may be running.
          setError((shown) => shown === 'restoreUnanswered' ? null : shown);
        }}>{t('setup/setup:back')}</Button>}>
        <p>{t('setup/setup:restoreHint')}</p><Destination /><Field name="snapshotPrefix" /><Field name="privateKey" type="password" />
      </Form> : <SetupActions><Button disabled={busy} onClick={() => void run(async () => { await client.call('start', { choice: 'fresh' }); setOverride(1); })}>{t('setup/setup:fresh')}</Button>
        <Button variant="outline" onClick={() => { setRestore(true); setRestoreState(null); setRestoreFailure(null); setUnreachable(false); setThrottled(false); }}>{t('setup/setup:restore')}</Button></SetupActions>)}
      {step === 1 && <Form action={async (data) => {
        const email = text(data, 'email'), password = text(data, 'password');
        await client.call('owner', { name: text(data, 'ownerName'), email, password });
        // From here a failed status reload shows at least the next step, never the owner form again. Not set any earlier,
        // so the form stays on screen while signing in.
        const reload = async () => { setOwnerSaved(true); await queries.invalidateQueries({ queryKey: bootstrapKey }); await refresh(); };
        // Once the owner is saved, move to the sign-in step even if signing in or sending the link fails, so a retry doesn't re-post owner.
        try {
          const bootstrap = await services.loadBootstrap();
          if (bootstrap.login.password) await services.signInWithPassword(email, password);
          else { await client.magicLink(email); setSent(true); }
        } catch (failure) {
          await reload();
          throw failure instanceof ApiError && (failure.status === 429 || (failure.status === 503 && failure.code === 'EMAIL_UNAVAILABLE'))
            ? failure : new OwnerSavedSignInError({ cause: failure });
        }
        await reload();
      }}><Field name="ownerName" /><Field name="email" type="email" /><Field name="password" type="password" minLength={12} maxLength={128} /></Form>}
      {step >= 2 && session.isPending ? <LoadingState label={t('setup/setup:loading')} />
      : step >= 2 && session.isError && !session.data ? <><Alert variant="error">{t('setup/setup:sessionFailed')}</Alert>
        <SetupActions><Button type="button" disabled={session.isFetching} onClick={() => void session.refetch()}>{t('setup/setup:retry')}</Button></SetupActions></>
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
        }}><Field name="gymName" /><Field name="timezone" value={hostZone.zone} hint={t('setup/setup:' + (hostZone.fallback && !zoneEdited ? 'timezoneFallback' : 'timezoneHint'))} onEdit={() => setZoneEdited(true)} />
          <Field name="currency" value="USD" maxLength={3} /><Field name="address" required={false} /><Field name="primaryColor" type="color" value="#155e55" check={null} /></Form>}
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
          <Label className="flex min-h-11 items-center gap-3"><input type="radio" name="website" value="builtin" defaultChecked={!draft.values.existingSiteUrl} onChange={() => setSiteChoice('builtin')} />{t('setup/setup:builtin')}</Label>
          <Label className="flex min-h-11 items-center gap-3"><input type="radio" name="website" value="existing" defaultChecked={Boolean(draft.values.existingSiteUrl)} onChange={() => setSiteChoice('existing')} />{t('setup/setup:existing')}</Label>
          {/* The address and the paths to link matter only for a site of the gym's own. Hidden, the fieldset is also disabled, so a
              leftover address the browser would reject can't block saving the built-in website. */}
          <fieldset className="min-w-0 space-y-4" hidden={!ownSite} disabled={!ownSite}>
            <Field name="existingSiteUrl" type="url" required={false} />
            <p>{t('setup/setup:websiteHint')}</p><p className="font-mono text-sm">{appPaths}</p></fieldset></Form>}
        {step === 5 && (held?.kind === 'email' ? <><p role="status">{t('setup/setup:emailSent', { address: held.to })}</p>{continueHeld}</>
          : <><p>{t('setup/setup:smtpHint')}</p><p>{t('setup/setup:dnsHint')}</p><p>{t('setup/setup:loginHint')}</p>
          <Form draft={draft} submit="testAndSave" secondary={<Button type="button" disabled={busy} variant="outline" onClick={() => void run(async () => { await client.call('smtp', { choice: 'skip', revision }); draft.clear(); await refresh(); })}>{t('setup/setup:skipEmail')}</Button>} action={async (data) => {
            const testTo = text(data, 'testTo');
            const result = await client.call('smtp', { choice: 'configure', revision, host: text(data, 'host'), port: Number(text(data, 'port')),
              secure: data.has('secure'), username: text(data, 'username'), password: text(data, 'smtpPassword'), from: text(data, 'from'), testTo });
            if (result.test === 'failed') { setError(result.failure ? 'smtpFailed.' + result.failure : 'smtpFailed'); return false; }
            // The settings are saved and the server has moved on; this screen stays until the owner continues.
            setHeld({ kind: 'email', to: testTo }); await refresh();
          }}><Label htmlFor="smtp-preset">{t('setup/setup:preset')}</Label><Select id="smtp-preset" defaultValue="" onChange={(event) => {
            const form = event.currentTarget.form;
            const host = form?.elements.namedItem('host');
            if (host instanceof HTMLInputElement) host.value = event.target.value;
          }}><option value="">{t('setup/setup:custom')}</option>{smtpPresets.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</Select>
            <Field name="host" hint={t('setup/setup:hostHint')} /><Field name="port" type="number" value="587" hint={t('setup/setup:portHint')} /><CheckboxField name="secure" label={t('setup/setup:secure')} />
            <SmtpPortHint text={(kind) => t('setup/setup:portMismatch.' + kind)} />
            <Field name="username" /><Field name="smtpPassword" type="password" /><Field name="from" type="email" hint={t('setup/setup:fromHint')} /><Field name="testTo" type="email" /></Form>
          </>)}
        {googlePage && (held?.kind === 'google' ? <><p role="status">{t(held.check === 'unknown' ? 'setup/google-step:unchecked' : 'setup/google-step:saved')}</p>{continueHeld}</>
          : <Form submit="saveGoogle" secondary={<Button type="button" disabled={busy} variant="outline" onClick={() => void run(async () => {
            await client.call('decide', { revision, decision: 'skip_google' }); await refresh();
          })}>{t('setup/google-step:skip')}</Button>} action={async (data) => {
            const result = await client.call('google', { revision, clientId: text(data, 'clientId').trim(), clientSecret: text(data, 'clientSecret').trim() });
            setGoogleSaved(true); setHeld({ kind: 'google', check: result.check }); await queries.invalidateQueries({ queryKey: bootstrapKey }); await refresh();
          }}><p>{t('setup/google-step:intro')}</p><GoogleRedirect /><p className="text-sm text-muted-foreground">{t('auth/google:setupHelp')}</p>
            <GoogleClientFields idPrefix="setup-google" rejected={error === 'googleRejected'} onEdit={() => { if (error === 'googleRejected') setError(null); }} /></Form>)}
        {step === 6 && !googlePage && (Stripe ? <SetupHoldContext.Provider value={{
          connected: held?.kind === 'stripe' ? { mode: held.mode, webhookRegistered: held.webhookRegistered } : null,
          hold: (connected) => setHeld({ kind: 'stripe', ...connected }),
          release: async () => { await refresh(); setHeld(null); },
        }}><Stripe /></SetupHoldContext.Provider>
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
        {step === 8 && <SetupSecondaryActions.Provider value={!status.data?.completedSteps.includes(7) && <Button variant="outline" disabled={busy || finalFinishing} onClick={backToBackups}>{t('setup/setup:backToBackups')}</Button>}>
          <SetupFinishingContext.Provider value={setFinalFinishing}>
            {Final ? <Final /> : <SetupActions><Button disabled={busy} onClick={() => void run(async () => {
              const deferred = status.data?.completedSteps.includes(7) ? {} : { skipBackups: true as const };
              setFinalFinishing(true);
              await client.call('finish', { choice: 'fresh', revision, ...deferred })
                .catch((failure: unknown) => { setFinalFinishing(false); throw failure; });
              setDone(true);
            })}>{t('setup/setup:finish')}</Button></SetupActions>}
          </SetupFinishingContext.Provider>
        </SetupSecondaryActions.Provider>}
      </>}
    </>}
  </Card></main></FormContext.Provider>;
}
