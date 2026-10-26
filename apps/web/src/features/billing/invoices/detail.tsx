// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceDetail, MaskedPaymentMethod, Payment } from '@plaingym/shared/contracts';
import { invoiceClient, invoiceError, type InvoiceClient } from './api.js';
import { text, money, decimalAmount, decimalUnits } from './format.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Label } from '../../../components/ui/label.js';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { Alert } from '../../../components/ui/alert.js';
import { Badge, StackedItem, StackedList } from '../../../components/ui/table.js';
import { PageSection } from '../../../components/ui/page.js';
import { LoadingState, ErrorState, EmptyState } from '../../../components/ui/states.js';

export interface InvoiceAccess { record: boolean; refund: boolean; links: boolean }
type Action = { kind: 'cash' | 'charge' | 'link' | 'receipt' | 'viewReceipt' | 'releaseHold' } | { kind: 'refund'; payment: Payment } | { kind: 'revoke' | 'default'; card: MaskedPaymentMethod };
export function InvoiceDetails({ gymId, invoiceId, access, client = invoiceClient }: {
  gymId: string; invoiceId: string; access: InvoiceAccess; client?: InvoiceClient;
}) {
  const cache = useQueryClient(), key = ['billing', gymId, 'invoice', invoiceId];
  const [action, setAction] = useState<Action | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [message, setMessage] = useState(''), [url, setUrl] = useState(''), [cardOffset, setCardOffset] = useState(0);
  const detail = useQuery({ queryKey: key, queryFn: () => client.invoice(invoiceId) });
  const homeId = detail.data?.invoice.householdId;
  const household = useQuery({ queryKey: ['billing', gymId, 'household', homeId], queryFn: () => client.household(homeId!), enabled: !!homeId });
  const cards = useQuery({ queryKey: ['billing', gymId, 'cards', homeId, cardOffset], queryFn: () => client.cards(homeId!, cardOffset), enabled: !!homeId });
  const allCards = useQuery({ queryKey: ['billing', gymId, 'activeCards', homeId], queryFn: () => client.activeDefaultCard(homeId!), enabled: !!homeId });
  function open(next: Action) { setError(''); setMessage(''); setUrl(''); setAction(next); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail.data || !action) return;
    const form = new FormData(event.currentTarget), invoice = detail.data.invoice;
    setBusy(true); setError(''); setMessage('');
    try {
      if (action.kind === 'cash') await client.call('recordManualPayment', { amountCents: invoice.amountCents, currency: invoice.currency,
        method: form.get('method'), reference: form.get('reference') || null, paidAt: new Date().toISOString() }, { invoiceId });
      if (action.kind === 'releaseHold') { await client.releaseHold(invoiceId); setMessage(text('holdReleased')); }
      if (action.kind === 'charge') {
        const result = await client.call('chargeInvoice', {}, { invoiceId });
        setMessage(text(result.data.status === 'succeeded' ? 'paid' : result.data.status === 'failed' ? 'chargeFailed'
          : result.data.status === 'requires_action' ? 'requiresAction' : 'pendingCharge'));
      }
      if (action.kind === 'refund') await client.call('createRefund', { amountCents: decimalUnits(String(form.get('amount')), 2),
        currency: action.payment.currency, reason: form.get('reason') || null }, { paymentId: action.payment.id });
      if (action.kind === 'revoke' || action.kind === 'default') await client.call(action.kind === 'revoke' ? 'revokePaymentMethod' : 'setDefaultPaymentMethod', {},
        { householdId: invoice.householdId, paymentMethodId: action.card.id });
      if (action.kind === 'receipt') { await client.call('resendReceipt', {}, { invoiceId }); setMessage(text('receiptQueued')); }
      if (action.kind === 'link') {
        const send = form.get('delivery') === 'email';
        const result = await client.link({ purpose: 'pay_invoice', householdId: invoice.householdId, invoiceId,
          expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() }, send);
        if ('token' in result.data) { setUrl(new URL('/l/' + result.data.token, location.origin).href); }
        else setMessage(text('linkSent'));
      }
      await cache.invalidateQueries({ queryKey: ['billing', gymId] });
      if (action.kind !== 'link') setAction(null);
    } catch (error) { setError(invoiceError(error)); await cache.invalidateQueries({ queryKey: key }); } finally { setBusy(false); }
  }
  if (detail.isPending) return <LoadingState/>;
  if (detail.isError) return <ErrorState onRetry={() => void detail.refetch()}/>;
  const data = detail.data, invoice = data.invoice, collectible = ['open', 'past_due'].includes(invoice.status);
  return <div className="min-w-0 space-y-6">
    {message && <Alert role="status">{message}</Alert>}
    <PageSection title={household.data?.name ?? text('household')}>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div><dt>{text('number')}</dt><dd>{invoice.number ?? text('draft')}</dd></div>
        <div><dt>{text('status')}</dt><dd><Badge>{text(invoice.status)}</Badge></dd></div>
        <div><dt>{text('amount')}</dt><dd>{money(invoice.amountCents, invoice.currency)}</dd></div>
        <div><dt>{text('dueOn')}</dt><dd>{invoice.dueOn}</dd></div>
      </dl>
      {invoice.needsReview && <Alert>{text('needsReview')}</Alert>}
      <div className="flex flex-col flex-wrap gap-2 sm:flex-row">
        {collectible && access.record && <><Button onClick={() => open({ kind: 'cash' })}>{text('recordCash')}</Button><Button variant="outline" disabled={invoice.needsReview || allCards.data !== true} onClick={() => open({ kind: 'charge' })}>{text('chargeCard')}</Button></>}
        {collectible && invoice.needsReview && access.refund && <Button variant="outline" onClick={() => open({ kind: 'releaseHold' })}>{text('releaseHold')}</Button>}
        {collectible && access.links && <Button variant="outline" onClick={() => open({ kind: 'link' })}>{text('payLink')}</Button>}
        {invoice.paidAt && <Button variant="outline" onClick={() => open({ kind: 'viewReceipt' })}>{text('viewReceipt')}</Button>}
        {invoice.paidAt && access.record && <Button variant="outline" onClick={() => open({ kind: 'receipt' })}>{text('resendReceipt')}</Button>}
      </div>
    </PageSection>
    <PageSection title={text('items')}><LineItems data={data}/></PageSection>
    <PageSection title={text('payments')}>
      {!data.payments.length && <EmptyState title={text('noPayments')}/>}
      <StackedList>{data.payments.map(payment => {
        const reserved = data.refunds.filter(r => r.paymentId === payment.id && r.status !== 'failed').reduce((sum, r) => sum + r.amountCents, 0);
        return <StackedItem key={payment.id}><span>{text(payment.method)} · {money(payment.amountCents, payment.currency)}</span>
          <span className="text-sm text-muted-foreground">{new Date(payment.paidAt).toLocaleString()}</span>
          {payment.reference && <p className="break-words">{payment.reference}</p>}
          {access.refund && reserved < payment.amountCents && <Button variant="outline" onClick={() => open({ kind: 'refund', payment })}>{text('refund')}</Button>}
        </StackedItem>;
      })}</StackedList>
      {data.refunds.length > 0 && <StackedList aria-label={text('refunds')}>{data.refunds.map(r => <StackedItem key={r.id}>{money(r.amountCents, r.currency)} · {text(r.status)}{r.reason && <p className="break-words">{r.reason}</p>}</StackedItem>)}</StackedList>}
    </PageSection>
    <PageSection title={text('cards')}>
      {cards.isPending && <LoadingState/>}{cards.isError && <ErrorState onRetry={() => void cards.refetch()}/>}
      {cards.data?.data.length === 0 && <EmptyState title={text('noCards')}/>}
      <StackedList>{cards.data?.data.map(card => <StackedItem key={card.id}>
        <span>{card.brand ?? text('card')} · {card.last4 ?? text('unknownCard')} · {card.expiryMonth}/{card.expiryYear}</span>
        {card.isDefault && <Badge>{text('default')}</Badge>}{card.revokedAt && <Badge>{text('removed')}</Badge>}
        {access.record && <div className="flex flex-col gap-2 sm:flex-row">
          {!card.revokedAt && !card.isDefault && <Button variant="outline" onClick={() => open({ kind: 'default', card })}>{text('makeDefault')}</Button>}
          <Button variant="outline" onClick={() => open({ kind: 'revoke', card })}>{text(card.revokedAt ? 'retryRemoval' : 'removeCard')}</Button>
        </div>}
      </StackedItem>)}</StackedList>
      {cards.data && cards.data.pagination.total > 25 && <div className="flex gap-2"><Button variant="outline" disabled={!cardOffset} onClick={() => setCardOffset(v => v - 25)}>{text('previous')}</Button><Button variant="outline" disabled={cardOffset + 25 >= cards.data.pagination.total} onClick={() => setCardOffset(v => v + 25)}>{text('next')}</Button></div>}
    </PageSection>
    {action && <Dialog title={text(action.kind === 'cash' ? 'recordCash' : action.kind)} closeLabel={text('close')} onClose={() => { if (!busy) setAction(null); }}>
      {action.kind === 'viewReceipt' ? <Receipt data={data}/> : <form onSubmit={event => void submit(event)} className="space-y-4">
        {error && <Alert role="alert">{error}</Alert>}
        <fieldset disabled={busy} className="space-y-4">
          {action.kind !== 'releaseHold' && <p>{action.kind === 'refund' && text('remainingRefundable') + ': '}{money(action.kind === 'refund' ? refundable(data, action.payment) : invoice.amountCents, invoice.currency)}</p>}
          {action.kind === 'releaseHold' && <p>{text('releaseHoldHelp')}</p>}
          {action.kind === 'cash' && <>
            <Label className="block">{text('method')}<Select name="method"><option value="cash">{text('cash')}</option><option value="check">{text('check')}</option></Select></Label>
            <Label className="block">{text('reference')}<Input name="reference"/></Label>
          </>}
          {action.kind === 'refund' && <>
            <p className="text-sm text-muted-foreground">{text(action.payment.method === 'card' ? 'refundHelp' : 'manualRefundHelp')}</p>
            <Label className="block">{text('amount')}<Input name="amount" required inputMode="decimal" defaultValue={decimalAmount(refundable(data, action.payment))}/></Label>
            <Label className="block">{text('reason')}<Input name="reason"/></Label>
          </>}
          {action.kind === 'charge' && <p>{text('chargeHelp')}</p>}
          {action.kind === 'revoke' && <p>{text('removeHelp')} · {action.card.last4}</p>}
          {action.kind === 'link' && <Label className="block">{text('delivery')}<Select name="delivery"><option value="email">{text('emailLink')}</option><option value="copy">{text('showLink')}</option></Select></Label>}
          {url ? <Label className="block">{text('linkReady')}<Input readOnly value={url} onFocus={event => event.target.select()}/></Label>
            : <Button type="submit" className="w-full sm:w-auto">{text(busy ? 'saving' : 'confirm')}</Button>}
        </fieldset>
      </form>}
    </Dialog>}
  </div>;
}
function refundable(data: InvoiceDetail, payment: Payment) {
  return payment.amountCents - data.refunds.filter(r => r.paymentId === payment.id && r.status !== 'failed').reduce((sum, r) => sum + r.amountCents, 0);
}
function LineItems({ data }: { data: InvoiceDetail }) {
  return <StackedList>{data.lineItems.map(line => <StackedItem key={line.id}>
    <p className="break-words font-medium">{line.description}</p><p>{line.quantity} × {money(line.amountCents, line.currency)}</p>
    {line.kind === 'tax' && <p className="text-sm text-muted-foreground">{text(line.taxInclusive ? 'inclusive' : 'exclusive')}</p>}
  </StackedItem>)}</StackedList>;
}
function Receipt({ data }: { data: InvoiceDetail }) {
  return <div className="space-y-4"><p>{text('number')} {data.invoice.number} · {money(data.invoice.amountCents, data.invoice.currency)}</p>
    <LineItems data={data}/>{data.payments.map(p => <p key={p.id}>{text(p.method)} · {money(p.amountCents, p.currency)} · {new Date(p.paidAt).toLocaleString()}</p>)}
    {data.refunds.map(r => <p key={r.id}>{text('refund')} · {money(r.amountCents, r.currency)} · {text(r.status)}</p>)}
  </div>;
}
