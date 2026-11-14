// SPDX-License-Identifier: AGPL-3.0-only
import { dateFormatter } from '../../../lib/instant.js';
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import { useBootstrap } from '../../../app/context.js';
import type { ExtensionViewProps } from '../../../lib/registries.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Pager } from '../../../components/ui/pager.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { userNames } from '../../../components/ui/page.js';
import { LoadingState, ErrorState } from '../../../components/ui/states.js';
import { InvoiceDetails, type InvoiceAccess } from '../invoices/detail.js';
import { packCatalogKey, packClient, type PackClient } from './api.js';
import { AdjustmentForm, SaleForm } from './forms.js';
import { text } from './messages.js';

export function PackPanel({ gymId, memberId, timezone, access, client = packClient }: {
  gymId: string; memberId: string; timezone: string; access: InvoiceAccess; client?: PackClient;
}) {
  const cache = useQueryClient(), key = ['billing', gymId, 'credits', memberId];
  const [offset, setOffset] = useState(0), [action, setAction] = useState<'sale' | 'adjust' | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [refreshUntil, setRefreshUntil] = useState(0);
  // Keep the current page on screen while the next one loads, so the pager keeps its place and focus.
  const ledger = useQuery({ queryKey: [...key, offset], queryFn: () => client.ledger(memberId, offset), placeholderData: keepPreviousData,
    // Invoice settlement publishes credit effects asynchronously; briefly follow their completion after collection.
    refetchInterval: () => Date.now() < refreshUntil ? 2000 : false });
  const packs = useQuery({ queryKey: packCatalogKey(gymId), queryFn: () => client.packs(), enabled: access.record && action === 'sale' });
  function changed() { setAction(null); setOffset(0); void cache.invalidateQueries({ queryKey: ['billing', gymId] }); }
  const date = (value: string) => dateFormatter('instant', timezone).format(new Date(value));
  const invoice = (id: string | null, number: number | null) => id === null || number === null ? null : <Button variant="link" className="w-full sm:w-auto" onClick={() => setInvoiceId(id)}>{text('invoiceNumber', { number })}</Button>;
  return <section aria-label={text('tabTitle')} className={'min-w-0 space-y-5 ' + userNames}>
    <h2 className="text-lg font-semibold">{text('tabTitle')}</h2>
    {ledger.isPending && <LoadingState/>}{ledger.isError && <ErrorState onRetry={() => void ledger.refetch()}/>}
    {ledger.data && <>
      <div className="space-y-3"><p className="text-xl font-semibold">{text('balance', { count: ledger.data.data.balance })}</p>
        <p className="text-sm text-muted-foreground">{text('refreshHelp')}</p>
        <Button variant="outline" disabled={ledger.isFetching} onClick={() => void ledger.refetch()}>{text('refresh')}</Button>
      </div>
      <div className="space-y-3"><h3 className="font-semibold">{text('lots')}</h3>
        {!ledger.data.data.lots.length && <p className="text-muted-foreground">{text('noLots')}</p>}
        <ul className="grid min-w-0 gap-3 lg:grid-cols-2">{ledger.data.data.lots.map(lot => <li key={lot.id} className="min-w-0 space-y-2 rounded-lg border p-4">
          <p className="font-medium">{text('remaining', { count: lot.remaining })}</p>
          <p>{lot.expiresAt ? text('expiresAt', { date: date(lot.expiresAt) }) : text('neverExpires')}</p>{invoice(lot.invoiceId, lot.invoiceNumber)}
        </li>)}</ul>
      </div>
      <div className="space-y-3"><h3 className="font-semibold">{text('ledger')}</h3>
        {!ledger.data.data.entries.length && <p className="text-muted-foreground">{text('noEntries')}</p>}
        <ul className="space-y-3">{ledger.data.data.entries.map(entry => <li key={entry.id} className="min-w-0 space-y-2 rounded-lg border p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between"><p className="font-medium">{text('kind.' + entry.kind)} · {text('creditCount', { count: entry.credits })}</p><p className="text-sm text-muted-foreground">{date(entry.createdAt)}</p></div>
          {entry.reason && <p className="whitespace-pre-wrap">{entry.reason}</p>}{invoice(entry.invoiceId, entry.invoiceNumber)}
        </li>)}</ul>
        <Pager offset={offset} total={ledger.data.pagination.total} limit={25} disabled={ledger.isPlaceholderData} onChange={setOffset} previousLabel={text('previous')} nextLabel={text('next')}>
          <span>{text('page', { start: Math.min(offset + 1, ledger.data.pagination.total).toLocaleString(), end: Math.min(offset + 25, ledger.data.pagination.total).toLocaleString(), total: ledger.data.pagination.total.toLocaleString() })}</span>
        </Pager>
      </div>
    </>}
    {access.record && <div className="flex flex-col gap-3 sm:flex-row">
      <Button onClick={() => setAction('sale')}>{text('sell')}</Button>
      <Button variant="outline" onClick={() => setAction('adjust')}>{text('adjust')}</Button>
    </div>}
    {action === 'sale' && access.record && <>
      {packs.isPending && <LoadingState/>}{packs.isError && <ErrorState onRetry={() => void packs.refetch()}/>}
      {packs.data && <SaleForm memberId={memberId} packs={packs.data} today={localDate(new Date(), timezone)} client={client} close={() => setAction(null)} sold={id => { changed(); setRefreshUntil(Date.now() + 60_000); setInvoiceId(id); }}/>}
    </>}
    {action === 'adjust' && access.record && <AdjustmentForm memberId={memberId} client={client} close={() => setAction(null)} adjusted={changed}/>}
    {invoiceId && <Dialog size="wide" title={text('invoice')} closeLabel={text('close')} onClose={() => setInvoiceId(null)}>
      <InvoiceDetails key={invoiceId} gymId={gymId} invoiceId={invoiceId} access={access} onCreditChange={() => { setRefreshUntil(Date.now() + 60_000); void cache.invalidateQueries({ queryKey: key }); }}/>
    </Dialog>}
  </section>;
}
export function PacksTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap(), roles = bootstrap.data?.session?.roles ?? [];
  if (bootstrap.isPending) return <LoadingState/>;
  if (bootstrap.isError) return <ErrorState onRetry={() => void bootstrap.refetch()}/>;
  if (!memberId || !bootstrap.data || !canStaff(roles, 'billing.read')) return <Alert variant="error">{text('denied')}</Alert>;
  return <PackPanel key={bootstrap.data.gym.id + memberId} gymId={bootstrap.data.gym.id} memberId={memberId} timezone={bootstrap.data.gym.timezone}
    access={{ record: canStaff(roles, 'payments.record'), refund: canStaff(roles, 'refunds.create'), links: canStaff(roles, 'links.send') }}/>;
}
