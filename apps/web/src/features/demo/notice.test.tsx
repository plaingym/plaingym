// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetcher = vi.fn();
vi.stubGlobal('fetch', fetcher);
const { DemoShell, useDemoSandbox } = await import('./notice.js');
beforeEach(() => fetcher.mockReset());
afterEach(() => { cleanup(); vi.useRealTimers(); focusManager.setFocused(undefined); onlineManager.setOnline(true); });
afterAll(() => vi.unstubAllGlobals());
function Consumer() {
  return <p>{useDemoSandbox() ? 'Sandbox consumer' : 'Ordinary consumer'}</p>;
}
function start(client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })) {
  const view = render(<StrictMode><QueryClientProvider client={client}><DemoShell><p>Login screen</p><Consumer /></DemoShell></QueryClientProvider></StrictMode>);
  return { ...view, client };
}
it('shares one successful disabled discovery across navigation, focus, reconnect and root remounts', async () => {
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'disabled' } }));
  const first = start();
  await waitFor(() => expect(first.client.isFetching()).toBe(0));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe('/api/demo');
  expect(screen.getByText('Login screen')).toBeDefined();
  expect(screen.getByText('Ordinary consumer')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
  first.unmount();
  start(first.client);
  await act(async () => {
    first.client.setQueryData(['staff', 'profiles'], []);
    focusManager.setFocused(false); focusManager.setFocused(true);
    onlineManager.setOnline(false); onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('shows a demo entry button without requiring a tenant or login', async () => {
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'entry' } }));
  start();
  expect(await screen.findByRole('button', { name: 'Try the demo' })).toBeDefined();
  expect(screen.getByText('Login screen')).toBeDefined();
  expect(screen.getByText('Ordinary consumer')).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shows all sandbox identities before the login screen guard', async () => {
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString() } }));
  start();
  expect(await screen.findByRole('button', { name: 'Sign in as owner' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Sign in as coach' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Sign in as student' })).toBeDefined();
  expect(screen.getByText('Login screen')).toBeDefined();
  expect(screen.getByText('Sandbox consumer')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Try the demo' })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['server', 'transport', 'invalid response'] as const)('keeps a %s error visible and permits an explicit retry', async (failure) => {
  if (failure === 'transport') fetcher.mockRejectedValueOnce(new TypeError('Network unavailable'));
  else fetcher.mockResolvedValueOnce(failure === 'server' ? Response.json({}, { status: 500 }) : Response.json({ data: {} }));
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'disabled' } }));
  start();
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(screen.getByText('Ordinary consumer')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('expires a cached sandbox, hides impersonation and rechecks discovery once', async () => {
  vi.useFakeTimers();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  fetcher.mockResolvedValueOnce(Response.json({ data: { mode: 'sandbox', expiresAt } }))
    .mockResolvedValue(Response.json({}, { status: 404 }));
  start();
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(screen.getByText('Sandbox consumer')).toBeDefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText('Ordinary consumer')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Sign in as owner' })).toBeNull();
  expect(screen.getByRole('alert')).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
