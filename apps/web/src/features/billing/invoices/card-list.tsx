// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { MaskedPaymentMethod } from '@plaingym/shared/contracts';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { Badge, StackedItem, StackedList } from '../../../components/ui/table.js';
import { Pager } from '../../../components/ui/pager.js';
import { LoadingState, ErrorState, EmptyState } from '../../../components/ui/states.js';
import { useDialogOperation } from '../../../components/ui/dialog.js';
import { paymentMethodLabel } from '../../../lib/card-brand.js';
import { invoiceClient, invoiceError, type InvoiceClient } from './api.js';
import { text } from './format.js';

/** Both the paginated list and charge eligibility belong to this household. */
export function invalidateHouseholdCards(cache: QueryClient, gymId: string, householdId: string) {
  return cache.invalidateQueries({ predicate: ({ queryKey }) => queryKey[0] === 'billing' && queryKey[1] === gymId
    && (queryKey[2] === 'cards' || queryKey[2] === 'activeCards') && queryKey[3] === householdId });
}

export function CardList({ gymId, householdId, allowed, client = invoiceClient }: {
  gymId: string; householdId: string; allowed: boolean; client?: InvoiceClient;
}) {
  const cache = useQueryClient(), [offset, setOffset] = useState(0);
  const [action, setAction] = useState<{ kind: 'revoke' | 'default'; card: MaskedPaymentMethod } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const title = useId(), heading = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLElement | null>(null);
  useDialogOperation(busy);
  useEffect(() => { if (action) heading.current?.focus(); else if (trigger.current?.isConnected) trigger.current.focus(); }, [action]);
  const cards = useQuery({ queryKey: ['billing', gymId, 'cards', householdId, offset], queryFn: () => client.cards(householdId, offset) });
  const selectedCard = action && (cards.data?.data.find(card => card.id === action.card.id) ?? action.card);
  function open(kind: 'revoke' | 'default', card: MaskedPaymentMethod) {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setAction({ kind, card });
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!action || !allowed || busy) return;
    setBusy(true); setError('');
    try {
      await client.call(action.kind === 'revoke' ? 'revokePaymentMethod' : 'setDefaultPaymentMethod', {},
        { householdId, paymentMethodId: action.card.id });
      setAction(null);
    } catch (error) { setError(invoiceError(error)); }
    finally { await invalidateHouseholdCards(cache, gymId, householdId); setBusy(false); }
  }
  return <div className="min-w-0 space-y-4">
    <div hidden={!!action}>
      {cards.isPending && <LoadingState/>}{cards.isError && <ErrorState onRetry={() => void cards.refetch()}/>}
      {cards.data?.data.length === 0 && <EmptyState title={text('noCards')}/>}
      <StackedList>{cards.data?.data.map(card => <StackedItem key={card.id}>
        <span className="wrap-anywhere">{paymentMethodLabel(card, text)}{card.type === 'card' && <> · {card.expiryMonth}/{card.expiryYear}</>}</span>
        {card.isDefault && <Badge className="self-start">{text('default')}</Badge>}
        {card.revokedAt && <Badge className="self-start">{text('removed')}</Badge>}
        {allowed && <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {!card.revokedAt && !card.isDefault && <Button variant="outline" onClick={() => open('default', card)}>{text('makeDefault')}</Button>}
          <Button variant="outline" onClick={() => open('revoke', card)}>{text(card.revokedAt ? 'retryRemoval' : 'removeCard')}</Button>
        </div>}
      </StackedItem>)}</StackedList>
      {cards.data && <Pager offset={offset} total={cards.data.pagination.total} limit={25} onChange={setOffset}
        previousLabel={text('previous')} nextLabel={text('next')}/>}
    </div>
    {action && selectedCard && <section aria-labelledby={title} className="space-y-4">
      <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>{text('backToCards')}</Button>
      <h3 id={title} ref={heading} tabIndex={-1} className="text-lg font-semibold">{text(action.kind)}</h3>
      <form onSubmit={event => void submit(event)} className="space-y-4">
        {error && <Alert variant="error" focusOnReveal>{error}</Alert>}
        <p className="wrap-anywhere">{paymentMethodLabel(selectedCard, (key, values) => text(key === 'cardLabel' ? 'cardConfirmationLabel' : key, values))}
          {' · '}{text(action.kind === 'revoke' ? 'removeHelp' : 'defaultHelp')}</p>
        {action.kind === 'revoke' && selectedCard.isDefault && !selectedCard.revokedAt && <p>{text('removeDefaultHelp')}</p>}
        <Button type="submit" disabled={busy || !allowed} className="w-full sm:w-auto">{text(busy ? 'saving' : 'confirm')}</Button>
      </form>
    </section>}
  </div>;
}
