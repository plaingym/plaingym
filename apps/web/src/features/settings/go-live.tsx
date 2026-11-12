// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useEffect, useState } from 'react';
import { goLiveChecklistResponseSchema, type GoLiveSwitches, type GymSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { SaveTimeoutError, useGymSettings, type SaveResult } from './gym-settings.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { LoadingState } from '../../components/ui/states.js';
import { Badge } from '../../components/ui/table.js';
import { Dialog } from '../../components/ui/dialog.js';
import { CheckboxField } from '../../components/ui/select.js';

type WireChecklist = ReturnType<typeof goLiveChecklistResponseSchema.parse>['data'];
type Checklist = WireChecklist & { pastDueMemberships: NonNullable<WireChecklist['pastDueMemberships']> };
function parseChecklist(response: unknown): Checklist {
  const data = parseResponse(goLiveChecklistResponseSchema, response).data;
  return { ...data, pastDueMemberships: data.pastDueMemberships ?? [] };
}
const label = (key: string, values?: Record<string, string>) => t('settings/go-live:' + key, values);
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
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<'error' | 'timeout' | 'changed' | 'justSaved' | null>(null);
  const [readError, setReadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [confirmBilling, setConfirmBilling] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [checking, setChecking] = useState(false), [checkError, setCheckError] = useState<'reconcileError' | 'reconcileTimeout' | 'reconcileBusy' | null>(null);
  // The switches save the gym revision that every section of the page shares, so another section's save doesn't stale them.
  const gym = useGymSettings(), settings = gym.settings;
  const adopt = (data: unknown, current: GymSettings): GymSettings => {
    const { revision, billingEnabled, memberEmailsEnabled } = parseChecklist(data);
    return { ...current, revision, billingEnabled, memberEmailsEnabled };
  };
  // The readiness items follow the settings: fetch the checklist again when another section's save moved the revision.
  // Until it arrives the switches and past-due dates on screen are older than the revision they would save, so they wait.
  // While a read has failed the switches wait for the retry: a save would be refused, and its own alert would sit beside the read's.
  // A checklist read that failed leaves the one on screen (if any) older than the settings, or older than a refused switch.
  const behind = !!settings && !!checklist && settings.revision > checklist.revision, locked = busy || behind || gym.failed || readError;
  const checklistFailed = readError, readFailed = gym.failed || checklistFailed;
  // A refusal whose follow-up read failed says why the switch didn't change, in the read failure's own alert.
  const refusedUnread = readFailed && (message === 'changed' || message === 'justSaved') ? message : null;
  useEffect(() => { if (behind) setReload((value) => value + 1); }, [behind, settings?.revision]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void api.GET('/api/settings/go-live').then((result) => {
      if (!result.response.ok) throw new Error();
      const next = parseChecklist(result.data);
      if (active) { setChecklist(next); setReadError(false); }
    }).catch(() => { if (active) setReadError(true); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [reload]);
  /**
   * A refused or conflicting save. A shared revision past the checklist's refetches it through `behind`, once; when the
   * settings did not move past it (their reload failed, or the server's revision went back), nothing else will.
   */
  function conflict(result: SaveResult, read: number) {
    setConfirmBilling(false); setConfirmed(false);
    // A save refused unsent because another section of this page saved first is not another user's change.
    setMessage(result.refused === 'saved' ? 'justSaved' : 'changed');
    if (result.settings.revision <= read) setReload((value) => value + 1);
  }
  /** Retries every read that failed: the shared settings, and the checklist. */
  function retry() {
    setMessage(null); setReadError(false);
    if (gym.failed) gym.reload();
    if (checklistFailed) setReload((value) => value + 1);
  }
  async function toggle(name: keyof GoLiveSwitches, confirmDates = false) {
    if (!checklist || !settings || locked) return;
    if (name === 'billingEnabled' && !checklist.billingEnabled && checklist.pastDueMemberships.length && !confirmDates) {
      setConfirmed(false); setConfirmBilling(true); return;
    }
    setBusy(true); setMessage(null);
    try {
      const result = await gym.save((revision, signal) => api.PATCH('/api/settings/go-live', { signal, body: { revision, [name]: !checklist[name],
        ...(confirmDates ? { confirmedPastDueDates: checklist.pastDueMemberships.map(({ id, revision, nextDueOn }) => ({ id, revision, nextDueOn })) } : {}),
      } }), { adopt, readAt: checklist.revision });
      if (result.status === 409) { conflict(result, checklist.revision); return; }
      if (result.status >= 300) throw new Error();
      setChecklist(parseChecklist(result.data));
      setConfirmBilling(false); setConfirmed(false);
    } catch (error) { setMessage(error instanceof SaveTimeoutError ? 'timeout' : 'error'); }
    finally { setBusy(false); }
  }
  async function rerunReconciliation() {
    if (!checklist?.restoreReconciliation || !settings || locked) return;
    setBusy(true); setChecking(true); setCheckError(null); setMessage(null);
    try {
      const restoreId = checklist.restoreReconciliation.restoreId;
      const result = await gym.save((revision, signal) => api.POST('/api/settings/go-live/reconciliation', { signal, body: { revision, restoreId } }),
        { adopt, readAt: checklist.revision, timeoutMs: reconcileTimeoutMs });
      // A check already running for this restore (another tab, or one this page stopped waiting for) is left to finish.
      if (result.status === 409 && checkRunning(result.error)) { setCheckError('reconcileBusy'); setReload((value) => value + 1); return; }
      if (result.status === 409) { conflict(result, checklist.revision); return; }
      if (result.status >= 300) throw new Error();
      setChecklist(parseChecklist(result.data));
    } catch (error) {
      // A check the page stopped waiting for may still be running on the server: say so rather than that it failed.
      setCheckError(error instanceof SaveTimeoutError ? 'reconcileTimeout' : 'reconcileError'); setReload((value) => value + 1);
    }
    finally { setBusy(false); setChecking(false); }
  }
  return <section className="space-y-4" aria-label={label('title')}>
    <h2 className="text-lg font-semibold">{label('title')}</h2>
    <p className="text-sm text-muted-foreground">{label('help')}</p>
    {readFailed ? <Alert>{refusedUnread && label(refusedUnread + 'Unread') + ' '}{label('error')}
      <Button variant="outline" className="mt-3 sm:ml-3 sm:mt-0" onClick={retry}>{label('retry')}</Button></Alert>
      : message && <Alert>{label(message)}</Alert>}
    {!checklist || !settings ? (busy || gym.loading) && <LoadingState label={label('loading')}/> : <>
      <ul className="space-y-3">{(['billingEnabled', 'memberEmailsEnabled'] as const).map((name) => {
        const on = checklist[name], action = label(on ? 'turnOff' : 'turnOn');
        return <li key={name} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="font-medium">{label(name)}: <span>{label(on ? 'on' : 'off')}</span></p>
            <p className="text-sm text-muted-foreground">{label(name === 'billingEnabled' ? 'billingHelp' : 'memberEmailsHelp')}</p></div>
          <Button className="shrink-0" variant={on ? 'outline' : 'default'} disabled={locked} aria-pressed={on}
            aria-label={label('toggleNamed', { action, name: label(name) })} onClick={() => void toggle(name)}>{action}</Button>
        </li>;
      })}</ul>
      {busy && <p role="status" className="text-sm text-muted-foreground">{label(checking ? 'reconcileRunning' : 'saving')}</p>}
      <h3 className="font-semibold">{label('checklist')}</h3>
      <ul className="divide-y divide-border rounded-lg border border-border">{checklist.items.map((item) => <li key={item.id} className="flex flex-col items-start gap-2 p-3 sm:flex-row sm:justify-between sm:gap-3">
        <span className="min-w-0"><span className="block font-medium">{label('item.' + item.id)}</span><span className="block break-words text-sm text-muted-foreground">{item.message}</span></span>
        <Badge tone={statusTone[item.status]} className="shrink-0">{label('status.' + item.status)}</Badge>
      </li>)}</ul>
      {checklist.restoreReconciliation && <div className="space-y-3 rounded-lg border border-border p-3" aria-label={label('reconcileTitle')}>
        <h3 className="font-semibold">{label('reconcileTitle')}</h3>
        <p className="text-sm text-muted-foreground">{label('reconcileHelp')}</p>
        <p role="status" className="break-words text-sm">{checklist.restoreReconciliation.checkedAt
          ? label(checklist.restoreReconciliation.stripeConfigured === false ? 'reconcileStoredResult' : 'reconcileResult', { at: checklist.restoreReconciliation.checkedAt,
            inspected: String(checklist.restoreReconciliation.inspected), unresolved: String(checklist.restoreReconciliation.unresolved) })
          : label('reconcilePending')}</p>
        {checklist.restoreReconciliation.stripeConfigured === false && <p className="break-words text-sm">
          {label(checklist.items.find(item => item.id === 'stripe_ready')?.status === 'ready' ? 'reconcileStripeConnected' : 'reconcileWithoutStripe')}</p>}
        {checkError && <Alert>{label(checkError)}</Alert>}
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
        onClose={() => { if (!busy) { setConfirmBilling(false); setConfirmed(false); } }}>
        <div className="space-y-4">
          <PastDueList memberships={checklist.pastDueMemberships}/>
          <CheckboxField label={label('confirmDates')} checked={confirmed} disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}/>
          {/* The dialog is modal: the page's alert behind it can't be seen, so a failed save shows here too. */}
          {message === 'error' && <Alert>{label('error')}</Alert>}
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
    className="space-y-1 break-words p-3">
    <p className="font-medium">{membership.memberName}</p><p className="text-sm">{membership.planName}</p>
    <p className="text-sm text-muted-foreground">{label('nextDueOn', { date: membership.nextDueOn })}</p>
  </li>)}</ul>;
}
