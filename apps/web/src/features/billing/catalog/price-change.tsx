// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import type { ApplyPlanPriceChangeRequest, Plan, PlanPriceChangeMembership, PlanPriceChangePreview, PlanPriceChangeResult } from '@plaingym/shared/contracts';
import { addDays, isCalendarDate } from '@plaingym/shared/time';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { StackedItem, StackedList, TableContainer } from '../../../components/ui/table.js';
import { ApiError } from '../../../lib/api.js';
import { applyPriceChange, previewPriceChange, type BillingClient } from './api.js';
import { money, say, selectClass, text } from './format.js';

type Choice = 'new' | 'all' | 'chosen';
type Props = { plan: Plan; input: Record<string, unknown>; initial: PlanPriceChangePreview; client: BillingClient;
  cancel: () => void; reload: () => Promise<void>; done: () => Promise<void> };

/** A selection is independent of the visible filters; households are counted once, even with several memberships. */
export function priceChangeCounts(rows: readonly PlanPriceChangeMembership[]) {
  const homes = new Map(rows.map(row => [row.householdId, row.householdReach]));
  const count = (reach: PlanPriceChangeMembership['householdReach']) => [...homes.values()].filter(value => value === reach).length;
  return { reachable: count('ok'), noAddress: count('no_address'), erased: count('payer_erased'), suppressed: count('suppressed') };
}

