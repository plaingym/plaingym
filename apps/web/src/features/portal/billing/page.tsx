// SPDX-License-Identifier: AGPL-3.0-only
import { PortalRecovery } from '../household/recovery.js';
import { cardBrand } from '../../../lib/card-brand.js';
import { useState } from 'react';
import { cardChargeIssue } from '@plaingym/shared/money';
import { useMutation, useQuery } from '@tanstack/react-query';
import { portalContracts as contracts, type PortalInvoice } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Pager } from '../../../components/ui/pager.js';
import { Alert } from '../../../components/ui/alert.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { Badge, StackedItem, StackedList } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { money } from '../../billing/catalog/format.js';
import { unavailable, usePortalContext, usePortalScope, type PortalScope } from '../household/api.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/billing:' + key, values);
const payable = new Set(['open', 'past_due']), receipted = new Set(['paid', 'partially_refunded', 'refunded']);
const tones: Record<PortalInvoice['status'], 'default' | 'success' | 'warning' | 'destructive' | 'muted'> = {
  open: 'default', processing: 'muted', past_due: 'destructive', paid: 'success', void: 'muted', partially_refunded: 'warning', refunded: 'muted',
};
const pageSize = 20;
/** Leaves for Stripe-hosted Checkout; the page never collects card details itself. */
export function leave(url: string) { location.assign(url); }

