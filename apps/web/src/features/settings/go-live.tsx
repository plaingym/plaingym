// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { goLiveChecklistResponseSchema, type GoLiveSwitches } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
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
  const data = goLiveChecklistResponseSchema.parse(response).data;
  return { ...data, pastDueMemberships: data.pastDueMemberships ?? [] };
}
const label = (key: string, values?: Record<string, string>) => t('settings/go-live:' + key, values);
const statusTone = { ready: 'success', needs_attention: 'warning', not_applicable: 'muted' } as const;

/** Shows the billing and member-email switches with the readiness checklist from the go-live contract. */
export function GoLiveSettings() {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<'error' | 'changed' | null>(null);
  const [reload, setReload] = useState(0);
  const [confirmBilling, setConfirmBilling] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [checking, setChecking] = useState(false), [checkError, setCheckError] = useState(false);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void api.GET('/api/settings/go-live').then((result) => {
      if (!result.response.ok) throw new Error();
      const next = parseChecklist(result.data);
      if (active) setChecklist(next);
    }).catch(() => { if (active) setMessage('error'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [reload]);
  async function toggle(name: keyof GoLiveSwitches, confirmDates = false) {
    if (!checklist || busy) return;
    if (name === 'billingEnabled' && !checklist.billingEnabled && checklist.pastDueMemberships.length && !confirmDates) {
      setConfirmed(false); setConfirmBilling(true); return;
    }
    setBusy(true); setMessage(null);
    try {
      const result = await api.PATCH('/api/settings/go-live', { body: { revision: checklist.revision, [name]: !checklist[name],
        ...(confirmDates ? { confirmedPastDueDates: checklist.pastDueMemberships.map(({ id, revision, nextDueOn }) => ({ id, revision, nextDueOn })) } : {}),
      } });
      if (result.response.status === 409) { setConfirmBilling(false); setConfirmed(false); setMessage('changed'); setReload((value) => value + 1); return; }
      if (!result.response.ok) throw new Error();
      setChecklist(parseChecklist(result.data));
      setConfirmBilling(false); setConfirmed(false);
    } catch { setMessage('error'); }
    finally { setBusy(false); }
  }
  async function rerunReconciliation() {
    if (!checklist?.restoreReconciliation || busy) return;
    setBusy(true); setChecking(true); setCheckError(false); setMessage(null);
    try {
      const result = await api.POST('/api/settings/go-live/reconciliation', { body: {
        revision: checklist.revision, restoreId: checklist.restoreReconciliation.restoreId,
      } });
      if (result.response.status === 409) { setMessage('changed'); setReload(value => value + 1); return; }
      if (!result.response.ok) throw new Error();
      setChecklist(parseChecklist(result.data));
    } catch { setCheckError(true); setReload(value => value + 1); }
    finally { setBusy(false); setChecking(false); }
  }
  return <section className="space-y-4" aria-label={label('title')}>
    <h2 className="text-lg font-semibold">{label('title')}</h2>
    <p className="text-sm text-muted-foreground">{label('help')}</p>
    {message && <Alert>{label(message)}{message === 'error' && !checklist &&
      <Button variant="outline" className="mt-3 sm:ml-3 sm:mt-0" onClick={() => { setMessage(null); setReload((value) => value + 1); }}>{label('retry')}</Button>}</Alert>}
    {!checklist ? busy && <LoadingState label={label('loading')}/> : <>
      <ul className="space-y-3">{(['billingEnabled', 'memberEmailsEnabled'] as const).map((name) => {
        const on = checklist[name], action = label(on ? 'turnOff' : 'turnOn');
        return <li key={name} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="font-medium">{label(name)}: <span>{label(on ? 'on' : 'off')}</span></p>
            <p className="text-sm text-muted-foreground">{label(name === 'billingEnabled' ? 'billingHelp' : 'memberEmailsHelp')}</p></div>
          <Button className="shrink-0" variant={on ? 'outline' : 'default'} disabled={busy} aria-pressed={on}
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
          ? label('reconcileResult', { at: checklist.restoreReconciliation.checkedAt,
            inspected: String(checklist.restoreReconciliation.inspected), unresolved: String(checklist.restoreReconciliation.unresolved) })
          : label('reconcilePending')}</p>
        {checkError && <Alert>{label('reconcileError')}</Alert>}
        {checklist.billingEnabled && <p className="text-sm text-muted-foreground">{label('reconcilePause')}</p>}
        <Button variant="outline" disabled={busy || checklist.billingEnabled || !checklist.restoreReconciliation.snapshotAt}
          onClick={() => void rerunReconciliation()}>{label('reconcileRerun')}</Button>
      </div>}
      {!!checklist.pastDueMemberships.length && <div className="space-y-3" aria-label={label('pastDueTitle')}>
        <h3 className="font-semibold">{label('pastDueTitle')}</h3>
        <p className="text-sm text-muted-foreground">{label('pastDueHelp')}</p>
        <PastDueList memberships={checklist.pastDueMemberships}/>
      </div>}
      {confirmBilling && <Dialog title={label('confirmTitle')} description={label('pastDueHelp')} closeLabel={label('close')}
        onClose={() => { if (!busy) { setConfirmBilling(false); setConfirmed(false); } }}>
        <div className="space-y-4">
          <PastDueList memberships={checklist.pastDueMemberships}/>
          <CheckboxField label={label('confirmDates')} checked={confirmed} disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}/>
          {message === 'error' && <Alert>{label('error')}</Alert>}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" disabled={busy} onClick={() => setConfirmBilling(false)}>{label('cancel')}</Button>
            <Button disabled={busy || !confirmed} onClick={() => void toggle('billingEnabled', true)}>{label('confirmEnable')}</Button>
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