export function PriceChange({ plan, input, initial, client, cancel, reload, done }: Props) {
  const [preview, setPreview] = useState(initial), [date, setDate] = useState(initial.effectiveOn);
  const [choice, setChoice] = useState<Choice>('new'), [include, setInclude] = useState(false);
  const [ticks, setTicks] = useState(() => new Set(initial.memberships.filter(row => row.tickedByDefault).map(row => row.id)));
  const [notify, setNotify] = useState(true), [confirmed, setConfirmed] = useState(false), [review, setReview] = useState(false);
  const [search, setSearch] = useState(''), [status, setStatus] = useState(''), [commitment, setCommitment] = useState(false), [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false);
  const [result, setResult] = useState<PlanPriceChangeResult>();
  // Persist both the updated revision and the entire immutable command across an ambiguous apply failure.
  const command = useRef<ApplyPlanPriceChangeRequest | undefined>(undefined);
  const requestKey = useRef<string | undefined>(undefined);
  const touched = useRef(new Set<string>());
  const [attempted, setAttempted] = useState(false);
  const selected = preview.memberships.filter(row => !row.skipReason && (choice === 'all' ? include || row.includedByAll : ticks.has(row.id)));
  const counts = priceChangeCounts(selected), sendNotice = notify && preview.canEmail;
  const warning = choice !== 'new' && preview.change === 'increase' && (date < addDays(preview.today, 30) || !sendNotice);
  const dateReady = isCalendarDate(date) && date >= preview.today && date === preview.effectiveOn;
  const tooMany = preview.total > preview.memberships.length;
  const visible = preview.memberships.filter(row => row.memberName.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    && (!status || row.status === status) && (!commitment || row.inCommitment) && (!custom || row.customPrice));
  const locked = busy || attempted;
  const selection = (row: PlanPriceChangeMembership) => <Label className="flex min-h-11 items-center gap-3">
    <input type="checkbox" className="size-5 shrink-0" aria-label={say('pcSelect', { name: row.memberName })}
      checked={!row.skipReason && (choice === 'all' ? include || row.includedByAll : ticks.has(row.id))}
      disabled={locked || choice !== 'chosen' || Boolean(row.skipReason)} onChange={event => {
        const checked = event.target.checked;
        touched.current.add(row.id);
        setTicks(current => { const next = new Set(current); if (checked) next.add(row.id); else next.delete(row.id); return next; });
      }}/><span>{row.memberName}</span>
  </Label>;
  const details = (row: PlanPriceChangeMembership) => <>
    <p>{money(row.amountCents, row.currency)} / {text(row.interval)}</p>
    <p>{text('pcCommitmentEnd')}: {row.commitmentEndsOn ?? text('pcNone')}</p>
    <p>{text('pcCustom')}: {text(row.customPrice ? 'pcYes' : 'pcNo')}</p>
    <p>{text('pcStatus_' + row.status)}</p>
    {row.skipReason && <p className="font-medium">{text('pcSkip_' + row.skipReason)}</p>}
  </>;
  async function refreshDate() {
    setBusy(true); setError('');
    try {
      const fresh = await previewPriceChange(client, plan.id, initial.amountCents, date);
      if (fresh.plan.revision !== plan.revision) { setConflict(true); setError(text('pcConflict')); return; }
      setPreview(fresh); setConfirmed(false);
      // Keep explicit choices; newly eligible rows use their default tick.
      setTicks(current => new Set(fresh.memberships.filter(row => !row.skipReason && (touched.current.has(row.id)
        ? current.has(row.id) : row.tickedByDefault)).map(row => row.id)));
    } catch { setError(text('error')); } finally { setBusy(false); }
  }
  async function apply() {
    if (busy || conflict || (choice !== 'new' && (!dateReady || !selected.length || (warning && !confirmed)))) return;
    setBusy(true); setError('');
    try {
      if (choice === 'new') {
        await client.call('updatePlan', input, { planId: plan.id });
        await done(); return;
      }
      setAttempted(true);
      requestKey.current ??= crypto.randomUUID();
      if (!command.current) {
        // Save other edits first, keeping the current price until the apply endpoint changes it.
        const updated = (await client.call('updatePlan', { ...input, amountCents: plan.amountCents }, { planId: plan.id })).data;
        command.current = { requestKey: requestKey.current, planRevision: updated.revision, amountCents: initial.amountCents,
          effectiveOn: date, notify: sendNotice, memberships: selected.map(row => ({ id: row.id, revision: row.revision })) };
      }
      setResult(await applyPriceChange(client, plan.id, command.current));
    } catch (failure) {
      // Cancel is gone once the attempt started, so every error also offers the reload (a lasting failure must not trap staff).
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true); setError(text(failure.reason.includes('request_reused') ? 'pcReused' : 'pcConflict'));
      } else setError(text('error'));
    } finally { setBusy(false); }
  }
  async function reloadPlan() {
    setBusy(true); setError('');
    try { await reload(); } catch { setError(text('error')); } finally { setBusy(false); }
  }
  const name = (id: string) => preview.memberships.find(row => row.id === id)?.memberName ?? id;
  return <Dialog title={text(result ? 'pcResult' : 'pcTitle')} closeLabel={text('cancel')} size="wide" dismissible={!busy && !attempted}
    onClose={cancel}>
    <div className="min-w-0 space-y-4 wrap-anywhere">
      <p>{say('pcPrice', { name: plan.name, amount: money(initial.amountCents, plan.currency) })}</p>
      {error && <Alert role="alert" className="space-y-3"><p>{error}</p>{(conflict || attempted) && <Button disabled={busy} onClick={() => void reloadPlan()}>{text('pcReload')}</Button>}</Alert>}
      {result ? <>
        <p role="status">{say('pcScheduled', { count: result.scheduled.length, date: result.effectiveOn })}</p>
        <p>{text('pcCycles')}</p>
        <p>{say('pcNoticesQueued', { count: result.householdsNotified })}</p>
        <p>{say('pcNoAddress', { count: result.householdsWithoutAddress })}</p>
        <p>{say('pcSuppressed', { count: result.householdsSuppressed })}</p>
        <p>{say('pcErased', { count: result.householdsPayerErased })}</p>
        {!command.current?.notify && <p>{text('pcNoNotices')}</p>}
        <h3 className="font-semibold">{text('pcMoved')}</h3>
        <ul className="list-disc pl-5">{result.scheduled.map(id => <li key={id}>{name(id)}</li>)}</ul>
        <h3 className="font-semibold">{text('pcSkipped')}</h3>
        {!result.skipped.length && <p>{text('pcNone')}</p>}
        <ul className="list-disc pl-5">{result.skipped.map(row => <li key={row.id}>{name(row.id)}: {text('pcSkip_' + row.reason)}</li>)}</ul>
        <Button disabled={busy} onClick={() => { setBusy(true); void done().catch(() => { setError(text('error')); setBusy(false); }); }}>{text('pcDone')}</Button>
      </> : <>
        {!review && <>
          <fieldset disabled={locked || conflict} className="space-y-2"><legend className="font-semibold">{text('pcWho')}</legend>
            {(['new', 'all', 'chosen'] as const).map(value => <Label key={value} className="flex min-h-11 items-center gap-3">
              <input type="radio" name="price-choice" className="size-5 shrink-0" value={value} checked={choice === value} onChange={() => { setChoice(value); setConfirmed(false); }}/>{text('pcChoice_' + value)}
            </Label>)}
          </fieldset>
          {choice !== 'new' && <>
            {tooMany && <Alert role="alert">{text('pcLimit')}</Alert>}
            <fieldset disabled={locked || conflict} className="space-y-3">
              <Label className="block">{text('pcDate')}<Input type="date" min={preview.today} value={date} onChange={event => { setDate(event.target.value); setConfirmed(false); }}/></Label>
              {date !== preview.effectiveOn && <Button variant="outline" disabled={!isCalendarDate(date) || date < preview.today} onClick={() => void refreshDate()}>{text('pcRefresh')}</Button>}
              <Label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5 shrink-0" checked={sendNotice} disabled={!preview.canEmail}
                onChange={event => { setNotify(event.target.checked); setConfirmed(false); }}/>{text('pcNotify')}</Label>
              {!preview.canEmail && <p role="note">{text('pcEmailOff')}</p>}
              {choice === 'all' && <>
                <p>{say('pcFrozen', { count: selected.filter(row => row.status === 'frozen').length })}</p>
                <p>{say('pcExceptions', { commitments: preview.memberships.filter(row => !row.skipReason && row.inCommitment).length,
                  custom: preview.memberships.filter(row => !row.skipReason && row.customPrice).length })}</p>
                <Label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5 shrink-0" checked={include} onChange={event => setInclude(event.target.checked)}/>{text('pcInclude')}</Label>
              </>}
            </fieldset>
            <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="font-semibold">{text('pcFilters')}</legend>
              <Label className="block">{text('pcSearch')}<Input value={search} onChange={event => setSearch(event.target.value)}/></Label>
              <Label className="block">{text('pcStatus')}<select className={selectClass} value={status} onChange={event => setStatus(event.target.value)}><option value="">{text('pcAnyStatus')}</option>
                {[...new Set(preview.memberships.map(row => row.status))].map(value => <option key={value} value={value}>{text('pcStatus_' + value)}</option>)}
              </select></Label>
              <Label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5" checked={commitment} onChange={event => setCommitment(event.target.checked)}/>{text('pcCommitment')}</Label>
              <Label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5" checked={custom} onChange={event => setCustom(event.target.checked)}/>{text('pcCustom')}</Label>
            </fieldset>
            <p>{say('pcSelection', { count: selected.length, visible: visible.length })}</p>
            <StackedList className="md:hidden">{visible.map(row => <StackedItem key={row.id}>{selection(row)}{details(row)}</StackedItem>)}</StackedList>
            <TableContainer label={text('pcMembers')} className="hidden md:block"><table className="w-full text-left text-sm"><thead><tr>
              {['pcMember', 'pcCurrent', 'pcCommitmentEnd', 'pcCustom', 'pcStatus'].map(key => <th key={key} className="p-3">{text(key)}</th>)}
            </tr></thead><tbody>{visible.map(row => <tr key={row.id} className="border-t"><td className="min-w-48 p-3">{selection(row)}{row.skipReason && <p>{text('pcSkip_' + row.skipReason)}</p>}</td>
              <td className="p-3 whitespace-nowrap">{money(row.amountCents, row.currency)} / {text(row.interval)}</td><td className="p-3">{row.commitmentEndsOn ?? text('pcNone')}</td>
              <td className="p-3">{text(row.customPrice ? 'pcYes' : 'pcNo')}</td><td className="p-3">{text('pcStatus_' + row.status)}</td></tr>)}</tbody></table></TableContainer>
            {!visible.length && <p>{text('pcNoMatches')}</p>}
          </>}
        </>}
        {review && <section aria-label={text('pcSummary')} className="space-y-3">
          <h3 className="text-lg font-semibold">{text('pcSummary')}</h3>
          {choice === 'new' ? <p>{text('pcNewSummary')}</p> : <>
            <p>{say('pcScheduled', { count: selected.length, date })}</p><p>{text('pcCycles')}</p>
            <p>{say('pcNoticeCount', { count: sendNotice ? counts.reachable : 0 })}</p>
            <p>{say('pcNoAddress', { count: counts.noAddress })}</p><p>{say('pcSuppressed', { count: counts.suppressed })}</p><p>{say('pcErased', { count: counts.erased })}</p>
            {!sendNotice && <p>{text('pcNoNotices')}</p>}
            {choice === 'all' && <>
              <p>{say('pcFrozen', { count: selected.filter(row => row.status === 'frozen').length })}</p>
              <p>{say('pcStaying', { commitments: preview.memberships.filter(row => !row.skipReason && row.inCommitment && !include).length,
                custom: preview.memberships.filter(row => !row.skipReason && row.customPrice && !include).length })}</p>
            </>}
            {preview.switchesToPlan > 0 && <p>{say('pcIncoming', { count: preview.switchesToPlan })}</p>}
            {warning && <Alert role="note"><p>{text('pcWarning')}</p><Label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5 shrink-0" checked={confirmed}
              disabled={locked} onChange={event => setConfirmed(event.target.checked)}/>{text('pcConfirmWarning')}</Label></Alert>}
          </>}
        </section>}
        <div className="flex flex-col gap-2 sm:flex-row">
          {review ? <>
            <Button disabled={busy || conflict || (warning && !confirmed)} onClick={() => void apply()}>{text(busy ? 'saving' : attempted ? 'pcRetry' : 'pcApply')}</Button>
            {!attempted && <Button variant="outline" disabled={busy} onClick={() => setReview(false)}>{text('pcBack')}</Button>}
          </> : <Button disabled={busy || conflict || (choice !== 'new' && (!dateReady || !selected.length || (choice === 'all' && tooMany)))} onClick={() => setReview(true)}>{text('pcReview')}</Button>}
          {!attempted && <Button variant="outline" disabled={busy} onClick={cancel}>{text('cancel')}</Button>}
        </div>
      </>}
    </div>
  </Dialog>;
}
