// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import type { InvoiceStatus } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import type { ExtensionViewProps } from '../../../lib/registries.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { LoadingState, EmptyState, ErrorState } from '../../../components/ui/states.js';
import { StackedList, StackedItem, Badge } from '../../../components/ui/table.js';
import { Button } from '../../../components/ui/button.js';
import { Label } from '../../../components/ui/label.js';
import { Select } from '../../../components/ui/select.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { invoiceClient, type InvoiceClient } from './api.js';
import { InvoiceDetails, type InvoiceAccess } from './detail.js';
import { OneOffEditor } from './editor.js';
import { money, text } from './format.js';

export function InvoiceList({ gymId, householdId, access, client = invoiceClient }: {
  gymId: string; householdId?: string; access: InvoiceAccess; client?: InvoiceClient;
}) {
  const cache = useQueryClient();
  const [status, setStatus] = useState<InvoiceStatus | ''>(''), [offset, setOffset] = useState(0);
  const [create, setCreate] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const rows = useQuery({ queryKey: ['billing', gymId, 'invoices', householdId, status, offset],
    queryFn: () => client.invoices({ ...(householdId ? { householdId } : {}), ...(status ? { status } : {}), offset }) });
  return <div className="min-w-0 space-y-4">
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <Label className="block min-w-0 sm:w-56">{text('status')}<Select value={status} onChange={event => { setStatus(event.target.value as InvoiceStatus | ''); setOffset(0); }}>
        <option value="">{text('all')}</option>{(['draft', 'open', 'processing', 'past_due', 'paid', 'void', 'partially_refunded', 'refunded'] as const).map(value => <option value={value} key={value}>{text(value)}</option>)}
      </Select></Label>
      {access.record && <Button onClick={() => setCreate(true)}>{text('create')}</Button>}
    </div>
    {rows.isPending && <LoadingState/>}{rows.isError && <ErrorState onRetry={() => void rows.refetch()}/>}
    {rows.data?.data.length === 0 && <EmptyState title={text('empty')} description={text('emptyHelp')}/>}
    <StackedList>{rows.data?.data.map(invoice => <StackedItem key={invoice.id}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="font-semibold">{text('number')} {invoice.number ?? text('draft')}</span><Badge>{text(invoice.status)}</Badge></div>
      {!householdId && <HouseholdName gymId={gymId} householdId={invoice.householdId} client={client}/>}
      <p>{money(invoice.amountCents, invoice.currency)} · {invoice.dueOn}</p>
      <Button variant="outline" onClick={() => setSelected(invoice.id)}>{text('viewInvoice')} {invoice.number ?? text('draft')}</Button>
    </StackedItem>)}</StackedList>
    {rows.data && <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={!offset} onClick={() => setOffset(v => v - 25)}>{text('previous')}</Button>
      <span>{Math.min(offset + 1, rows.data.pagination.total)}–{Math.min(offset + 25, rows.data.pagination.total)} / {rows.data.pagination.total}</span>
      <Button variant="outline" disabled={offset + 25 >= rows.data.pagination.total} onClick={() => setOffset(v => v + 25)}>{text('next')}</Button>
    </div>}
    {create && <OneOffEditor gymId={gymId} {...(householdId ? { householdId } : {})} client={client} close={() => setCreate(false)} created={invoiceId => {
      setCreate(false); setSelected(invoiceId); void cache.invalidateQueries({ queryKey: ['billing', gymId] });
    }}/>}
    {selected && <Dialog size="wide" title={text('invoice')} closeLabel={text('close')} onClose={() => setSelected(null)}>
      <InvoiceDetails key={selected} gymId={gymId} invoiceId={selected} access={access} client={client}/>
    </Dialog>}
  </div>;
}
function HouseholdName({ gymId, householdId, client }: { gymId: string; householdId: string; client: InvoiceClient }) {
  const household = useQuery({ queryKey: ['billing', gymId, 'household', householdId], queryFn: () => client.household(householdId) });
  return <p className="break-words text-sm text-muted-foreground">{household.data?.name ?? text('household')}</p>;
}
function useInvoiceAccess() {
  const bootstrap = useBootstrap(), roles = bootstrap.data?.session?.roles ?? [];
  return { bootstrap, allowed: canStaff(roles, 'billing.read'), access: {
    record: canStaff(roles, 'payments.record'), refund: canStaff(roles, 'refunds.create'), links: canStaff(roles, 'links.send'),
  } };
}
export function InvoicePage({ invoiceId }: { invoiceId?: string }) {
  const { bootstrap, access, allowed } = useInvoiceAccess();
  if (bootstrap.isPending) return <Page><LoadingState/></Page>;
  if (bootstrap.isError) return <Page><ErrorState onRetry={() => void bootstrap.refetch()}/></Page>;
  if (!bootstrap.data || !allowed) return <Page><EmptyState title={text('denied')}/></Page>;
  return <Page><PageHeader title={text(invoiceId ? 'invoice' : 'title')}/>
    {invoiceId ? <InvoiceDetails key={invoiceId} gymId={bootstrap.data.gym.id} invoiceId={invoiceId} access={access}/>
      : <InvoiceList gymId={bootstrap.data.gym.id} access={access}/>}
  </Page>;
}
export function InvoiceTab({ memberId }: ExtensionViewProps) {
  const { bootstrap, access, allowed } = useInvoiceAccess();
  const gymId = bootstrap.data?.gym.id;
  const member = useQuery({ queryKey: ['billing', gymId, 'invoice-member', memberId], queryFn: () => invoiceClient.member(memberId!), enabled: !!gymId && !!memberId && allowed });
  if (bootstrap.isPending || member.isPending) return <LoadingState/>;
  if (!gymId || !allowed || !memberId) return null;
  if (member.isError) return <ErrorState onRetry={() => void member.refetch()}/>;
  return <PageSection title={text('title')} description={text('householdInvoices')}>
    <InvoiceList key={member.data.householdId} gymId={gymId} householdId={member.data.householdId} access={access}/>
  </PageSection>;
}
