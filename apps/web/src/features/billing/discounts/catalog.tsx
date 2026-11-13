// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Discount } from '@plaingym/shared/contracts';
import { Button } from '../../../components/ui/button.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { LoadingState, ErrorState, EmptyState } from '../../../components/ui/states.js';
import { billingClient, type BillingClient } from '../catalog/api.js';
import { discountClient, type DiscountClient } from './api.js';
import { DiscountEditor } from './editor.js';
import { benefit, text } from './messages.js';

export function DiscountCatalog({ gymId, client = discountClient, billing = billingClient }: { gymId: string; client?: DiscountClient; billing?: BillingClient }) {
  const cache = useQueryClient(), [inactive, setInactive] = useState(false), [editor, setEditor] = useState<Discount | 'new' | null>(null);
  // Under the catalog key, so plan saves in the section above reload this section's plan names and choices.
  const data = useQuery({ queryKey: ['billing', gymId, 'catalog', 'discounts'], queryFn: async () => {
    const [discounts, plans, settings] = await Promise.all([client.list(), billing.plans(), billing.settings()]);
    return { discounts, plans, currency: settings.currency };
  } });
  const refresh = () => { setEditor(null); void cache.invalidateQueries({ queryKey: ['billing', gymId] }); };
  const rows = data.data?.discounts.filter(row => inactive || row.active);
  return <section aria-label={text('title')} className="min-w-0 space-y-4 border-t pt-5 wrap-anywhere">
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    {data.isPending && <LoadingState/>}{data.isError && <ErrorState onRetry={() => void data.refetch()}/>}
    {data.data && <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CheckboxField label={text('showInactive')} checked={inactive} onChange={event => setInactive(event.target.checked)}/>
        <Button onClick={() => setEditor('new')}>{text('create')}</Button>
      </div>
      {!rows?.length && <EmptyState title={text('empty')} description={text('emptyHelp')}/>}
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2">{rows?.map(row => <li key={row.id} className="min-w-0 space-y-2 rounded-lg border p-4">
        <h3 className="font-semibold">{row.name}</h3><p>{text(row.active ? 'active' : 'inactive')}</p>
        <p>{benefit(row)}</p><p>{row.duration === 'cycles' ? text('forCycles', { count: row.cycles! }) : row.duration ? text(row.duration) : text('feeOnly')}</p>
        <p>{text('uses', { count: row.uses, max: row.maxUses ?? text('unlimited') })}</p>
        <p>{row.termsLocked ? text('locked') : text('termsHelp')}</p>
        {row.code && <p>{text('code')}: {row.code}</p>}{row.endsOn && <p>{text('endsOn')}: {row.endsOn}</p>}
        <p>{row.planIds.length ? text('selectedPlans', { names: row.planIds.map(id => data.data.plans.find(plan => plan.id === id)?.name ?? text('unavailablePlan')).join(', ') }) : text('allPlans')}</p>
        <Button variant="outline" className="w-full max-w-full wrap-anywhere sm:w-auto" onClick={() => setEditor(row)}>{text('editNamed', { name: row.name })}</Button>
      </li>)}</ul>
      {editor && <DiscountEditor {...(editor === 'new' ? {} : { record: editor })} currency={data.data.currency} plans={data.data.plans} client={client} close={refresh} saved={refresh}/>}
    </>}
  </section>;
}