export function PortalBillingPage({ navigate = leave }: { navigate?: (url: string) => void }) {
  const bootstrap = useBootstrap(), scope = usePortalScope(), { ready, own } = scope, gym = bootstrap.data?.gym;
  const context = usePortalContext(scope);
  const payer = context.data?.role === 'payer';
  const [offset, setOffset] = useState(0), [open, setOpen] = useState<string | null>(null), [receipt, setReceipt] = useState<string | null>(null);
  const credits = useQuery({ queryKey: [...scope.key, 'billing', 'credits'], enabled: ready, queryFn: async () => own(await scope.call(contracts.classCredits)).data });
  const invoices = useQuery({ queryKey: [...scope.key, 'billing', 'invoices', offset], enabled: ready && payer, queryFn: async () => own(await scope.call(contracts.invoices, undefined, {}, { limit: pageSize, offset })) });
  const cards = useQuery({ queryKey: [...scope.key, 'billing', 'cards'], enabled: ready && payer, queryFn: async () => own(await scope.call(contracts.paymentMethods)).data });
  const checkout = useMutation({ mutationFn: async (invoiceId: string | null) => {
    // A Checkout started for another household than this page's is never followed.
    const started = own(invoiceId ? await scope.call(contracts.payInvoice, undefined, { invoiceId }) : await scope.call(contracts.updateCard));
    navigate(started.data.url);
  } });
  const download = useMutation({ mutationFn: async (invoiceId: string) => {
    setReceipt(null); setReceipt(own(await scope.call(contracts.receipt, undefined, { invoiceId })).data.url);
  } });
  if (!gym) return null;
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value + 'T00:00:00Z'));
  const instant = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: gym.timezone }).format(new Date(value));
  const failure = checkout.error ?? download.error, unavailableKey = checkout.error ? 'unavailable' : 'receiptUnavailable';
  return <Page className="max-w-3xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text('title')} description={text(payer ? 'description' : 'creditsDescription')} />
    {context.isPending && <LoadingState />}
    {context.isError && <ErrorState onRetry={() => void context.refetch()} />}
    {/* Payers see the card only when someone holds credits; for adult members it is the whole page. */}
    {(!payer || credits.isError || !!credits.data?.length) && <PageSection title={text('credits')}>
      {credits.isPending && <LoadingState />}
      {credits.isError && <ErrorState onRetry={() => void credits.refetch()} />}
      {credits.data?.length === 0 && <EmptyState title={text('noCredits')} />}
      {!!credits.data?.length && <StackedList>{credits.data.map(row => <StackedItem key={row.memberId} className="gap-1">
        <p className="min-w-0 break-words font-semibold">{row.firstName} {row.lastName}</p>
        <p>{text(row.balance === 1 ? 'classLeft' : 'classesLeft', { count: row.balance })}</p>
        {row.soonestExpiry && <p className="text-sm text-muted-foreground">{text('creditsExpiry', { date: instant(new Date(Date.parse(row.soonestExpiry) - 1).toISOString()) })}</p>}
      </StackedItem>)}</StackedList>}
    </PageSection>}
    {payer && <>
    {failure && <Alert variant="error" focusOnReveal role="alert">{text(unavailable(failure) ? unavailableKey : 'failed')}</Alert>}
    {checkout.isPending && <Alert role="status">{text('redirecting')}</Alert>}
    {receipt && <Alert role="status">{text('receiptReady')} <a className="inline-flex min-h-11 items-center font-medium underline" href={receipt} target="_blank" rel="noreferrer">{text('openReceipt')}</a></Alert>}
    <PageSection title={text('invoices')}>
      {invoices.isPending && <LoadingState />}
      {invoices.isError && <ErrorState onRetry={() => void invoices.refetch()} />}
      {invoices.data?.data.length === 0 && <EmptyState title={text('noInvoices')} />}
      {!!invoices.data?.data.length && <StackedList>{invoices.data.data.map(row => <StackedItem key={row.id} className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold">{text('invoice', { number: row.number })}</p>
            <p className="text-sm text-muted-foreground">{row.paidAt ? text('paidOn', { date: instant(row.paidAt) }) : text('due', { date: date(row.dueOn) })}</p>
          </div>
          <div className="flex items-center gap-2"><Badge tone={tones[row.status]}>{text('status_' + row.status)}</Badge>
            <span className="font-semibold tabular-nums">{money(row.amountCents, row.currency)}</span></div>
        </div>
        {open === row.id && <InvoiceLines invoiceId={row.id} scope={scope} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>{text(open === row.id ? 'hideDetails' : 'details')}</Button>
          {payable.has(row.status) && (row.amountCents === 0
            ? <p className="w-full text-sm" role="status">{text('zeroInvoice')}</p>
            : cardChargeIssue(row.amountCents, row.currency)
            ? <p className="w-full text-sm" role="status">{text('manualPayment')}</p>
            : <Button disabled={checkout.isPending} onClick={() => checkout.mutate(row.id)}>{text('pay')}</Button>)}
          {receipted.has(row.status) && row.paidAt && <Button variant="outline" disabled={download.isPending} onClick={() => download.mutate(row.id)}>{text('receipt')}</Button>}
        </div>
      </StackedItem>)}</StackedList>}
      {invoices.data && <Pager offset={offset} total={invoices.data.pagination.total} limit={pageSize} onChange={setOffset} previousLabel={text('previous')} nextLabel={text('next')}/>}
    </PageSection>
    <PageSection title={text('cards')} description={text('checkoutNote')}
      actions={<Button variant="outline" disabled={checkout.isPending || !cards.isSuccess} onClick={() => checkout.mutate(null)}>{text(cards.data?.length ? 'updateCard' : 'addCard')}</Button>}>
      {cards.isPending && <LoadingState />}
      {cards.isError && <ErrorState onRetry={() => void cards.refetch()} />}
      {cards.data?.length === 0 && <EmptyState title={text('noCards')} />}
      {!!cards.data?.length && <StackedList>{cards.data.map(card => <StackedItem key={card.id} className="flex-row flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words">{card.brand ? cardBrand(card.brand) : text('card')} •••• {card.last4 ?? '????'}
          {card.expiryMonth && card.expiryYear && <span className="block text-sm text-muted-foreground">{text('expires', { month: String(card.expiryMonth).padStart(2, '0'), year: card.expiryYear })}</span>}</span>
        {card.isDefault && <Badge tone="success">{text('default')}</Badge>}
      </StackedItem>)}</StackedList>}
    </PageSection>
    </>}
  </PortalRecovery></Page>;
}
/** The routed page and portal registration. */
export function PortalBilling() { return <PortalBillingPage />; }
function InvoiceLines({ invoiceId, scope }: { invoiceId: string; scope: PortalScope }) {
  const detail = useQuery({ queryKey: [...scope.key, 'billing', 'invoice', invoiceId], retryOnMount: false,
    queryFn: async () => scope.own(await scope.call(contracts.invoice, undefined, { invoiceId })).data });
  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <ErrorState onRetry={() => void detail.refetch()} />;
  return <dl className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
    {detail.data.lines.map(line => <div key={line.id} className="flex flex-wrap justify-between gap-2">
      <dt className="min-w-0 break-words">{line.description}{line.quantity > 1 && <span className="text-muted-foreground"> · {text('quantity', { quantity: line.quantity })}</span>}</dt>
      <dd className="tabular-nums">{money(line.amountCents, line.currency)}</dd></div>)}
    <div className="flex justify-between gap-2 border-t border-border pt-1 font-semibold"><dt>{text('total')}</dt>
      <dd className="tabular-nums">{money(detail.data.invoice.amountCents, detail.data.invoice.currency)}</dd></div>
  </dl>;
}
