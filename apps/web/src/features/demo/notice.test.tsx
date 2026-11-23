// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShellServicesContext } from '../../app/context.js';
import { createShellServices, type ShellBootstrap, type ShellServices } from '../../app/services.js';
import { instantLabel } from '../../lib/instant.js';

const fetcher = vi.fn();
const loadBootstrap = vi.fn<ShellServices['loadBootstrap']>();
const signedOutBootstrap: ShellBootstrap = {
  gym: { id: '019a0000-0000-7000-8000-0000000000ab', name: 'Demo gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
  session: null, login: { password: false, magicLink: true },
};
const route = vi.hoisted(() => ({ pathname: '/admin' }));
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => route.pathname }));
vi.stubGlobal('fetch', fetcher);
const { DemoShell, DemoKioskHint, TryDemoButton, useDemoExpiry, useDemoLogin, useDemoSandbox } = await import('./notice.js');
const { readToken } = await import('../kiosk/api.js');
beforeEach(() => {
  fetcher.mockReset();
  loadBootstrap.mockReset().mockResolvedValue({
    ...signedOutBootstrap, session: { userId: '019a0000-0000-7000-8000-0000000000ac', displayName: 'Demo owner', roles: ['owner'], member: false },
  });
  localStorage.clear(); route.pathname = '/admin'; window.history.replaceState(null, '', '/admin');
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); focusManager.setFocused(undefined); onlineManager.setOnline(true);
  vi.unstubAllGlobals(); vi.stubGlobal('fetch', fetcher);
});
afterAll(() => vi.unstubAllGlobals());
it('announces showcase preparation, prevents repeat activation, and opens the shared demo once ready', async () => {
  let finish!: (response: Response) => void;
  fetcher.mockResolvedValueOnce(Response.json({ data: { mode: 'entry' } }))
    .mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
  const navigate = vi.fn();
  const { client } = start(undefined, <section aria-label="Entry action"><TryDemoButton navigate={navigate} /></section>);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const action = within(screen.getByRole('region', { name: 'Entry action' }));
  const button = action.getByRole('button'); button.focus(); fireEvent.click(button); fireEvent.click(button);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(action.getByRole('status').textContent).toContain('Preparing sample members');
  expect(document.activeElement).toBe(button); expect(fetcher).toHaveBeenCalledTimes(2); expect(navigate).not.toHaveBeenCalled();
  const showcase = 'https://showcase.demo.example.test/demo#kioskToken=showcase-device';
  await act(async () => { finish(Response.json({ data: { mode: 'entry', showcase } })); });
  expect(navigate).toHaveBeenCalledExactlyOnceWith(showcase);
  expect(fetcher.mock.calls.every(([path]) => path === '/api/demo')).toBe(true);
});
it.each([500, 429])('offers a focused retry and useful feedback after HTTP %s', async status => {
  fetcher.mockResolvedValueOnce(Response.json({ data: { mode: 'entry' } })).mockResolvedValue(Response.json({}, { status }));
  const { client } = start(undefined, <section aria-label="Entry action"><TryDemoButton /></section>);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const action = within(screen.getByRole('region', { name: 'Entry action' }));
  fireEvent.click(action.getByRole('button'));
  expect((await action.findByRole('alert')).textContent).toContain(status === 429 ? 'capacity' : 'payment and storage');
  const retry = action.getByRole('button', { name: 'Retry creating demo' }); expect(document.activeElement).toBe(retry);
  expect(retry.getAttribute('aria-disabled')).toBe('false'); fireEvent.click(retry);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
});
function Consumer() {
  return <p>{useDemoSandbox() ? 'Sandbox consumer' : 'Ordinary consumer'}</p>;
}
function start(client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } }), children = <><p>Login screen</p><Consumer /></>) {
  const view = render(<StrictMode><QueryClientProvider client={client}>
    <ShellServicesContext.Provider value={createShellServices(loadBootstrap)}><DemoShell>{children}</DemoShell></ShellServicesContext.Provider>
  </QueryClientProvider></StrictMode>);
  return { ...view, client };
}
it('keeps a failed kiosk handoff in the fragment and explains blocked storage before mounting a route', async () => {
  window.history.replaceState(null, '', '/demo#kioskToken=demo-device');
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  fetcher.mockResolvedValue(Response.json({ data: { mode: 'sandbox', expiresAt: '2099-01-01T00:00:00.000Z', join: false } }));
  start();
  expect((await screen.findByRole('alert')).textContent).toContain('save');
  expect(window.location.hash).toContain('kioskToken=demo-device');
  expect(screen.queryByText('Login screen')).toBeNull();
  expect(screen.queryByText('Sandbox consumer')).toBeNull();
  storage.mockRestore();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Sandbox consumer');
  expect(localStorage.getItem('plaingym.kioskToken')).toBe('demo-device');
  expect(window.location.hash).toBe('');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('retries saving a private-copy token without consuming its handoff again', async () => {
  window.history.replaceState(null, '', '/demo#copyToken=' + 'a'.repeat(43));
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  fetcher.mockImplementation(async path => Response.json({ data: path === '/api/demo/handoff'
    ? { kioskToken: 'copy-device', redirect: '/demo' } : { mode: 'disabled' } }));
  start();
  // The link worked; only this browser's storage failed, so the visitor is not sent to make another copy.
  expect((await screen.findByRole('alert')).textContent).toContain('Allow browser storage, then try again');
  expect(screen.queryByText(/expired or was already used/)).toBeNull();
  expect(storage).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(storage).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/demo/handoff')).toHaveLength(1);
});
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
const sandbox = (join = false, expiresAt = new Date(Date.now() + 3600_000).toISOString()) =>
  Response.json({ data: { mode: 'sandbox', expiresAt, join } });
it.each(['sandbox', 'showcase'] as const)('exposes private-copy expiry to children in %s mode', async mode => {
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  fetcher.mockResolvedValue(Response.json({ data: { mode, expiresAt, join: false } }));
  function ExpiryConsumer() {
    return <p>{useDemoExpiry() ?? 'No sandbox expiry'}</p>;
  }
  start(undefined, <ExpiryConsumer />);
  await screen.findByRole('complementary', { name: 'Demo controls' });
  expect(screen.getByText(mode === 'sandbox' ? expiresAt : 'No sandbox expiry')).toBeDefined();
});
it('keeps an overdue showcase usable without a private-copy expiry notice', async () => {
  window.history.replaceState(null, '', '/admin#kioskToken=showcase-device');
  fetcher.mockImplementation(async (path: string) => Response.json({ data: path === '/api/demo/menu'
    ? { members: [], website: false } : { mode: 'showcase', expiresAt: '2000-01-01T00:00:00.000Z', join: false } }));
  start();
  const bar = await screen.findByRole('complementary', { name: 'Demo controls' });
  expect(within(bar).getByRole('button', { name: 'Make my own copy' })).toBeDefined();
  expect(readToken()).toBe('showcase-device');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(bar.textContent).not.toMatch(/expires/i);
  fireEvent.click(within(bar).getByRole('button', { name: 'Demo menu' }));
  const menu = await screen.findByRole('dialog', { name: 'Demo menu' });
  expect(menu.textContent).not.toMatch(/expires|deleted after/i);
  expect(within(menu).getByRole('button', { name: 'Sign in as owner' })).toBeDefined();
});
const riley = { id: '019a0000-0000-7000-8000-0000000000aa', name: 'Riley Visitor' };
/** Discovery, the demo menu and any other path, answered by path. */
function serve(options: { join?: boolean; expiresAt?: string; website?: boolean; members?: { id: string; name: string }[]; login?: () => Promise<Response> } = {}) {
  fetcher.mockImplementation(async (path: string) => path === '/api/demo' ? sandbox(options.join, options.expiresAt)
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
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  serve({ join: true, expiresAt, members: [riley] });
  start();
  const menu = await openMenu();
  const signIn = within(menu).getByRole('region', { name: 'Sign in as' });
  for (const role of ['owner', 'coach', 'student']) expect(within(signIn).getByRole('button', { name: 'Sign in as ' + role })).toBeDefined();
  expect(await within(signIn).findByRole('button', { name: 'Sign in as Riley Visitor' })).toBeDefined();
  const goTo = within(menu).getByRole('navigation', { name: 'Go to' });
  const admin = await within(goTo).findByRole('link', { name: 'Gym admin' });
  const portal = within(goTo).getByRole('button', { name: 'Member portal' });
  const outbox = within(goTo).getByRole('link', { name: 'Demo outbox' });
  expect(within(goTo).getAllByRole('link').map((link) => [link.textContent?.replace('→', ''), link.getAttribute('href')])).toEqual([
    ['Start page', '/demo'], ['Gym admin', '/admin'], ['Kiosk', '/kiosk'], ['Join page', '/join'], ['Demo outbox', '/admin/outbox']]);
  expect(portal.getAttribute('aria-current')).toBe('page');
  expect(admin.getAttribute('aria-current')).toBeNull();
  for (const link of [admin, outbox]) {
    link.addEventListener('click', event => event.preventDefault(), { once: true });
    fireEvent.click(link);
  }
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/demo/login')).toHaveLength(0);
  const about = within(menu).getByRole('region', { name: 'About this demo' });
  const expiryLabel = instantLabel(expiresAt);
  expect(within(about).getByText(/^Expires: /).textContent).toBe(`Expires: ${expiryLabel}`);
  expect(menu.textContent?.split(expiryLabel)).toHaveLength(2);
  expect(within(about).getByText(/Using this demo gym moves its deletion time later/)).toBeDefined();
  expect(menu.textContent).not.toMatch(/Marcus Rivera|4242/);
  fireEvent.click(within(menu).getByRole('button', { name: 'Close demo menu' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Demo menu' }));
});
it('keeps the demo menu closed after discovery fails while it is open and then recovers', async () => {
  let failing = false;
  fetcher.mockImplementation(async (path: string) => path === '/api/demo'
    ? failing ? Response.json({}, { status: 500 }) : sandbox()
    : path === '/api/demo/menu' ? Response.json({ data: { members: [], website: false } })
      : Response.json({}, { status: 404 }));
  const { client } = start();
  await openMenu();
  failing = true;
  await act(async () => { await client.refetchQueries({ queryKey: ['demo', 'discovery', window.location.origin] }); });
  await screen.findByRole('button', { name: 'Try again' });
  expect(screen.queryByRole('dialog', { name: 'Demo menu' })).toBeNull();
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  const bar = await screen.findByRole('complementary', { name: 'Demo controls' });
  expect(within(bar).getByRole('button', { name: 'Demo menu' })).toBeDefined();
  // A menu left open cannot reopen itself once discovery recovers.
  expect(screen.queryByRole('dialog', { name: 'Demo menu' })).toBeNull();
});
const protectedDestinations = [
  ['Gym admin', 'owner', '/admin', '/admin'],
  ['Member portal', 'student', '/portal', '/portal'],
  ['Demo outbox', 'owner', '/admin/outbox', '/admin'],
] as const;
it.each(protectedDestinations)('signs in from %s as the seeded %s', async (name, role, href, redirect) => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  loadBootstrap.mockResolvedValue(signedOutBootstrap);
  route.pathname = '/demo';
  serve({ login: async () => Response.json({ data: { redirect } }) });
  start();
  const goTo = within(within(await openMenu()).getByRole('navigation', { name: 'Go to' }));
  await waitFor(() => expect((goTo.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(goTo.getByRole('button', { name }));
  await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(href));
  const calls = fetcher.mock.calls.filter(([path]) => path === '/api/demo/login');
  expect(calls.map(([, init]) => init.method)).toEqual(['POST']);
  expect(calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ role }]);
});
it.each([
  ['Gym admin', '/admin'],
  ['Demo outbox', '/admin/outbox'],
] as const)('switches a coach to the owner for %s', async (name, href) => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  loadBootstrap.mockResolvedValue({
    ...signedOutBootstrap, session: { userId: 'coach', displayName: 'Coach', roles: ['coach'], member: false },
  });
  serve({ login: async () => Response.json({ data: { redirect: '/admin' } }) });
  start();
  const goTo = within(within(await openMenu()).getByRole('navigation', { name: 'Go to' }));
  const portal = goTo.getByRole('button', { name: 'Member portal' }) as HTMLButtonElement;
  await waitFor(() => expect(portal.disabled).toBe(false));
  expect(goTo.getByRole('button', { name: 'Gym admin' })).toBeDefined();
  expect(goTo.getByRole('button', { name: 'Demo outbox' })).toBeDefined();
  fireEvent.click(goTo.getByRole('button', { name }));
  await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(href));
  const calls = fetcher.mock.calls.filter(([path]) => path === '/api/demo/login');
  expect(calls.map(([, init]) => [init.method, JSON.parse(String(init.body))])).toEqual([['POST', { role: 'owner' }]]);
});
it.each(['coach', 'owner'] as const)('signs a %s without member access in to the member portal from the menu', async role => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  loadBootstrap.mockResolvedValue({
    ...signedOutBootstrap, session: { userId: role, displayName: 'Staff', roles: [role], member: false },
  });
  serve({ login: async () => Response.json({ data: { redirect: '/portal' } }) });
  start();
  const goTo = within(within(await openMenu()).getByRole('navigation', { name: 'Go to' }));
  const portal = goTo.getByRole('button', { name: 'Member portal' }) as HTMLButtonElement;
  await waitFor(() => expect(portal.disabled).toBe(false));
  expect(goTo.queryByRole('link', { name: 'Member portal' })).toBeNull();
  fireEvent.click(portal);
  await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/portal'));
  const calls = fetcher.mock.calls.filter(([path]) => path === '/api/demo/login');
  expect(calls.map(([, init]) => [init.method, JSON.parse(String(init.body))])).toEqual([['POST', { role: 'student' }]]);
});
it('offers owner sign-in controls to a member while keeping the portal link', async () => {
  loadBootstrap.mockResolvedValue({
    ...signedOutBootstrap, session: { userId: 'member', displayName: 'Member', roles: [], member: true },
  });
  serve();
  start();
  const goTo = within(within(await openMenu()).getByRole('navigation', { name: 'Go to' }));
  expect((await goTo.findByRole('link', { name: 'Member portal' })).getAttribute('href')).toBe('/portal');
  for (const name of ['Gym admin', 'Demo outbox']) {
    expect((goTo.getByRole<HTMLButtonElement>('button', { name })).disabled).toBe(false);
  }
});
it.each(['owner', 'admin'] as const)('keeps admin destinations as links for an %s session', async role => {
  loadBootstrap.mockResolvedValue({
    ...signedOutBootstrap, session: { userId: 'staff', displayName: 'Staff', roles: [role], member: false },
  });
  serve();
  start();
  const goTo = within(within(await openMenu()).getByRole('navigation', { name: 'Go to' }));
  expect((await goTo.findByRole('link', { name: 'Gym admin' })).getAttribute('href')).toBe('/admin');
  expect(goTo.getByRole('link', { name: 'Demo outbox' }).getAttribute('href')).toBe('/admin/outbox');
});
it('disables guarded destinations during bootstrap and offers links when it fails', async () => {
  let fail!: (reason: Error) => void;
  loadBootstrap.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  serve();
  start();
  const goTo = within(within(await openMenu()).getByRole('navigation', { name: 'Go to' }));
  for (const [name] of protectedDestinations) {
    const button = goTo.getByRole('button', { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/demo/login')).toHaveLength(0);
  await act(async () => { fail(new Error('Bootstrap unavailable')); });
  for (const [name, , href] of protectedDestinations) {
    expect((await goTo.findByRole('link', { name })).getAttribute('href')).toBe(href);
  }
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
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Page sign-in' }) as HTMLButtonElement).disabled).toBe(false);
});
it('keeps focus on the Demo menu button when closing the menu reveals the bar alert', async () => {
  serve({ login: () => Promise.reject(new TypeError('Offline')) });
  start(undefined, <PageSignIn />);
  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole('button', { name: 'Sign in as owner' }));
  await within(menu).findByRole('alert');
  fireEvent.click(within(menu).getByRole('button', { name: 'Close demo menu' }));
  const bar = screen.getByRole('complementary', { name: 'Demo controls' });
  expect(within(bar).getByRole('alert')).toBeDefined();
  expect(document.activeElement).toBe(within(bar).getByRole('button', { name: 'Demo menu' }));
});
it('disables every sign-in while one is pending and restores them after a failure', async () => {
  let fail!: (reason: Error) => void;
  loadBootstrap.mockResolvedValue(signedOutBootstrap);
  serve({ members: [riley], login: () => new Promise<Response>((_resolve, reject) => { fail = reject; }) });
  start();
  const menu = await openMenu();
  await within(menu).findByRole('button', { name: 'Sign in as Riley Visitor' });
  const names = ['Sign in as owner', 'Sign in as coach', 'Sign in as student', 'Sign in as Riley Visitor', ...protectedDestinations.map(([name]) => name)];
  const buttons = names.map(name => within(menu).getByRole('button', { name }) as HTMLButtonElement);
  await waitFor(() => expect(buttons.every(button => !button.disabled)).toBe(true));
  fireEvent.click(within(menu).getByRole('button', { name: 'Sign in as coach' }));
  for (const button of buttons) {
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/demo/login')).toHaveLength(1);
  await act(async () => { fail(new TypeError('Offline')); });
  await within(menu).findByRole('alert');
  expect(buttons.every(button => !button.disabled)).toBe(true);
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
