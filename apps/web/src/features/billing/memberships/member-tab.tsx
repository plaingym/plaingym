// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import type { Membership, Plan } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import type { ExtensionViewProps } from '../../../lib/registries.js';
import { t } from '../../../lib/i18n.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { billingClient, type BillingClient } from '../catalog/api.js';
import { money, saveError, selectClass } from '../catalog/format.js';
import { householdBillingDate } from './calendar.js';

const text = (key: string) => t('billing/memberships:' + key);
type Action = 'activateMembership' | 'freezeMembership' | 'resumeMembership' | 'cancelMembership';
export function MembershipPanel({ gymId, memberId, manage, client = billingClient, now }: {
  gymId: string; memberId: string; manage: boolean; client?: BillingClient; now?: Date;
}) {
  const cache = useQueryClient(), key = ['billing', gymId, 'memberships'];
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const rows = useQuery({ queryKey: [...key, memberId], queryFn: () => client.memberships({ memberId }) });
  const setup = useQuery({ queryKey: [...key, memberId, 'assignment'], enabled: manage, queryFn: async () => {
    const [plans, member, settings] = await Promise.all([client.plans(), client.member(memberId), client.settings()]);
    const [household, billing] = await Promise.all([client.memberships({ householdId: member.householdId }), client.householdBilling(member.householdId)]);
    return { plans, member, settings, household, billingDay: billing.billingDay };
  } });
  async function mutate(operation: Action | 'assignMembership', input: unknown, membershipId?: string) {
    setBusy(true); setMessage('');
    try {
      await client.call(operation, input, membershipId ? { membershipId } : {});
      await cache.invalidateQueries({ queryKey: key });
      setMessage(text('saved')); return true;
    } catch (error) { setMessage(saveError(error)); return false; }
    finally { setBusy(false); }
  }
  return <section className="min-w-0 space-y-4" aria-label={text('title')}>
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    {message && <Alert role="status">{message}</Alert>}
    {rows.isPending && <p role="status">{text('loading')}</p>}
    {rows.isError && <Alert role="alert">{text('error')} <Button variant="outline" onClick={() => void rows.refetch()}>{text('retry')}</Button></Alert>}
    {rows.data?.length === 0 && <p className="rounded-lg border p-4 text-muted-foreground">{text('empty')}</p>}
    <ul className="space-y-3">{rows.data?.map(row => <MembershipCard key={row.id} row={row} plans={setup.data?.plans ?? []} manage={manage} busy={busy} mutate={mutate}/>)}</ul>
    {manage && <>
      {setup.isPending && <p role="status">{text('loading')}</p>}
      {setup.isError && <Alert role="alert">{text('error')} <Button variant="outline" onClick={() => void setup.refetch()}>{text('retry')}</Button></Alert>}
      {setup.data && <AssignmentForm key={memberId} plans={setup.data.plans.filter(plan => plan.active)}
        householdId={setup.data.member.householdId} memberId={memberId} busy={busy} assign={data => mutate('assignMembership', data)}
        today={localDate(now ?? new Date(), setup.data.settings.timezone)}
        billingDate={startsOn => householdBillingDate(startsOn, setup.data.household, setup.data.billingDay)}/>
      }
    </>}
  </section>;
}
function AssignmentForm({ plans, memberId, householdId, today, billingDate, busy, assign }: {
  plans: Plan[]; memberId: string; householdId: string; today: string; billingDate: (startsOn: string) => string; busy: boolean;
  assign: (data: unknown) => Promise<boolean>;
}) {
  const [chosen, setChosen] = useState(''), [formKey, setFormKey] = useState(0);
  // The billing date follows the start date until staff edit it.
  const [startsOn, setStartsOn] = useState(today), [nextDueOn, setNextDueOn] = useState<string | null>(null);
  const planId = chosen || plans[0]?.id || '', plan = plans.find(item => item.id === planId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (await assign({ memberId, householdId, planId, startsOn: form.get('startsOn'), nextDueOn: form.get('nextDueOn'), firstPeriod: form.get('firstPeriod') })) {
      setFormKey(value => value + 1); setStartsOn(today); setNextDueOn(null);
    }
  }
  return <form key={formKey} onSubmit={event => void submit(event)} className="min-w-0 space-y-4 rounded-lg border p-4">
    <h3 className="font-semibold">{text('assign')}</h3>
    {!plans.length ? <p>{text('noPlans')}</p> : <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
      <Label className="block min-w-0 sm:col-span-2">{text('plan')}<select className={selectClass} value={planId} onChange={event => setChosen(event.target.value)}>{plans.map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.amountCents, item.currency)}</option>)}</select></Label>
      {plan && <p className="text-sm text-muted-foreground sm:col-span-2">{text('signupFee')}: {money(plan.signupFeeCents, plan.currency)} · {text('trialDays')}: {plan.trialDays}</p>}
      <Label className="block min-w-0">{text('startsOn')}<Input name="startsOn" type="date" required value={startsOn}
        onChange={event => { setStartsOn(event.target.value); setNextDueOn(null); }}/></Label>
      <Label className="block min-w-0">{text('nextDueOn')}<Input name="nextDueOn" type="date" required
        value={nextDueOn ?? (startsOn ? billingDate(startsOn) : '')} onChange={event => setNextDueOn(event.target.value)}/></Label>
      <p className="text-sm text-muted-foreground sm:col-span-2">{text('alignmentHelp')}</p>
      <Label className="block min-w-0 sm:col-span-2">{text('firstPeriod')}<select className={selectClass} name="firstPeriod" defaultValue="prorate_now"><option value="prorate_now">{text('prorateNow')}</option><option value="next_billing_date">{text('nextBillingDate')}</option></select></Label>
      <p className="text-sm text-muted-foreground sm:col-span-2">{text('assignmentHelp')}</p>
      <Button className="sm:col-span-2" type="submit">{text(busy ? 'saving' : 'assign')}</Button>
    </fieldset>}
  </form>;
}
function MembershipCard({ row, plans, manage, busy, mutate }: {
  row: Membership; plans: Plan[]; manage: boolean; busy: boolean;
  mutate: (operation: Action, input: unknown, membershipId: string) => Promise<boolean>;
}) {
  const [confirm, setConfirm] = useState(false), [action, setAction] = useState<'freeze' | 'resume' | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const input = action === 'freeze' ? { resumesOn: form.get('date') || null } : { nextDueOn: form.get('date') };
    if (await mutate(action === 'freeze' ? 'freezeMembership' : 'resumeMembership', { revision: row.revision, ...input }, row.id)) setAction(null);
  }
  return <li className="min-w-0 space-y-3 rounded-lg border p-4">
    <div><h3 className="break-words font-semibold">{plans.find(plan => plan.id === row.planId)?.name ?? text('membership')}</h3><p>{text(row.status)} · {money(row.amountCents, row.currency)} / {text(row.interval)}</p></div>
    <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{text('nextDueOn')}</dt><dd>{row.nextDueOn}</dd></div>
      {row.commitmentEndsOn && <div><dt className="text-muted-foreground">{text('commitmentEndsOn')}</dt><dd>{row.commitmentEndsOn}</dd></div>}
      {row.trialEndsOn && <div><dt className="text-muted-foreground">{text('trialEndsOn')}</dt><dd>{row.trialEndsOn}</dd></div>}
      {row.status === 'frozen' && <div><dt className="text-muted-foreground">{text('resumesOn')}</dt><dd>{row.resumesOn ?? text('indefinite')}</dd></div>}
    </dl>
    {manage && row.status !== 'cancelled' && <fieldset disabled={busy} className="min-w-0 space-y-3">
      <div className="flex flex-col flex-wrap gap-2 sm:flex-row">
        {row.status === 'pending' && <Button onClick={() => void mutate('activateMembership', { revision: row.revision }, row.id)}>{text('activate')}</Button>}
        {['active', 'trial'].includes(row.status) && <Button variant="outline" onClick={() => { setAction('freeze'); setConfirm(false); }}>{text('freeze')}</Button>}
        {row.status === 'frozen' && <Button variant="outline" onClick={() => { setAction('resume'); setConfirm(false); }}>{text('resume')}</Button>}
        <Button variant="outline" onClick={() => { setConfirm(true); setAction(null); }}>{text('cancel')}</Button>
      </div>
      {confirm && <div className="space-y-2"><p>{text('confirmCancel')}</p><div className="flex flex-col gap-2 sm:flex-row"><Button onClick={async () => { if (await mutate('cancelMembership', { revision: row.revision }, row.id)) setConfirm(false); }}>{text('confirm')}</Button><Button variant="outline" onClick={() => setConfirm(false)}>{text('back')}</Button></div></div>}
      {action && <form onSubmit={event => void submit(event)} className="space-y-3">
        <p className="text-sm text-muted-foreground">{text(action === 'freeze' ? 'freezeHelp' : 'resumeHelp')}</p>
        <Label className="block min-w-0">{text(action === 'freeze' ? 'resumesOn' : 'nextDueOn')}<Input type="date" name="date" required={action === 'resume'} {...(action === 'resume' ? { min: row.nextDueOn, defaultValue: row.nextDueOn } : {})}/></Label>
        <div className="flex flex-col gap-2 sm:flex-row"><Button type="submit">{text('save')}</Button><Button variant="outline" onClick={() => setAction(null)}>{text('back')}</Button></div>
      </form>}
    </fieldset>}
  </li>;
}
export function MembershipTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{text('loading')}</p>;
  if (!memberId || !bootstrap.data?.session || !canStaff(bootstrap.data.session.roles, 'billing.read')) return null;
  return <MembershipPanel key={bootstrap.data.gym.id + memberId} gymId={bootstrap.data.gym.id} memberId={memberId} manage={canStaff(bootstrap.data.session.roles, 'plans.manage')}/>;
}
