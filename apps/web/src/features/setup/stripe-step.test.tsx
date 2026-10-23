// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StripeStep } from './stripe-step.js';
afterEach(cleanup);
function setup(failure = 0) {
  const fetcher = vi.fn(async (path: RequestInfo | URL, _init?: RequestInit) => String(path) === '/api/setup'
    ? Response.json({ data: { currentStep: 6, completedSteps: [0, 1, 2, 3, 4, 5], completed: false, revision: 7 } })
    : failure ? Response.json({ error: { code: 'conflict', message: 'Private error' } }, { status: failure })
      : Response.json({ data: { configured: true, mode: 'test', webhookRegistered: true, revision: 8 } }));
  render(<QueryClientProvider client={new QueryClient()}><StripeStep fetcher={fetcher} /></QueryClientProvider>);
  return { fetcher, user: userEvent.setup() };
}
it('shows the full permission table, masks the key, and sends the current revision', async () => {
  const { fetcher, user } = setup();
  for (const resource of ['Setup Intents', 'Events', 'Disputes', 'Charges and Refunds']) expect(screen.getByText(resource)).toBeDefined();
  const field = screen.getByLabelText('Restricted Stripe key') as HTMLInputElement;
  expect(field.type).toBe('password');
  await user.type(field, 'rk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText('Stripe step saved. Continue to backups.')).toBeDefined();
  expect(JSON.parse(String(fetcher.mock.calls.find(([path]) => String(path) === '/api/setup/stripe')?.[1]?.body))).toEqual({ choice: 'configure', restrictedKey: 'rk_test_SYNTHETIC', revision: 7 });
});
it('refuses unrestricted keys without making a request', async () => {
  const { fetcher, user } = setup();
  await user.type(screen.getByLabelText('Restricted Stripe key'), 'sk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText(/beginning with rk_test_/)).toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();
});
it('clears the credential after a conflict and allows skipping', async () => {
  const { user } = setup(409);
  const field = screen.getByLabelText('Restricted Stripe key') as HTMLInputElement;
  await user.type(field, 'rk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText(/Setup changed/)).toBeDefined();
  expect(field.value).toBe('');
  expect(screen.getByRole('button', { name: 'Set up later' })).toBeDefined();
});
