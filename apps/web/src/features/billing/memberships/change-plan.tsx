// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Membership, MembershipSwitchResult, Plan, PlanSwitchTiming } from '@plaingym/shared/contracts';
import { t } from '../../../lib/i18n.js';
import { ApiError } from '../../../lib/api.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Label } from '../../../components/ui/label.js';
import { Textarea } from '../../../components/ui/select.js';
import type { BillingClient } from '../catalog/api.js';
import { money, selectClass } from '../catalog/format.js';
import { text as discountText } from '../discounts/messages.js';

const text = (key: string, values?: Record<string, string | number>) => t('billing/memberships:' + key, values);
/** A known refusal's translation, otherwise the fallback for the operation that failed. */
function refusal(error: unknown, fallback = error instanceof ApiError && error.status === 409 ? 'switchStale' : 'switchFailed') {
  if (error instanceof ApiError) for (const code of error.reason) {
    const key = 'reason_' + code, message = text(key);
    if (message !== 'billing/memberships:' + key) return message;
  }
  return text(fallback);
}
/** Why "now" can't be chosen for this membership and plan, or null when it can. */
export function nowBlocked(row: Membership, plan: Plan | undefined) {
  if (row.status !== 'active') return text('reason_not_active');
  if (plan && plan.interval !== row.interval) return text('reason_interval_change');
  return null;
}
export function ChangePlanDialog({ row, plans, client, close, changed, reload, gymId }: {
  row: Membership; plans: Plan[]; client: BillingClient; close: () => void; gymId: string;
  changed: (result: MembershipSwitchResult) => void; reload: () => Promise<void>;
}) {
  const options = plans.filter(plan => plan.active && plan.currency === row.currency && plan.id !== row.planId);
  const [chosen, setChosen] = useState(''), [wanted, setWanted] = useState<PlanSwitchTiming>('next_billing_date');
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // Each distinct submission (plan, timing, whether it carries a reason) keeps one request ID for as long as the
  // dialog is open, so a retry after a lost response replays instead of switching twice.
  const inFlight = useRef(false), submissions = useRef(new Map<string, string>());
  const planId = options.some(plan => plan.id === chosen) ? chosen : options[0]?.id ?? '';
  const plan = options.find(item => item.id === planId);
  const blocked = nowBlocked(row, plan), timing: PlanSwitchTiming = blocked ? 'next_billing_date' : wanted;
  const cache = useQueryClient();
  const key = ['billing', gymId, 'memberships'];
  const preview = useQuery({ enabled: !!planId, retry: false, queryKey: [...key, row.id, 'switch-preview', row.revision, planId, timing],
    queryFn: async () => (await client.call('previewMembershipSwitch', undefined, { membershipId: row.id }, { planId, timing })).data });
  // A refetch that failed keeps the last preview's data: never offer a submit on it.
  const data = preview.isError ? undefined : preview.data, needsReason = !!data?.commitmentBlocks;
  function choose(next: string) {
    setChosen(next); setError('');
    // "Now" stays chosen only while it can be: a plan that blocks it drops the timing back to the next billing date.
    if (nowBlocked(row, options.find(item => item.id === next))) setWanted('next_billing_date');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = reason.trim();
    if (inFlight.current || !data || !planId || (needsReason && !note)) return;
    const fingerprint = [planId, timing, needsReason].join('|');
    const requestId = submissions.current.get(fingerprint) ?? crypto.randomUUID();
    submissions.current.set(fingerprint, requestId);
    inFlight.current = true; setBusy(true); setError('');
    try {
      const result = await client.call('switchMembershipPlan', { revision: row.revision, requestId, planId, timing, ...(needsReason ? { override: { reason: note } } : {}) },
        { membershipId: row.id });
      changed(result.data);
    } catch (cause) {
      setError(refusal(cause));
      // A stale revision or a refusal means the membership changed: show it as it is now.
      // Membership invalidation includes the preview; refresh plans in case one was archived meanwhile.
      if (cause instanceof ApiError && cause.status === 409) await Promise.all([reload(),
        cache.invalidateQueries({ queryKey: ['billing', gymId, 'plans'] })]).catch(() => undefined);
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={text('changePlanTitle')} closeLabel={text('close')} onClose={close} dismissible={!busy}>
    <form className="min-w-0 space-y-4 wrap-anywhere" onSubmit={event => void submit(event)}>
      {error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
      {!options.length ? <p>{text('noOtherPlans')}</p> : <fieldset disabled={busy} className="min-w-0 space-y-4">
        <p className="text-sm text-muted-foreground">{text('changePlanCurrent', { plan: plans.find(item => item.id === row.planId)?.name ?? text('membership'), price: money(row.amountCents, row.currency), interval: text(row.interval) })}</p>
        <Label className="block min-w-0">{text('newPlan')}<select className={selectClass} value={planId} onChange={event => choose(event.target.value)}>
          {options.map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.amountCents, item.currency)} / {text(item.interval)}</option>)}</select></Label>
        <div role="radiogroup" aria-label={text('timing')} className="min-w-0 space-y-2">
          <p className="font-medium">{text('timing')}</p>
          <Label className="flex min-h-11 items-center gap-3"><input type="radio" className="size-5 shrink-0 accent-primary" name="timing" value="next_billing_date" checked={timing === 'next_billing_date'}
            onChange={() => setWanted('next_billing_date')}/>{text('timingNext', { date: row.nextDueOn })}</Label>
          <Label className="flex min-h-11 items-center gap-3"><input type="radio" className="size-5 shrink-0 accent-primary" name="timing" value="now" checked={timing === 'now'} disabled={!!blocked}
            onChange={() => setWanted('now')}/>{text('timingNow')}</Label>
          {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
        </div>
        {preview.isPending && <p role="status">{text('previewLoading')}</p>}
        {preview.isError && <Alert variant="error" role="alert">{refusal(preview.error, 'previewFailed')} <Button variant="outline" disabled={preview.isFetching}
          onClick={() => void preview.refetch()}>{text('retry')}</Button></Alert>}
        {data && <div className="min-w-0 space-y-2 rounded-lg border p-4 text-sm" aria-label={text('preview')}>
          <p className="font-medium">{text('kind_' + data.kind)}</p>
          <p>{discountText(data.discount === 'none' ? 'noDiscount' : data.discount)}</p>
          <p>{text(row.status !== 'active' ? 'priceWhenActive' : timing === 'now' && data.kind === 'upgrade' ? 'priceStartsToday' : 'priceStartsOn',
            { date: data.priceStartsOn, price: money(plan!.amountCents, data.currency) })}</p>
          {timing === 'now' && data.kind === 'downgrade' && <p>{text('keepsPrice', { date: row.nextDueOn })}</p>}
          {timing === 'now' && data.kind === 'upgrade' && (data.proration && data.proration.totalCents > 0
            ? <p className="font-medium">{text('chargedNow', { total: money(data.proration.totalCents, data.currency), days: data.proration.billedDays, periodDays: data.proration.periodDays })}</p>
            : <p>{text('noCharge')}</p>)}
          {data.commitmentBlocks && <p>{text('commitmentBlocks', { date: row.commitmentEndsOn ?? '' })}</p>}
        </div>}
        {needsReason && <Label className="block min-w-0">{text('overrideReason')}<Textarea value={reason} required maxLength={500}
          onChange={event => setReason(event.target.value)}/></Label>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={!data || (needsReason && !reason.trim())}>{text(busy ? 'saving' : 'changePlanConfirm')}</Button>
          <Button variant="outline" onClick={close}>{text('back')}</Button>
        </div>
      </fieldset>}
    </form>
  </Dialog>;
}
