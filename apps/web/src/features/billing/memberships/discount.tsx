// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Membership, MembershipDiscountSelection } from '@plaingym/shared/contracts';
import { ApiError } from '../../../lib/api.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import type { BillingClient } from '../catalog/api.js';
import type { DiscountClient } from '../discounts/api.js';
import { DiscountSelection } from '../discounts/selection.js';
import { benefit, failure, text } from '../discounts/messages.js';

export function MembershipDiscount({ row, gymId, client, discounts, reload }: {
  row: Membership; gymId: string; client: BillingClient; discounts?: DiscountClient | undefined; reload(): Promise<void>;
}) {
  const cache = useQueryClient(), [action, setAction] = useState<'edit' | 'remove' | null>(null), [base, setBase] = useState(row);
  const [selection, setSelection] = useState<MembershipDiscountSelection>(), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [stale, setStale] = useState(false), inFlight = useRef(false);
  function open(next: 'edit' | 'remove') { setBase(row); setAction(next); setSelection(undefined); setError(''); setStale(false); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (inFlight.current || stale || (action === 'edit' && !selection)) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (action === 'remove') await client.call('removeMembershipDiscount', { revision: base.revision }, { membershipId: row.id });
      else await client.call('setMembershipDiscount', { revision: base.revision, discount: selection }, { membershipId: row.id });
      setAction(null);
      await Promise.all([reload(), cache.invalidateQueries({ queryKey: ['billing', gymId, 'discounts'] }), cache.invalidateQueries({ queryKey: ['billing', gymId, 'catalog', 'discounts'] })]);
    } catch (cause) {
      setError(failure(cause));
      if (cause instanceof ApiError && (cause.reason.includes('membership_changed') || (cause.status === 409 && !cause.reason.length))) setStale(true);
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <div className="min-w-0 space-y-3 border-t pt-3 wrap-anywhere">
    {row.discount && <div className="space-y-1 text-sm"><p className="font-medium">{text('current', { name: row.discount.name })}</p>
      <p>{benefit(row.discount)}</p>
      {row.discount.duration && <p>{row.discount.cyclesLeft === null ? text('forever') : text('cyclesLeft', { count: row.discount.cyclesLeft })}</p>}
    </div>}
    {row.status !== 'cancelled' && !action && <div className="flex flex-col gap-2 sm:flex-row">
      <Button variant="outline" onClick={() => open('edit')}>{text(row.discount ? 'change' : 'add')}</Button>
      {row.discount && <Button variant="outline" onClick={() => open('remove')}>{text('remove')}</Button>}
    </div>}
    {action && <form onSubmit={event => void submit(event)} className="min-w-0 space-y-3">
      {error && <Alert role="alert">{error}</Alert>}
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        {action === 'remove' ? <p>{text('confirmRemove')}</p> : <>
          <p className="text-sm text-muted-foreground">{text('nextInvoice')}</p>
          <DiscountSelection key={base.revision} gymId={gymId} planId={base.planId} currency={base.currency} value={selection} onChange={setSelection} client={discounts} live/>
        </>}
        <div className="flex flex-col gap-2 sm:flex-row"><Button type="submit" disabled={stale || (action === 'edit' && !selection)}>{text(busy ? 'saving' : action === 'remove' ? 'remove' : 'apply')}</Button>
          <Button variant="outline" onClick={() => { setAction(null); if (stale) void reload(); }}>{text(stale ? 'closeReload' : 'cancel')}</Button></div>
      </fieldset>
    </form>}
  </div>;
}
