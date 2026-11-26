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
function start(cards: MaskedPaymentMethod[], onActionChange?: (open: boolean) => void, onCall?: typeof fetch) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (onCall && init?.method && init.method !== 'GET') return onCall(input, init);
    return Response.json({ data: cards, pagination: { total: cards.length, offset: 0, limit: 25 } });
  });
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
  expect(screen.queryByText('Removed')).toBeNull();
});
it('shows a pending removal as Removal pending with a retry button', async () => {
  start([{ ...base, revokedAt, removal: 'pending' }]);
  await screen.findByText('Removal pending');
  expect(screen.getByRole('button', { name: 'Retry payment method removal' })).toBeDefined();
  expect(screen.queryByText('Removed from Stripe')).toBeNull();
  expect(screen.queryByText('Removed')).toBeNull();
});
it('shows a revoked method with no removal state as Removed with no retry button', async () => {
  start([{ ...base, revokedAt }]);
  await screen.findByText('Removed');
  expect(screen.queryByRole('button', { name: 'Retry payment method removal' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove payment method' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Make default' })).toBeNull();
  expect(screen.queryByText('Removal pending')).toBeNull();
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
it('hides Make default and shows the note when canBeDefault is false, and shows Make default when true or omitted', async () => {
  const bank: MaskedPaymentMethod = { ...base, id: '00000000-0000-7000-8000-000000000004', type: 'us_bank_account',
    bankName: 'Test Bank', brand: null, last4: '6789', expiryMonth: null, expiryYear: null, canBeDefault: false };
  const eligible: MaskedPaymentMethod = { ...base, id: '00000000-0000-7000-8000-000000000005', last4: '1111', canBeDefault: true };
  const defaultBank: MaskedPaymentMethod = { ...bank, id: '00000000-0000-7000-8000-000000000006', last4: '9999', isDefault: true };
  start([bank, eligible, base, defaultBank]);

  const bankItem = (await screen.findByText('Test Bank account ending 6789')).closest('li')!;
  expect(within(bankItem).getByText("This bank account can't be used for automatic charges at this gym, so it can't be the default.")).toBeDefined();
  expect(within(bankItem).queryByRole('button', { name: 'Make default' })).toBeNull();
  expect(within(bankItem).getByRole('button', { name: 'Remove payment method' })).toBeDefined();

  const eligibleItem = (await screen.findByText('Visa · 1111 · 12/2035')).closest('li')!;
  expect(within(eligibleItem).getByRole('button', { name: 'Make default' })).toBeDefined();
  expect(within(eligibleItem).queryByText("This bank account can't be used for automatic charges at this gym, so it can't be the default.")).toBeNull();

  const omittedItem = (await screen.findByText('Visa · 4242 · 12/2035')).closest('li')!;
  expect(within(omittedItem).getByRole('button', { name: 'Make default' })).toBeDefined();
  expect(within(omittedItem).queryByText("This bank account can't be used for automatic charges at this gym, so it can't be the default.")).toBeNull();

  const defaultBankItem = (await screen.findByText('Test Bank account ending 9999')).closest('li')!;
  expect(within(defaultBankItem).getByText('Default payment method')).toBeDefined();
  expect(within(defaultBankItem).queryByRole('button', { name: 'Make default' })).toBeNull();
  expect(within(defaultBankItem).queryByText("This bank account can't be used for automatic charges at this gym, so it can't be the default.")).toBeNull();
});
it('warns on a default row that canBeDefault false marks, and on no other default row', async () => {
  const warning = "This bank account can't be used for automatic charges at this gym. Make another payment method the default.";
  const bank: MaskedPaymentMethod = { ...base, id: '00000000-0000-7000-8000-000000000007', type: 'us_bank_account',
    bankName: 'Test Bank', brand: null, last4: '6789', expiryMonth: null, expiryYear: null, isDefault: true, canBeDefault: false };
  const eligible: MaskedPaymentMethod = { ...base, id: '00000000-0000-7000-8000-000000000008', last4: '1111', isDefault: true, canBeDefault: true };
  const omitted: MaskedPaymentMethod = { ...base, isDefault: true };
  // A household has one default, so each default row is its own list.
  start([bank, base]);
  const bankItem = (await screen.findByText('Test Bank account ending 6789')).closest('li')!;
  expect(within(bankItem).getByText(warning)).toBeDefined();
  expect(within(bankItem).getByText('Default payment method')).toBeDefined();
  expect(within(bankItem).queryByRole('button', { name: 'Make default' })).toBeNull();
  expect(screen.getAllByText(warning)).toHaveLength(1);
  cleanup();
  for (const [card, label] of [[eligible, 'Visa · 1111 · 12/2035'], [omitted, 'Visa · 4242 · 12/2035']] as const) {
    start([card]);
    const item = (await screen.findByText(label)).closest('li')!;
    expect(within(item).getByText('Default payment method')).toBeDefined();
    expect(screen.queryByText(warning)).toBeNull();
    cleanup();
  }
});
it('shows the currency and mandate refusal texts when setting default returns 409', async () => {
  for (const [reason, expected] of [
    ['payment_method_currency', "This bank account can't be charged in this gym's currency. Choose a card or another account."],
    ['payment_method_mandate', "This pre-authorized debit has no mandate on file, so it can't be the default. Choose another payment method."],
  ] as const) {
    start([base], undefined, async () => Response.json(
      { error: { code: 'conflict', message: 'Refused', details: { reason: [reason] } } }, { status: 409 },
    ));
    fireEvent.click(await screen.findByRole('button', { name: 'Make default' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(expected)).toBeDefined();
    cleanup();
  }
});
