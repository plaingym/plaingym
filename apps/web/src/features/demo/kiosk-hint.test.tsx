// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetcher = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => '/kiosk' }));
vi.mock('../kiosk/api.js', async (original) => ({ ...await original<typeof import('../kiosk/api.js')>(), readToken: vi.fn(), saveToken: vi.fn() }));
vi.stubGlobal('fetch', fetcher);
const { DemoShell } = await import('./notice.js');
const { KioskApp } = await import('../kiosk/kiosk.js');
const { readToken } = await import('../kiosk/api.js');
const hint = /Search the full name Marcus Rivera with household PIN 2468/;
beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
    getUserMedia: vi.fn(async () => { throw new DOMException('Denied', 'NotAllowedError'); }),
  } });
});
afterEach(() => { cleanup(); fetcher.mockReset(); vi.mocked(readToken).mockReset(); });
afterAll(() => vi.unstubAllGlobals());
async function kiosk(mode: 'sandbox' | 'disabled', token: string | null = 'device-token') {
  vi.mocked(readToken).mockReturnValue(token);
  fetcher.mockResolvedValue(Response.json({ data: mode === 'sandbox' ? { mode, expiresAt: new Date(Date.now() + 3600_000).toISOString(), join: false } : { mode } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DemoShell><KioskApp /></DemoShell></QueryClientProvider>);
  await waitFor(() => expect(client.isFetching()).toBe(0));
}
it('shows the sample household only on the Name and PIN search, not on the choice or the QR flow', async () => {
  await kiosk('sandbox');
  expect(await screen.findByRole('button', { name: 'Name and PIN' })).toBeDefined();
  expect(screen.queryByText(hint)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' }));
  expect(screen.queryByText(hint)).toBeNull();
  // A denied camera offers the name search, and the hint appears with it.
  fireEvent.click(await screen.findByRole('button', { name: 'Use name and PIN' }));
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  expect(await screen.findByLabelText('Your name')).toBeDefined();
  expect(screen.getAllByText(hint)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.queryByText(hint)).toBeNull();
});
it('leaves the hint off the device setup screen', async () => {
  await kiosk('sandbox', null);
  expect(await screen.findByLabelText('Device token')).toBeDefined();
  expect(screen.queryByText(hint)).toBeNull();
});
it('shows no hint on an ordinary install', async () => {
  await kiosk('disabled');
  fireEvent.click(await screen.findByRole('button', { name: 'Name and PIN' }));
  expect(await screen.findByLabelText('Your name')).toBeDefined();
  expect(screen.queryByText(hint)).toBeNull();
});
