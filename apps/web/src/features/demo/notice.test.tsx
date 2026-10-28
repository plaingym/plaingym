// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetcher = vi.fn();
const route = vi.hoisted(() => ({ pathname: '/admin' }));
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => route.pathname }));
vi.stubGlobal('fetch', fetcher);
const { DemoShell, DemoKioskHint, TryDemoButton, useDemoSandbox } = await import('./notice.js');
const { readToken } = await import('../kiosk/api.js');
beforeEach(() => { fetcher.mockReset(); localStorage.clear(); route.pathname = '/admin'; window.history.replaceState(null, '', '/admin'); });
afterEach(() => { cleanup(); vi.useRealTimers(); focusManager.setFocused(undefined); onlineManager.setOnline(true); });
afterAll(() => vi.unstubAllGlobals());
it('announces creation immediately, prevents repeat activation, and navigates only after success', async () => {
  let finish!: (response: Response) => void;
  fetcher.mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
  const navigate = vi.fn(); render(<TryDemoButton navigate={navigate} />);
  const button = screen.getByRole('button'); button.focus(); fireEvent.click(button); fireEvent.click(button);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('status').textContent).toContain('Preparing sample members');
  expect(document.activeElement).toBe(button); expect(fetcher).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled();
  await act(async () => { finish(Response.json({ data: { gymId: '019a0000-0000-7000-8000-000000000001', origin: 'https://sample.demo.localhost',
    expiresAt: '2026-11-01T00:00:00.000Z', kioskToken: 'device-token-for-success-test' } })); });
  expect(navigate).toHaveBeenCalledOnce(); const destination = new URL(navigate.mock.calls[0]![0] as string);
  expect(destination.origin).toBe('https://sample.demo.localhost'); expect(destination.pathname).toBe('/admin');
});
it.each([500, 429])('offers a focused retry and useful feedback after HTTP %s', async status => {
  fetcher.mockResolvedValue(Response.json({}, { status })); render(<TryDemoButton />);
  fireEvent.click(screen.getByRole('button'));
  expect((await screen.findByRole('alert')).textContent).toContain(status === 429 ? 'capacity' : 'payment and storage');
  const retry = screen.getByRole('button', { name: 'Retry creating demo' }); expect(document.activeElement).toBe(retry);
  expect(retry.getAttribute('aria-disabled')).toBe('false'); fireEvent.click(retry);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
function Consumer() {
  return <p>{useDemoSandbox() ? 'Sandbox consumer' : 'Ordinary consumer'}</p>;
}
function start(client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } }), children = <><p>Login screen</p><Consumer /></>) {
  const view = render(<StrictMode><QueryClientProvider client={client}><DemoShell>{children}</DemoShell></QueryClientProvider></StrictMode>);
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
it('saves the sandbox kiosk token and strips only its fragment parameter before mounting the route', async () => {
  window.history.replaceState({ route: 'kept' }, '', '/admin?view=welcome#kioskToken=visitor-device&tab=members');
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString() } }));
  start();
  await screen.findByText('Login screen');
  expect(readToken()).toBe('visitor-device');
  expect(window.location.pathname + window.location.search + window.location.hash).toBe('/admin?view=welcome#tab=members');
  expect(window.history.state).toEqual({ route: 'kept' });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/demo']);
});
it.each(['disabled', 'entry'] as const)('ignores kiosk token handoffs in %s mode', async (mode) => {
  window.history.replaceState(null, '', '/demo#kioskToken=ignored-device');
  fetcher.mockResolvedValue(Response.json({ data: { mode } }));
  const view = start();
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  expect(readToken()).toBeNull();
  expect(window.location.hash).toBe('#kioskToken=ignored-device');
  expect(screen.getByText('Login screen')).toBeDefined();
});
it('does not consume a token until sandbox discovery succeeds', async () => {
  window.history.replaceState(null, '', '/admin#kioskToken=visitor-device');
  let discover!: (response: Response) => void;
  fetcher.mockReturnValue(new Promise<Response>((resolve) => { discover = resolve; }));
  start();
  expect(readToken()).toBeNull();
  expect(window.location.hash).toBe('#kioskToken=visitor-device');
  expect(screen.queryByText('Login screen')).toBeNull();
  await act(async () => { discover(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString() } })); });
  await screen.findByText('Login screen');
  expect(readToken()).toBe('visitor-device');
  expect(window.location.hash).toBe('');
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
  expect(screen.getByText(/Search the full name Marcus Rivera with household PIN 2468/)).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('opens the guide under its own label without offering sandbox creation', async () => {
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString() } }));
  start();
  const button = await screen.findByRole('button', { name: 'Demo guide' });
  button.focus(); fireEvent.click(button);
  const guide = screen.getByRole('dialog', { name: 'Demo guide' });
  expect(within(guide).getByText(/Marcus Rivera.*2468/)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Try the demo' })).toBeNull();
  fireEvent.click(within(guide).getByRole('button', { name: 'Close demo guide' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Demo guide' }));
});
it('disables all role switches while one is pending and restores them after a failure', async () => {
  let fail!: (reason: Error) => void;
  const pending = new Promise<Response>((_resolve, reject) => { fail = reject; });
  fetcher.mockResolvedValueOnce(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString() } }))
    .mockReturnValueOnce(pending);
  start();
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in as coach' }));
  for (const role of ['owner', 'coach', 'student']) {
    const button = screen.getByRole('button', { name: 'Sign in as ' + role }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/demo/login')).toHaveLength(1);
  await act(async () => { fail(new TypeError('Offline')); });
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Sign in as owner' }) as HTMLButtonElement).disabled).toBe(false);
});
it.each(['disabled', 'entry', 'sandbox'] as const)('shows the kiosk hint only for a sandbox (%s)', async (mode) => {
  route.pathname = '/kiosk';
  fetcher.mockResolvedValue(Response.json({ data: mode === 'sandbox' ? { mode, expiresAt: new Date(Date.now() + 3600_000).toISOString() } : { mode } }));
  const view = start(undefined, <DemoKioskHint />);
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  expect(screen.queryAllByText(/Search the full name Marcus Rivera/)).toHaveLength(mode === 'sandbox' ? 1 : 0);
  expect(screen.queryByRole('link', { name: 'Try the kiosk' })).toBeNull();
});
it('updates the compact banner when navigating to the kiosk without new discovery requests', async () => {
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString() } }));
  const view = start();
  await screen.findByRole('link', { name: 'Try the kiosk' });
  route.pathname = '/kiosk/';
  view.rerender(<QueryClientProvider client={view.client}><DemoShell><DemoKioskHint /></DemoShell></QueryClientProvider>);
  expect(screen.queryByRole('link', { name: 'Try the kiosk' })).toBeNull();
  expect(screen.getAllByText(/Search the full name Marcus Rivera/)).toHaveLength(1);
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
