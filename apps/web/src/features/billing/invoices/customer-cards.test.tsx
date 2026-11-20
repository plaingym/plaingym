// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2035, isDefault: true, revokedAt: null }] : [];
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
const card = { id: '00000000-0000-7000-8000-000000000003', householdId, createdAt: '2026-01-01T00:00:00Z',
  type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2035, isDefault: false, revokedAt: null as string | null };
const page = (data: typeof card[]) => Response.json({ data, pagination: { total: data.length, offset: 0, limit: 25 } });
it('refreshes only this household card lists and charge eligibility', async () => {
  const { cache } = start(vi.fn<typeof fetch>(), true);
  const own = ['billing', gymId, 'cards', householdId, 25], active = ['billing', gymId, 'activeCards', householdId];
  const unrelated = [['billing', gymId, 'invoice', 'invoice'], ['billing', gymId, 'cards', 'other', 0], ['billing', 'other', 'cards', householdId, 0]];
  for (const key of [own, active, ...unrelated]) cache.setQueryData(key, []);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh cards' }));
  await waitFor(() => expect(cache.getQueryState(own)?.isInvalidated).toBe(true));
  expect(cache.getQueryState(active)?.isInvalidated).toBe(true);
  for (const key of unrelated) expect(cache.getQueryState(key)?.isInvalidated).toBe(false);
});
it('makes a household card default without needing an invoice', async () => {
  let selected = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method === 'POST') { selected = true; return Response.json({ data: { ...card, isDefault: true } }); }
    return page([{ ...card, isDefault: selected }]);
  });
  start(fetcher, true, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Make default' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await screen.findByText('Default card');
  expect(fetcher).toHaveBeenCalledWith(`/api/billing/households/${householdId}/payment-methods/${card.id}/default`, expect.objectContaining({ method: 'POST' }));
});
it('refreshes committed removal and promotion after a detach error, including charge eligibility', async () => {
  let removed = false;
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === 'POST') { removed = true; return Response.json({}, { status: 503 }); }
    return page([{ ...card, isDefault: !removed, revokedAt: removed ? card.createdAt : null }]);
  });
  const { cache } = start(fetcher, true, true);
  const active = ['billing', gymId, 'activeCards', householdId]; cache.setQueryData(active, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove card' }));
  const region = screen.getByRole('region', { name: 'Remove saved card' });
  expect(within(region).getByText(/^4242 · Remove/)).toBeDefined();
  expect(within(region).getByText(/newest remaining card/)).toBeDefined();
  fireEvent.click(within(region).getByRole('button', { name: 'Confirm' }));
  await within(region).findByRole('alert');
  await waitFor(() => expect(cache.getQueryState(active)?.isInvalidated).toBe(true));
  await waitFor(() => expect(within(region).queryByText(/newest remaining card/)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Back to cards' }));
  await screen.findByText('Removed');
  expect(screen.queryByText('Default card')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry card removal' })).toBeDefined();
});
it.each([false, true])('omits promotion help for a non-default or already removed card: removed=%s', async removed => {
  start(vi.fn<typeof fetch>(async () => page([{ ...card, revokedAt: removed ? card.createdAt : null }])), true, true);
  fireEvent.click(await screen.findByRole('button', { name: removed ? 'Retry card removal' : 'Remove card' }));
  expect(screen.queryByText(/newest remaining card/)).toBeNull();
  expect(screen.getByText(/^4242 · Remove/)).toBeDefined();
});
it('hides default and remove actions without collection permission', async () => {
  start(vi.fn<typeof fetch>(async () => page([card])), false, true);
  await screen.findByText(/4242/);
  expect(screen.queryByRole('button', { name: 'Make default' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove card' })).toBeNull();
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
