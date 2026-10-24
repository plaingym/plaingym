// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { useBootstrap } from '../../../app/context.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Card } from '../../../components/ui/card.js';
import { billingClient, type BillingClient } from './api.js';
import { CatalogEditor, type CatalogKind, type CatalogRecord } from './editor.js';
import { money, saveError, text } from './format.js';

export function CatalogWorkspace({ gymId, client = billingClient }: { gymId: string; client?: BillingClient }) {
  const cache = useQueryClient(), key = ['billing', gymId, 'catalog'];
  const [kind, setKind] = useState<CatalogKind>('plans'), [editor, setEditor] = useState<CatalogRecord | 'new' | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const data = useQuery({ queryKey: key, queryFn: async () => {
    const [plans, taxes, charges, settings] = await Promise.all([client.plans(), client.taxes(), client.charges(), client.settings()]);
    return { plans, taxes, charges, settings };
  } });
  async function save(input: Record<string, unknown>) {
    setBusy(true); setMessage('');
    try {
      const record = editor === 'new' ? undefined : editor;
      const operation = kind === 'plans' ? record ? 'updatePlan' : 'createPlan' : kind === 'taxes' ? record ? 'updateTaxRate' : 'createTaxRate' : record ? 'updateChargeType' : 'createChargeType';
      const params = record ? { [kind === 'plans' ? 'planId' : kind === 'taxes' ? 'taxRateId' : 'chargeTypeId']: record.id } : {};
      await client.call(operation, input, params); setEditor(null); await cache.invalidateQueries({ queryKey: key });
    } catch (error) { setMessage(saveError(error)); }
    finally { setBusy(false); }
  }
  return <div className="min-w-0 space-y-5">
    <div><h1 className="text-2xl font-semibold">{text('title')}</h1><p className="mt-1 text-muted-foreground">{text('help')}</p></div>
    {data.isPending && <p role="status">{text('loading')}</p>}
    {data.isError && <Alert role="alert">{text('error')} <Button variant="outline" onClick={() => void data.refetch()}>{text('retry')}</Button></Alert>}
    {data.data && <>
      <nav className="flex flex-wrap gap-2" aria-label={text('sections')}>{(['plans', 'taxes', 'charges'] as const).map(value => <Button key={value} aria-pressed={value === kind} variant={value === kind ? 'default' : 'outline'} disabled={busy} onClick={() => { setKind(value); setEditor(null); setMessage(''); }}>{text(value)}</Button>)}</nav>
      {message && <Alert role="alert">{message}</Alert>}
      {editor ? <CatalogEditor key={kind + (editor === 'new' ? 'new' : editor.id)} kind={kind} {...(editor === 'new' ? {} : { record: editor })} currency={data.data.settings.currency} taxes={data.data.taxes} busy={busy} save={save} cancel={() => { setEditor(null); setMessage(''); }}/>
        : <Button onClick={() => setEditor('new')}>{text('create')} {text(kind)}</Button>}
      {!data.data[kind].length && <Card><h2 className="font-semibold">{text('empty')}</h2><p className="mt-1 text-muted-foreground">{text('emptyHelp')}</p></Card>}
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2">{data.data[kind].map(record => <li key={record.id} className="min-w-0 rounded-lg border p-4">
        <h2 className="break-words text-lg font-medium">{record.name}</h2><p className="text-sm text-muted-foreground">{text(record.active ? 'active' : 'inactive')}</p>
        {'amountCents' in record ? <p className="mt-2 break-words">{money(record.amountCents, record.currency)} {'interval' in record ? '/ ' + text(record.interval) : ''}</p> : <p className="mt-2">{record.rateMillionths / 10_000}% · {text(record.inclusive ? 'inclusive' : 'exclusive')}</p>}
        {'signupFeeCents' in record && <p className="text-sm">{text('signupFee')}: {money(record.signupFeeCents, record.currency)} · {text('trialDays')}: {record.trialDays}</p>}
        <Button className="mt-3 w-full sm:w-auto" variant="outline" onClick={() => { setEditor(record); setMessage(''); }} disabled={busy}>{text('edit')} {record.name}</Button>
      </li>)}</ul>
    </>}
  </div>;
}
export function CatalogPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{text('loading')}</p>;
  if (!bootstrap.data?.session || !canStaff(bootstrap.data.session.roles, 'plans.manage')) return <Alert>{text('noAccess')}</Alert>;
  return <CatalogWorkspace key={bootstrap.data.gym.id} gymId={bootstrap.data.gym.id}/>;
}
