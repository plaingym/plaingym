// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { invoiceClient, invoiceError, type InvoiceClient } from './api.js';
import { text } from './format.js';
import { CardList, invalidateHouseholdCards } from './card-list.js';

export function CustomerCardImport({ gymId, householdId, allowed, client = invoiceClient }: {
  gymId: string; householdId: string; allowed: boolean; client?: InvoiceClient;
}) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false), [queued, setQueued] = useState(false), [error, setError] = useState('');
  async function requestImport() {
    if (busy) return;
    setBusy(true); setError(''); setQueued(false);
    try { await client.call('importCustomerCards', {}, { householdId }); setQueued(true); }
    catch (error) { setError(invoiceError(error)); }
    finally { setBusy(false); }
  }
  if (!allowed) return null;
  return <div className="min-w-0 space-y-3">
    <p className="text-sm text-muted-foreground">{text('importCardsHelp')}</p>
    {error && <Alert variant="error" focusOnReveal>{error}</Alert>}
    {queued && <Alert focusOnReveal>{text('importCardsQueued')}</Alert>}
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <Button variant="outline" disabled={busy} onClick={() => void requestImport()}>{text(busy ? 'saving' : 'importCards')}</Button>
      <Button variant="outline" onClick={() => void invalidateHouseholdCards(cache, gymId, householdId)}>{text('refreshCards')}</Button>
    </div>
  </div>;
}

/** Household billing remains usable before the first invoice exists. */
export function HouseholdCards({ gymId, householdId, allowed, client = invoiceClient }: {
  gymId: string; householdId: string; allowed: boolean; client?: InvoiceClient;
}) {
  return <div className="min-w-0 space-y-4">
    <CustomerCardImport gymId={gymId} householdId={householdId} allowed={allowed} client={client}/>
    <CardList gymId={gymId} householdId={householdId} allowed={allowed} client={client}/>
  </div>;
}
