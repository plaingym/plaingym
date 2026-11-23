// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MaskedPaymentMethod } from '@plaingym/shared/contracts';
import { createInvoiceClient } from './api.js';
import { CardList } from './card-list.js';

afterEach(cleanup);
const gymId = '00000000-0000-7000-8000-000000000001', householdId = '00000000-0000-7000-8000-000000000002';
const base: MaskedPaymentMethod = { id: '00000000-0000-7000-8000-000000000003', householdId, createdAt: '2026-01-01T00:00:00Z',
  type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2035, isDefault: false, revokedAt: null };
function start(cards: MaskedPaymentMethod[], onActionChange?: (open: boolean) => void) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: cards, pagination: { total: cards.length, offset: 0, limit: 25 } }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CardList gymId={gymId} householdId={householdId} allowed client={createInvoiceClient(fetcher)} {...(onActionChange ? { onActionChange } : {})}/>
  </QueryClientProvider>);
}
const revokedAt = '2026-02-01T00:00:00Z';

it('shows a finished removal as Removed from Stripe with no retry button', async () => {
  start([{ ...base, revokedAt, removal: 'finished' }]);
  await screen.findByText('Removed from Stripe');
  expect(screen.queryByRole('button', { name: 'Retry payment method removal' })).toBeNull();
  expect(screen.queryByText('Removal pending')).toBeNull();
});
it('shows a pending removal as Removal pending with a retry button', async () => {
  start([{ ...base, revokedAt, removal: 'pending' }]);
  await screen.findByText('Removal pending');
  expect(screen.getByRole('button', { name: 'Retry payment method removal' })).toBeDefined();
  expect(screen.queryByText('Removed from Stripe')).toBeNull();
});
it('offers Remove and Make default on an active card that is not the default', async () => {
  start([base]);
  const item = (await screen.findByText('Visa · 4242 · 12/2035')).closest('li')!;
  expect(within(item).getByRole('button', { name: 'Remove payment method' })).toBeDefined();
  expect(within(item).getByRole('button', { name: 'Make default' })).toBeDefined();
});
it('reports a confirmation opening and closing, and closing when the list goes away', async () => {
  const seen = vi.fn();
  start([base], seen);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove payment method' }));
  await screen.findByRole('button', { name: 'Back to payment methods' });
  expect(seen).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Back to payment methods' }));
  expect(seen).toHaveBeenLastCalledWith(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove payment method' }));
  cleanup();
  expect(seen).toHaveBeenLastCalledWith(false);
});
