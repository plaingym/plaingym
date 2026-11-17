// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExhaustedEffect } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { EffectFailures } from './effect-failures.js';
vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn(), POST: vi.fn() } }));
const id = '00000000-0000-4000-8000-000000000001', invoiceId = '00000000-0000-4000-8000-000000000002';
const base: ExhaustedEffect = { effectId: id, invoiceId, number: 42, kind: 'receipt', refund: null, exhaustedAt: '2026-01-01T10:00:00Z' };
const ok = (data: unknown) => ({ response: new Response(), data }) as never;
const GET = vi.mocked(api.GET), POST = vi.mocked(api.POST);
function start(effect: ExhaustedEffect = base) {
  GET.mockResolvedValue(ok({ data: [effect] })); POST.mockResolvedValue(ok({ data: { changed: true } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const renderView = (reporting: boolean) => <QueryClientProvider client={client}><EffectFailures gymId="gym-a" timezone="UTC" reporting={reporting}/></QueryClientProvider>;
  return { client, ...render(renderView(true)), renderView };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('links the invoice and asks before retrying a receipt email with its exhaustion age', async () => {
  start();
  expect((await screen.findByRole('link', { name: 'Invoice #42' })).getAttribute('href')).toBe('/admin/billing/invoices/' + invoiceId);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Receipt email')).toBeDefined();
  expect(within(dialog).getByText('This sends the receipt email now.')).toBeDefined();
  expect(within(dialog).getByText(/Recovery exhausted .* ago/)).toBeDefined();
  expect(within(dialog).getByText(/five more resets/)).toBeDefined();
  expect(POST).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
  expect(POST).toHaveBeenCalledWith('/api/health/effect-failures/retry', { body: { effectId: id } });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('names the duplicate card refund and amount before retrying it', async () => {
  start({ ...base, kind: 'refund_duplicate', refund: { amountCents: 12500, currency: 'USD' } });
  await screen.findByText('Duplicate payment refund');
  expect(screen.getByText('Refund amount: $125.00')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/duplicate payment's \$125.00 to the card now/)).toBeDefined();
  expect(within(dialog).getByText(/existing refund is reconciled first/)).toBeDefined();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(POST).not.toHaveBeenCalled();
});
it('confirms dismissal as handled by hand and refreshes the Health queries', async () => {
  const { client } = start(), invalidate = vi.spyOn(client, 'invalidateQueries');
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/stops its automatic recovery/)).toBeDefined();
  expect(POST).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(POST).toHaveBeenCalledWith('/api/health/effect-failures/dismiss', { body: { effectId: id } }));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['health', 'gym-a'] }));
});
it.each(['activate_memberships', 'reverse_credits', 'dunning', 'retry', 'staff_notice'] as const)('explains the consequence for %s', async kind => {
  start({ ...base, kind });
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/This (activates|reverses|sends|asks)/)).toBeDefined();
  expect(dialog.textContent).not.toContain('health/effect-failures:');
});
it('keeps a failed action visible in the dialog and clears it when closed', async () => {
  start(); POST.mockResolvedValue({ response: new Response(null, { status: 409 }) } as never);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }));
  await screen.findByText(/The action could not be completed/);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText(/The action could not be completed/)).toBeNull();
});
