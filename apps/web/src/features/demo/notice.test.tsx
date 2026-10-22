// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetcher = vi.fn();
vi.stubGlobal('fetch', fetcher);
const { DemoShell } = await import('./notice.js');
beforeEach(() => fetcher.mockReset());
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
function start() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DemoShell><p>Login screen</p></DemoShell></QueryClientProvider>);
}
it('keeps demo controls hidden on ordinary installs', async () => {
  fetcher.mockResolvedValue(Response.json({}, { status: 404 }));
  start();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Login screen')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows a demo entry button without requiring a tenant or login', async () => {
  fetcher.mockImplementation(async (path: string) => path === '/api/demo'
    ? Response.json({ data: { enabled: true } }) : Response.json({}, { status: 404 }));
  start();
  expect(await screen.findByRole('button', { name: 'Try the demo' })).toBeDefined();
  expect(screen.getByText('Login screen')).toBeDefined();
});
it('shows all sandbox identities before the login screen guard', async () => {
  fetcher.mockImplementation(async (path: string) => path === '/api/demo/status'
    ? Response.json({ data: { expiresAt: '2026-10-23T16:00:00.000Z' } }) : Response.json({}, { status: 404 }));
  start();
  expect(await screen.findByRole('button', { name: 'Sign in as owner' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Sign in as coach' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Sign in as student' })).toBeDefined();
  expect(screen.getByText('Login screen')).toBeDefined();
});
