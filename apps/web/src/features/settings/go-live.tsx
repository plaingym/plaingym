// SPDX-License-Identifier: AGPL-3.0-only
import { formatCount } from '../../lib/count.js';
import { instantLabel } from '../../lib/instant.js';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type GoLiveSwitches, type GymSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { SaveTimeoutError, useGymSettings, type SaveResult } from './gym-settings.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { LoadingState } from '../../components/ui/states.js';
import { Badge } from '../../components/ui/table.js';
import { Dialog } from '../../components/ui/dialog.js';
import { CheckboxField } from '../../components/ui/select.js';
import { goLiveKey, parseChecklist, useGoLiveChecklist, type Checklist } from './go-live-query.js';
import { hasRestoreModeNote } from './restore-mode-note.js';

const label = (key: string, values?: Record<string, string>) => t('settings/go-live:' + key, values);
function restoreStripeNote(items: Checklist['items']): 'reconcileStripeConnected' | 'reconcileStripeUnchecked' | 'reconcileWithoutStripe' {
  const stripe = items.find(item => item.id === 'stripe_ready');
  if (stripe?.status === 'ready') return 'reconcileStripeConnected';
  if (stripe?.status === 'needs_attention' && stripe.message === label('check.stripe_ready.read_failed')) return 'reconcileStripeUnchecked';
  return 'reconcileWithoutStripe';
}
const statusTone = { ready: 'success', needs_attention: 'warning', not_applicable: 'muted' } as const;
/**
 * The restore check answers only once it has read every payment change since the snapshot from Stripe, which can take
 * minutes, so its save waits this long rather than the usual timeout. Saves from other sections wait behind it.
 */
export const reconcileTimeoutMs = 5 * 60_000;
/** The server names a check still running for the restore with this code, so a second one never overlaps it. */
const checkRunning = (body: unknown) => {
  const codes = (body as { error?: { details?: { restoreId?: unknown } } } | undefined)?.error?.details?.restoreId;
  return Array.isArray(codes) && codes.includes('check_running');
};

