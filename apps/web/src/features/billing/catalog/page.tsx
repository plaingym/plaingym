// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import type { ChargeType, Plan, TaxRate, TaxRateUsage } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Card } from '../../../components/ui/card.js';
import { userNames } from '../../../components/ui/page.js';
import { ApiError } from '../../../lib/api.js';
import { cn } from '../../../lib/utils.js';
import { billingClient, type BillingClient } from './api.js';
import { ArchiveConfirmation, CatalogEditor, say, type CatalogKind, type CatalogRecord } from './editor.js';
import { money, saveError, text } from './format.js';

type Archive = { rate: TaxRate; input: Record<string, unknown>; usage: TaxRateUsage };
const carries = (record: Plan | ChargeType, rate: string) => record.taxRateIds.includes(rate);

export function CatalogWorkspace({ gymId, client = billingClient }: { gymId: string; client?: BillingClient }) {
  const cache = useQueryClient(), key = ['billing', gymId, 'catalog'];
  const [kind, setKind] = useState<CatalogKind>('plans'), [editor, setEditor] = useState<CatalogRecord | 'new' | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [archive, setArchive] = useState<Archive | null>(null);
  const data = useQuery({ queryKey: key, queryFn: async () => {
    const [plans, taxes, charges, settings] = await Promise.all([client.plans(), client.taxes(), client.charges(), client.settings()]);
    return { plans, taxes, charges, settings };
  } });
  async function run(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); } catch (error) { setMessage(saveError(error)); } finally { setBusy(false); }
  }
  /** Archiving a rate that charge types or plans carry first shows them and asks to remove it from all of them. */
  async function needsDetach(rate: TaxRate, input: Record<string, unknown>) {
    const { data: usage } = await client.call('getTaxRateUsage', undefined, { taxRateId: rate.id });
    if (!usage.chargeTypes.length && !usage.plans.length) return false;
    setArchive({ rate, input, usage }); return true;
  }
  const save = (input: Record<string, unknown>) => run(async () => {
    const record = editor === 'new' ? undefined : editor;
    // Only archiving an active rate needs the detach; a rate archived before that rule stays editable as it is.
    const archiving = kind === 'taxes' && record && 'rateMillionths' in record && record.active && input.active === false ? record : undefined;
    if (archiving && await needsDetach(archiving, input)) return;
    const operation = kind === 'plans' ? record ? 'updatePlan' : 'createPlan' : kind === 'taxes' ? record ? 'updateTaxRate' : 'createTaxRate' : record ? 'updateChargeType' : 'createChargeType';
    const params = record ? { [kind === 'plans' ? 'planId' : kind === 'taxes' ? 'taxRateId' : 'chargeTypeId']: record.id } : {};
    try { await client.call(operation, input, params); } catch (error) {
      // Something attached the rate since the check: show what carries it now.
      if (archiving && error instanceof ApiError && error.status === 409 && await needsDetach(archiving, input)) return;
      throw error;
    }
    setEditor(null); await cache.invalidateQueries({ queryKey: key });
  });
  const confirmArchive = () => run(async () => {
    if (!archive) return;
    try { await client.call('updateTaxRate', { ...archive.input, active: false, detach: true }, { taxRateId: archive.rate.id }); } catch (error) {
      // The rate changed since the panel opened: close it and reload, so a retry starts from what is there now.
      if (error instanceof ApiError && error.status === 409) { setArchive(null); await cache.invalidateQueries({ queryKey: key }); }
      throw error;
    }
    setArchive(null); setEditor(null); await cache.invalidateQueries({ queryKey: key });
  });
  const removeEverywhere = (rate: TaxRate) => run(async () => {
    setEditor(null);
    if (!await needsDetach(rate, { revision: rate.revision, active: false })) await cache.invalidateQueries({ queryKey: key });
  });
  const removeArchived = (record: Plan | ChargeType, archived: readonly TaxRate[]) => run(async () => {
    const input = { revision: record.revision, taxRateIds: record.taxRateIds.filter(id => !archived.some(rate => rate.id === id)) };
    await client.call('interval' in record ? 'updatePlan' : 'updateChargeType', input, 'interval' in record ? { planId: record.id } : { chargeTypeId: record.id });
    await cache.invalidateQueries({ queryKey: key });
  });
  const switchTo = (value: CatalogKind) => { setKind(value); setEditor(null); setArchive(null); setMessage(''); };
  return <div className={cn('min-w-0 space-y-5', userNames)}>
    <div><h1 className="text-2xl font-semibold">{text('title')}</h1><p className="mt-1 text-muted-foreground">{text('help')}</p></div>
    {data.isPending && <p role="status">{text('loading')}</p>}
    {data.isError && <Alert role="alert">{text('error')} <Button variant="outline" onClick={() => void data.refetch()}>{text('retry')}</Button></Alert>}
    {data.data && <>
      <nav className="flex flex-wrap gap-2" aria-label={text('sections')}>{(['plans', 'taxes', 'charges'] as const).map(value => <Button key={value} aria-pressed={value === kind} variant={value === kind ? 'default' : 'outline'} disabled={busy} onClick={() => switchTo(value)}>{text(value)}</Button>)}</nav>
      {message && <Alert role="alert">{message}</Alert>}
      {archive && <ArchiveConfirmation rate={archive.rate} usage={archive.usage} busy={busy} confirm={confirmArchive} cancel={() => { setArchive(null); setMessage(''); }}/>}
      {editor ? <CatalogEditor key={kind + (editor === 'new' ? 'new' : editor.id)} kind={kind} {...(editor === 'new' ? {} : { record: editor })} currency={data.data.settings.currency} taxes={data.data.taxes} busy={busy} locked={archive !== null} save={save} cancel={() => { setEditor(null); setArchive(null); setMessage(''); }}/>
        : !archive && <Button onClick={() => setEditor('new')}>{text('create')} {text(kind)}</Button>}
      {!data.data[kind].length && <Card><h2 className="font-semibold">{text('empty')}</h2><p className="mt-1 text-muted-foreground">{text('emptyHelp')}</p></Card>}
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2">{data.data[kind].map(record => {
        const priced = 'taxRateIds' in record ? record : undefined;
        const archived = priced ? data.data.taxes.filter(rate => !rate.active && carries(priced, rate.id)) : [];
        const carriers = 'rateMillionths' in record && !record.active ? [...data.data.plans, ...data.data.charges].filter(item => carries(item, record.id)).length : 0;
        return <li key={record.id} className="min-w-0 rounded-lg border p-4">
          <h2 className="text-lg font-medium">{record.name}</h2><p className="text-sm text-muted-foreground">{text(record.active ? 'active' : 'inactive')}</p>
          {'amountCents' in record ? <p className="mt-2">{money(record.amountCents, record.currency)} {'interval' in record ? '/ ' + text(record.interval) : ''}</p> : <p className="mt-2">{record.rateMillionths / 10_000}% · {text(record.inclusive ? 'inclusive' : 'exclusive')}</p>}
          {'signupFeeCents' in record && <p className="text-sm">{text('signupFee')}: {money(record.signupFeeCents, record.currency)} · {text('trialDays')}: {record.trialDays}</p>}
          {priced && archived.length > 0 && <Alert role="note" className="mt-3 space-y-2">
            <p>{say('interval' in priced ? 'archivedOnPlan' : 'archivedOnCharge', { names: archived.map(rate => rate.name).join(', ') })}</p>
            <Button variant="outline" className="w-full wrap-anywhere sm:w-auto" disabled={busy} onClick={() => void removeArchived(priced, archived)}>{say('removeArchived', { name: record.name })}</Button>
          </Alert>}
          {carriers > 0 && 'rateMillionths' in record && <Alert role="note" className="mt-3 space-y-2">
            <p>{say('archivedRate', { count: carriers })}</p>
            <Button variant="outline" className="w-full wrap-anywhere sm:w-auto" disabled={busy} onClick={() => void removeEverywhere(record)}>{say('removeEverywhere', { name: record.name })}</Button>
          </Alert>}
          <Button className="mt-3 w-full wrap-anywhere sm:w-auto" variant="outline" onClick={() => { setEditor(record); setArchive(null); setMessage(''); }} disabled={busy}>{text('edit')} {record.name}</Button>
        </li>;
      })}</ul>
    </>}
  </div>;
}
export function CatalogPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{text('loading')}</p>;
  if (!bootstrap.data?.session || !canStaff(bootstrap.data.session.roles, 'plans.manage')) return <Alert>{text('noAccess')}</Alert>;
  return <CatalogWorkspace key={bootstrap.data.gym.id} gymId={bootstrap.data.gym.id}/>;
}
