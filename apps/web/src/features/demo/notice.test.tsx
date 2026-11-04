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
const { DemoShell, DemoKioskHint, TryDemoButton, useDemoLogin, useDemoSandbox } = await import('./notice.js');
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
  expect(destination.origin).toBe('https://sample.demo.localhost'); expect(destination.pathname).toBe('/demo');
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
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString(), join: false } }));
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
  await act(async () => { discover(Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString(), join: false } })); });
  await screen.findByText('Login screen');
  expect(readToken()).toBe('visitor-device');
  expect(window.location.hash).toBe('');
});
const sandbox = (join = false) => Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString(), join } });
const riley = { id: '019a0000-0000-7000-8000-0000000000aa', name: 'Riley Visitor' };
/** Discovery, the demo menu and any other path, answered by path. */
function serve(options: { join?: boolean; website?: boolean; members?: { id: string; name: string }[]; login?: () => Promise<Response> } = {}) {
  fetcher.mockImplementation(async (path: string) => path === '/api/demo' ? sandbox(options.join)
    : path === '/api/demo/menu' ? Response.json({ data: { members: options.members ?? [], website: options.website ?? false } })
      : path === '/api/demo/login' && options.login ? options.login() : Response.json({}, { status: 404 }));
}
const openMenu = async () => {
  const button = await screen.findByRole('button', { name: 'Demo menu' });
  button.focus(); fireEvent.click(button);
  return screen.getByRole('dialog', { name: 'Demo menu' });
};
it('keeps the bar to one slim row: the sandbox, its expiry and the demo menu, with no hints or links', async () => {
  serve();
  start();
  const bar = await screen.findByRole('complementary', { name: 'Demo controls' });
  await within(bar).findByRole('button', { name: 'Demo menu' });
  expect(within(bar).getAllByRole('button')).toHaveLength(1);
  expect(within(bar).queryAllByRole('link')).toHaveLength(0);
  expect(bar.textContent).toMatch(/^Demo gym · expires .+Demo menu$/);
  expect(bar.textContent).not.toMatch(/Marcus Rivera|4242|outbox/);
  expect(screen.getByText('Login screen')).toBeDefined();
  expect(screen.getByText('Sandbox consumer')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Try the demo' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Sign in as owner' })).toBeNull();
  // The bar fetches nothing beyond discovery; the menu loads its members when opened.
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/demo']);
});
it('opens the demo menu with its labelled groups and returns focus to the bar on close', async () => {
  route.pathname = '/portal/schedule';
  serve({ join: true, members: [riley] });
  start();
  const menu = await openMenu();
  const signIn = within(menu).getByRole('region', { name: 'Sign in as' });
  for (const role of ['owner', 'coach', 'student']) expect(within(signIn).getByRole('button', { name: 'Sign in as ' + role })).toBeDefined();
  expect(await within(signIn).findByRole('button', { name: 'Sign in as Riley Visitor' })).toBeDefined();
  const goTo = within(menu).getByRole('navigation', { name: 'Go to' });
  expect(within(goTo).getAllByRole('link').map((link) => [link.textContent?.replace('→', ''), link.getAttribute('href')])).toEqual([
    ['Start page', '/demo'], ['Gym admin', '/admin'], ['Member portal', '/portal'], ['Kiosk', '/kiosk'], ['Join page', '/join'], ['Demo outbox', '/admin/outbox']]);
  expect(within(goTo).getByRole('link', { name: 'Member portal' }).getAttribute('aria-current')).toBe('page');
  expect(within(goTo).getByRole('link', { name: 'Gym admin' }).getAttribute('aria-current')).toBeNull();
  const about = within(menu).getByRole('region', { name: 'About this demo' });
  expect(within(about).getByText(/^Expires: /)).toBeDefined();
  expect(within(about).getByText(/deleted after 24 hours/)).toBeDefined();
  expect(menu.textContent).not.toMatch(/Marcus Rivera|4242/);
  fireEvent.click(within(menu).getByRole('button', { name: 'Close demo menu' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Demo menu' }));
});
it.each([[true, true], [false, false]] as const)('lists the website only when it is on (%s), and the join page only when joining is', async (on, join) => {
  serve({ website: on, join });
  start();
  const goTo = within(await openMenu()).getByRole('navigation', { name: 'Go to' });
  await waitFor(() => expect(fetcher.mock.calls.some(([path]) => path === '/api/demo/menu')).toBe(true));
  await waitFor(() => expect(within(goTo).queryByRole('link', { name: 'Gym website' })?.getAttribute('href') ?? null).toBe(on ? '/' : null));
  expect(within(goTo).queryByRole('link', { name: 'Join page' }) !== null).toBe(join);
});
it('signs in as a joined member from the menu', async () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  serve({ members: [riley], login: async () => Response.json({ data: { redirect: '/portal' } }) });
  start();
  fireEvent.click(await within(await openMenu()).findByRole('button', { name: 'Sign in as Riley Visitor' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('/portal'));
  const call = fetcher.mock.calls.find(([path]) => path === '/api/demo/login')!;
  expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ member: riley.id });
  vi.unstubAllGlobals(); vi.stubGlobal('fetch', fetcher);
});
function PageSignIn() {
  const { login, pending } = useDemoLogin();
  return <button type="button" disabled={pending} onClick={() => { void login('student'); }}>Page sign-in</button>;
}
it('shares one sign-in state between the menu and a page inside the shell, and reports the failure in the bar', async () => {
  let fail!: (reason: Error) => void;
  serve({ login: () => new Promise<Response>((_resolve, reject) => { fail = reject; }) });
  start(undefined, <PageSignIn />);
  fireEvent.click(await screen.findByRole('button', { name: 'Page sign-in' }));
  const menu = await openMenu();
  expect((within(menu).getByRole('button', { name: 'Sign in as owner' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(menu).getByRole('button', { name: 'Sign in as owner' }));
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/demo/login')).toHaveLength(1);
  await act(async () => { fail(new TypeError('Offline')); });
  // While the menu is open the error shows in it; once closed, in the bar's row.
  expect(within(menu).getByRole('alert').textContent).toContain('The demo is unavailable');
  expect(await screen.findAllByRole('alert')).toHaveLength(1);
  fireEvent.click(within(menu).getByRole('button', { name: 'Close demo menu' }));
  const bar = screen.getByRole('complementary', { name: 'Demo controls' });
  expect(within(bar).getByRole('alert').textContent).toContain('The demo is unavailable');
  expect((screen.getByRole('button', { name: 'Page sign-in' }) as HTMLButtonElement).disabled).toBe(false);
});
it('disables every sign-in while one is pending and restores them after a failure', async () => {
  let fail!: (reason: Error) => void;
  serve({ members: [riley], login: () => new Promise<Response>((_resolve, reject) => { fail = reject; }) });
  start();
  const menu = await openMenu();
  await within(menu).findByRole('button', { name: 'Sign in as Riley Visitor' });
  fireEvent.click(within(menu).getByRole('button', { name: 'Sign in as coach' }));
  for (const name of ['Sign in as owner', 'Sign in as coach', 'Sign in as student', 'Sign in as Riley Visitor']) {
    const button = within(menu).getByRole('button', { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/demo/login')).toHaveLength(1);
  await act(async () => { fail(new TypeError('Offline')); });
  await within(menu).findByRole('alert');
  expect((within(menu).getByRole('button', { name: 'Sign in as owner' }) as HTMLButtonElement).disabled).toBe(false);
});
it.each(['disabled', 'entry', 'sandbox'] as const)('shows the kiosk hint only for a sandbox (%s)', async (mode) => {
  route.pathname = '/kiosk';
  fetcher.mockResolvedValue(mode === 'sandbox' ? sandbox() : Response.json({ data: { mode } }));
  const view = start(undefined, <DemoKioskHint />);
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  expect(screen.queryAllByText(/Search the full name Marcus Rivera/)).toHaveLength(mode === 'sandbox' ? 1 : 0);
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
  fetcher.mockResolvedValueOnce(Response.json({ data: { mode: 'sandbox', expiresAt, join: false } }))
    .mockResolvedValue(Response.json({}, { status: 404 }));
  start();
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(screen.getByText('Sandbox consumer')).toBeDefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText('Ordinary consumer')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Demo menu' })).toBeNull();
  expect(screen.getByRole('alert')).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