/** Shows the billing and member-email switches with the readiness checklist from the go-live contract. */
export function GoLiveSettings() {
  const cache = useQueryClient();
  const reloadSeq = useRef(0);
  const [lastChecklist, rememberChecklist] = useState<Checklist | null>(null);
  const [ownRead, setOwnRead] = useState<'pending' | 'failed' | null>(null);
  const [saving, setBusy] = useState(false);
  const [message, setMessage] = useState<'error' | 'timeout' | 'changed' | 'justSaved' | 'smsProviderRequired'
    | 'smsProviderReadFailed' | 'paymentsReadFailed' | null>(null);
  // The shared settings revision a refusal was answered at: a later revision may have changed what it says.
  const [messageRevision, setMessageRevision] = useState<number | null>(null);
  // The tick is kept as the past-due list it was given for, so it never counts for a list that has since changed.
  const [confirmBilling, setConfirmBilling] = useState(false), [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  // Set when a failed read closed the dialog: the read alert then takes the focus the dialog would return to a disabled switch.
  const [readAlertFocus, setReadAlertFocus] = useState(false);
  // The page's alert: the plain one, or the read alert in its place.
  const messageBox = useRef<HTMLDivElement>(null);
  const [checking, setChecking] = useState(false), [checkError, setCheckError] = useState<'reconcileError' | 'reconcileTimeout' | 'reconcileBusy' | null>(null);
  // The switches save the gym revision that every section of the page shares, so another section's save doesn't stale them.
  const gym = useGymSettings(), settings = gym.settings;
  const query = useGoLiveChecklist(settings?.revision, gym.epoch);
  // Retain the displayed controls while a new revision or explicit reload is loading or failed; background focus reads keep controls enabled.
  const checklist = query.data ?? lastChecklist;
  const background = query.isFetching && query.data !== undefined && ownRead !== 'pending';
  const busy = saving || (query.isFetching && !background);
  const readError = query.isError && (query.data === undefined || ownRead === 'failed');
  const pastDueKey = (checklist?.pastDueMemberships ?? []).map(({ id, revision, nextDueOn }) => id + ':' + revision + ':' + nextDueOn).join('|');
  const confirmed = confirmedKey !== null && confirmedKey === pastDueKey;
  useEffect(() => { if (query.data) rememberChecklist(query.data); }, [query.data]);
  useEffect(() => { setOwnRead(null); }, [query.dataUpdatedAt]);
  useEffect(() => { if (ownRead === 'pending' && !query.isFetching) setOwnRead(query.isError ? 'failed' : null); }, [query.isFetching]);
  const reloadChecklist = () => {
    const seq = ++reloadSeq.current;
    setOwnRead('pending');
    void query.refetch().then(result => {
      if (seq !== reloadSeq.current) return;
      if (cache.isFetching({ queryKey: goLiveKey(settings?.revision, gym.epoch) }) > 0) return;
      setOwnRead(result.isError ? 'failed' : null);
    });
  };
  const setChecklist = (next: ReturnType<typeof parseChecklist>) => {
    void cache.cancelQueries({ queryKey: goLiveKey(settings?.revision, gym.epoch) });
    cache.setQueryData(goLiveKey(settings?.revision, gym.epoch), next);
    cache.setQueryData(goLiveKey(next.revision, gym.epoch), next);
  };
  const adopt = (data: unknown, current: GymSettings): GymSettings => {
    const { revision, billingEnabled, memberEmailsEnabled, memberSmsEnabled } = parseChecklist(data);
    return { ...current, revision, billingEnabled, memberEmailsEnabled, memberSmsEnabled };
  };
  // The readiness items follow the settings: fetch the checklist again when another section's save moved the revision.
  // Until it arrives the switches and past-due dates on screen are older than the revision they would save, so they wait.
  // While a read has failed the switches wait for the retry: a save would be refused, and its own alert would sit beside the read's.
  // A checklist read that failed leaves the one on screen (if any) older than the settings, or older than a refused switch.
  const behind = !!settings && !!checklist && settings.revision > checklist.revision, locked = busy || behind || gym.failed || readError;
  const checklistFailed = readError, readFailed = gym.failed || checklistFailed;
  // A refusal, a timed-out save or an unchecked Stripe whose follow-up read failed says what became of the save, in the read
  // failure's own alert.
  const refusedUnread = readFailed && (message === 'changed' || message === 'justSaved' || message === 'timeout'
    || message === 'paymentsReadFailed' || message === 'smsProviderRequired' || message === 'smsProviderReadFailed') ? message : null;
  useEffect(() => { if (behind) void query.refetch(); }, [behind, settings?.revision, query.refetch]);
  // A reason whose alert holds the focus is kept until the next press or Retry, since the owner is reading it; otherwise
  // any move of the revision, back too, may have changed what it says.
  useEffect(() => {
    if (messageRevision === null || !settings || settings.revision === messageRevision) return;
    if (messageBox.current?.contains(document.activeElement)) { setMessageRevision(null); return; }
    setMessage(null); setMessageRevision(null);
  }, [messageRevision, settings?.revision]);
  // The past-due dialog is modal, so it closes once no save is running if a read failed (the page's retry is behind it),
  // billing is already on (a save that timed out may have turned it on, leaving nothing to confirm), or the list it asks
  // about is empty.
  useEffect(() => {
    if (confirmBilling && !busy && (readFailed || checklist?.billingEnabled || !checklist?.pastDueMemberships.length)) {
      setConfirmBilling(false); setConfirmedKey(null);
      if (readFailed) setReadAlertFocus(true);
    }
  }, [confirmBilling, busy, readFailed, checklist]);
  useEffect(() => { if (!readFailed) setReadAlertFocus(false); }, [readFailed]);
  // Read while rendering, before a swap between the two alerts can move the focus: a reason the settings have moved past,
  // with the owner working elsewhere, is about to be dropped, so the plain alert must not take the focus for it first.
  const leftBehind = messageRevision !== null && settings?.revision !== messageRevision
    && !messageBox.current?.contains(document.activeElement);
  /**
   * A refused or conflicting save. A shared revision past the checklist's refetches it through `behind`, once; when the
   * settings did not move past it (their reload failed, or the server's revision went back), nothing else will.
   */
  function conflict(result: SaveResult, read: number) {
    setConfirmBilling(false); setConfirmedKey(null);
    // A save refused unsent because another section of this page saved first is not another user's change.
    setMessage(result.refused === 'saved' ? 'justSaved' : 'changed'); setMessageRevision(result.settings.revision);
    if (result.settings.revision <= read) reloadChecklist();
  }
  /** Retries every read that failed: the shared settings, and the checklist. */
  function retry() {
    setMessage(null); setMessageRevision(null); setReadAlertFocus(false);
    if (gym.failed) gym.reload();
    if (checklistFailed || query.isError) reloadChecklist();
  }
  async function toggle(name: keyof GoLiveSwitches, confirmDates = false) {
    if (!checklist || !settings || locked) return;
    if (name === 'billingEnabled' && !checklist.billingEnabled && checklist.pastDueMemberships.length && !confirmDates) {
      setConfirmedKey(null); setConfirmBilling(true); return;
    }
    setBusy(true); setMessage(null); setMessageRevision(null);
    try {
      const result = await gym.save((revision, signal) => api.PATCH('/api/settings/go-live', { signal, body: { revision,
        // The dialog's confirm only ever turns billing on, whatever a reload since it opened shows.
        [name]: name === 'billingEnabled' && confirmDates ? true : !checklist[name],
        ...(confirmDates ? { confirmedPastDueDates: checklist.pastDueMemberships.map(({ id, revision, nextDueOn }) => ({ id, revision, nextDueOn })) } : {}),
      } }), { adopt, readAt: checklist.revision });
      const details = (result.error as { error?: { details?: { memberSmsEnabled?: unknown; billingEnabled?: unknown } } } | undefined)?.error?.details;
      const smsReasons = details?.memberSmsEnabled, billingReasons = details?.billingEnabled;
      if (result.status === 409 && Array.isArray(smsReasons) && smsReasons.includes('no_provider')) {
        setMessage('smsProviderRequired'); setMessageRevision(result.settings.revision); reloadChecklist(); return;
      }
      if (result.status === 409) { conflict(result, checklist.revision); return; }
      if (result.status === 503 && Array.isArray(smsReasons) && smsReasons.includes('read_failed')) {
        setMessage('smsProviderReadFailed'); setMessageRevision(result.settings.revision); reloadChecklist(); return;
      }
      if (result.status === 503 && Array.isArray(billingReasons) && billingReasons.includes('read_failed')) {
        setMessage('paymentsReadFailed'); setMessageRevision(result.settings.revision); reloadChecklist(); return;
      }
      if (result.status >= 300) throw new Error();
      setChecklist(parseChecklist(result.data));
      setConfirmBilling(false); setConfirmedKey(null);
    } catch (error) { setMessage(error instanceof SaveTimeoutError ? 'timeout' : 'error'); setMessageRevision(null); }
    finally { setBusy(false); }
  }
  async function rerunReconciliation() {
    if (!checklist?.restoreReconciliation || !settings || locked) return;
    setBusy(true); setChecking(true); setCheckError(null); setMessage(null); setMessageRevision(null);
    try {
      const restoreId = checklist.restoreReconciliation.restoreId;
      const result = await gym.check((revision, signal) => api.POST('/api/settings/go-live/reconciliation', { signal, body: { revision, restoreId } }),
        { readAt: checklist.revision, timeoutMs: reconcileTimeoutMs });
      // A check already running for this restore (another tab, or one this page stopped waiting for) is left to finish.
      if (result.status === 409 && checkRunning(result.error)) { setCheckError('reconcileBusy'); reloadChecklist(); return; }
      if (result.status === 409) { conflict(result, checklist.revision); return; }
      if (result.status >= 300) throw new Error();
      setChecklist(parseChecklist(result.data));
    } catch (error) {
      // A check the page stopped waiting for may still be running on the server: say so rather than that it failed.
      setCheckError(error instanceof SaveTimeoutError ? 'reconcileTimeout' : 'reconcileError'); reloadChecklist();
    }
    finally { setBusy(false); setChecking(false); }
  }
  return <section className="space-y-4" aria-label={label('title')}>
    <h2 className="text-lg font-semibold">{label('title')}</h2>
    <p className="text-sm text-muted-foreground">{label('help')}</p>
    {readFailed ? <Alert ref={messageBox} variant="error" focusOnReveal={readAlertFocus}>{refusedUnread && label(refusedUnread + 'Unread') + ' '}{label('error')}
      <Button variant="outline" className="mt-3 sm:ml-3 sm:mt-0" onClick={retry}>{label('retry')}</Button></Alert>
      : message && <Alert ref={messageBox} variant="error" focusOnReveal={!confirmBilling && !leftBehind}>{label(message)}</Alert>}
    {!checklist || !settings ? (busy || gym.loading) && <LoadingState label={label('loading')}/> : <>
      <ul className="space-y-3">{(['billingEnabled', 'memberEmailsEnabled', 'memberSmsEnabled'] as const).map((name) => {
        const on = checklist[name], action = label(on ? 'turnOff' : 'turnOn');
        return <li key={name} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="font-medium">{label(name)}: <span>{label(on ? 'on' : 'off')}</span></p>
            <p className="text-sm text-muted-foreground">{label(name === 'billingEnabled' ? 'billingHelp' : name === 'memberEmailsEnabled' ? 'memberEmailsHelp' : 'memberSmsHelp')}</p></div>
          <Button className="shrink-0" variant={on ? 'outline' : 'default'} disabled={locked} aria-pressed={on}
            aria-label={label('toggleNamed', { action, name: label(name) })} onClick={() => void toggle(name)}>{action}</Button>
        </li>;
      })}</ul>
      {busy && <p role="status" className="text-sm text-muted-foreground">{label(checking ? 'reconcileRunning' : 'saving')}</p>}
      <h3 className="font-semibold">{label('checklist')}</h3>
      <ul className="divide-y divide-border rounded-lg border border-border">{checklist.items.map((item) => <li key={item.id} className="flex flex-col items-start gap-2 p-3 sm:flex-row sm:justify-between sm:gap-3">
        <span className="min-w-0"><span className="block font-medium">{label('item.' + item.id)}</span><span role={hasRestoreModeNote(item) ? 'note' : undefined} className="block text-sm text-muted-foreground">{item.message}</span></span>
        <Badge tone={statusTone[item.status]} className="shrink-0">{label('status.' + item.status)}</Badge>
      </li>)}</ul>
      {checklist.restoreReconciliation && <div className="space-y-3 rounded-lg border border-border p-3" aria-label={label('reconcileTitle')}>
        <h3 className="font-semibold">{label('reconcileTitle')}</h3>
        <p className="text-sm text-muted-foreground">{label('reconcileHelp')}</p>
        <p role="status" className="text-sm">{checklist.restoreReconciliation.checkedAt
          ? label(checklist.restoreReconciliation.stripeConfigured === false ? 'reconcileStoredResult' : 'reconcileResult', {
            at: instantLabel(checklist.restoreReconciliation.checkedAt, settings?.timezone),
            inspected: checklist.restoreReconciliation.inspected === null ? label('unknown') : formatCount(checklist.restoreReconciliation.inspected),
            unresolved: checklist.restoreReconciliation.unresolved === null ? label('unknown') : formatCount(checklist.restoreReconciliation.unresolved) })
          : label('reconcilePending')}</p>
        {checklist.restoreReconciliation.stripeConfigured === false && <p className="text-sm">
          {label(restoreStripeNote(checklist.items))}</p>}
        {checkError && <Alert variant="error" focusOnReveal>{label(checkError)}</Alert>}
        {checklist.billingEnabled && <p className="text-sm text-muted-foreground">{label('reconcilePause')}</p>}
        <Button variant="outline" disabled={locked || checklist.billingEnabled || !checklist.restoreReconciliation.snapshotAt}
          onClick={() => void rerunReconciliation()}>{label('reconcileRerun')}</Button>
      </div>}
      {!!checklist.pastDueMemberships.length && <div className="space-y-3" aria-label={label('pastDueTitle')}>
        <h3 className="font-semibold">{label('pastDueTitle')}</h3>
        <p className="text-sm text-muted-foreground">{label('pastDueHelp')}</p>
        <PastDueList memberships={checklist.pastDueMemberships}/>
      </div>}
      {confirmBilling && <Dialog title={label('confirmTitle')} description={label('pastDueHelp')} closeLabel={label('close')}
        dismissible={!busy}
        onClose={() => { if (!busy) { setConfirmBilling(false); setConfirmedKey(null); } }}>
        <div className="space-y-4">
          <PastDueList memberships={checklist.pastDueMemberships}/>
          <CheckboxField label={label('confirmDates')} checked={confirmed} disabled={busy}
            onChange={(event) => setConfirmedKey(event.target.checked ? pastDueKey : null)}/>
          {/* The dialog is modal: the page's alert behind it can't be seen, so a failed save shows here too. */}
          {(message === 'error' || message === 'paymentsReadFailed' || message === 'timeout')
            && <Alert variant="error" focusOnReveal>{label(message)}</Alert>}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" disabled={busy} onClick={() => setConfirmBilling(false)}>{label('cancel')}</Button>
            <Button disabled={locked || !confirmed} onClick={() => void toggle('billingEnabled', true)}>{label('confirmEnable')}</Button>
          </div>
        </div>
      </Dialog>}
    </>}
  </section>;
}

function PastDueList({ memberships }: { memberships: Checklist['pastDueMemberships'] }) {
  return <ul className="divide-y divide-border rounded-lg border border-border">{memberships.map(membership => <li key={membership.id}
    className="space-y-1 p-3">
    <p className="font-medium">{membership.memberName}</p><p className="text-sm">{membership.planName}</p>
    <p className="text-sm text-muted-foreground">{label('nextDueOn', { date: membership.nextDueOn })}</p>
  </li>)}</ul>;
}
