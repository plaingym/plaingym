// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInvoiceClient } from './api.js';
import { CustomerCardImport, HouseholdCards } from './customer-cards.js';

afterEach(cleanup);
const gymId = '00000000-0000-7000-8000-000000000001', householdId = '00000000-0000-7000-8000-000000000002';
function start(fetcher: typeof fetch, allowed = true, list = false) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }), client = createInvoiceClient(fetcher);
  const props = { gymId, householdId, allowed, client };
  render(<QueryClientProvider client={cache}>{list ? <HouseholdCards {...props}/> : <CustomerCardImport {...props}/>}</QueryClientProvider>);
  return { cache };
}
it('queues an import for this household and refreshes cards without needing an invoice', async () => {
  let imported = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith('/import')) return Response.json({ data: { queued: true } });
    const data = imported ? [{ id: '00000000-0000-7000-8000-000000000003', householdId, createdAt: '2026-01-01T00:00:00Z',
      brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2035, isDefault: true, revokedAt: null }] : [];
    expect(init?.method).toBe('GET');
    return Response.json({ data, pagination: { total: data.length, offset: 0, limit: 25 } });
  });
  start(fetcher, true, true);
  await screen.findByText('No saved cards');
  fireEvent.click(screen.getByRole('button', { name: 'Import cards from Stripe' }));
  await screen.findByText(/Card import queued/);
  expect(fetcher).toHaveBeenCalledWith(`/api/billing/households/${householdId}/payment-methods/import`, expect.objectContaining({ method: 'POST', body: '{}' }));
  imported = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh cards' }));
  await screen.findByText(/4242/);
  expect(screen.getByText('Default card')).toBeDefined();
});
it('hides import controls without collection permission', () => {
  const fetcher = vi.fn<typeof fetch>(); start(fetcher, false);
  expect(screen.queryByRole('button', { name: 'Import cards from Stripe' })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps refusal feedback and permits a retry', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { details: { reason: ['card_import_refused'] } } }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ data: { queued: true } }));
  start(fetcher);
  fireEvent.click(screen.getByRole('button', { name: 'Import cards from Stripe' }));
  await screen.findByText(/Stripe customer is not tagged/);
  fireEvent.click(screen.getByRole('button', { name: 'Import cards from Stripe' }));
  await screen.findByText(/Card import queued/);
  expect(screen.queryByText(/Stripe customer is not tagged/)).toBeNull();
});
it('disables duplicate submissions while the request is pending', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
  start(fetcher); fireEvent.click(screen.getByRole('button', { name: 'Import cards from Stripe' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: /Saving/ })).toHaveProperty('disabled', true);
  finish(Response.json({ data: { queued: true } }));
  await screen.findByText(/Card import queued/);
});
