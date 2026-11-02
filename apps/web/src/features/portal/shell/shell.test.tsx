// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { NavigationEntry } from '@plaingym/shared';
import { App, createShellQueryClient } from '../../../app.js';
import { ShellServicesContext } from '../../../app/context.js';
import { createAppRouter } from '../../../app/router.js';
import type { ShellServices } from '../../../app/services.js';
import { portalNavigation } from './shell.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('filters disabled, staff, payer-only and inactive-module navigation for adult members', () => {
  const self: NavigationEntry = { id: 'self', href: '/portal', labelKey: 'Self', enabled: true, permission: { kind: 'member', capability: 'profile.read' } };
  const payer: NavigationEntry = { ...self, id: 'payer', permission: { kind: 'member', capability: 'billing.manage' } };
  const entries = [self, payer, { ...self, id: 'disabled', enabled: false }, { ...self, id: 'module', moduleId: 'disabled' }, { ...self, id: 'staff', permission: { kind: 'staff' as const, capability: 'members.read' as const } }];
  expect(portalNavigation(entries, 'member', []).map(row => row.id)).toEqual(['self']);
  expect(portalNavigation(entries, 'payer', []).map(row => row.id)).toEqual(['self', 'payer']);
});
it('loads member context, renders the portal, and clears access when signing out', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  const userId = '00000000-0000-7000-8000-000000000001', householdId = '00000000-0000-7000-8000-000000000002';
  const fetcher = vi.fn(async (path: string) => Response.json(path === '/api/demo' ? { data: { mode: 'disabled' } }
    : path === '/api/portal/households' ? { data: { current: householdId, households: [{ householdId, name: 'Only household', role: 'payer' }] } }
    : { data: { role: 'payer', householdId, memberId: null } }));
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: userId, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId, displayName: 'Test User', roles: [], member: true }, login: { password: true, magicLink: false } }), signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/portal'] })); render(<App services={services} router={router} />);
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  expect(fetcher).toHaveBeenCalledWith('/api/portal/context', expect.objectContaining({ credentials: 'same-origin' }));
  // The header names the gym, then the signed-in person and their scope in this household, outside the collapsed menu.
  const identity = screen.getByTestId('signed-in-identity');
  expect(identity.textContent).toBe('Test User · Account holder');
  expect(identity.closest('header')?.textContent).toContain('Test Gym');
  expect(identity.closest('nav')).toBeNull(); expect(screen.getByText('Test User').className).toContain('truncate');
  // A single household needs no picker or switcher.
  expect(screen.queryByRole('combobox')).toBeNull();
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Menu' }));
  expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('true');
  await user.keyboard('{Escape}'); expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  await user.click(screen.getByRole('button', { name: 'Sign out' })); await waitFor(() => expect(services.signOut).toHaveBeenCalledOnce());
});

const ids = { user: '00000000-0000-7000-8000-000000000001', first: '00000000-0000-7000-8000-000000000002', second: '00000000-0000-7000-8000-000000000003', member: '00000000-0000-7000-8000-000000000004' };
/** A request the test answers itself, so a race runs in the order the test chooses and never on a timer. */
type Gate = { wait: Promise<void>; settle(): void; fail(): void };
const gate = (): Gate => {
  let settle!: () => void, fail!: () => void;
  const wait = new Promise<void>((resolve, reject) => { settle = resolve; fail = () => reject(new Error('refused')); });
  return { wait, settle, fail };
};
/**
 * With `hold`, every bootstrap load after the first waits for its own gate (in `bootstrapGates`, in order); with `holdHouseholds`,
 * so does every household list load after the first. `release()` settles every gate, now and later.
 */
function portal(initial: string | null, { path = '/portal', hold = false, holdHouseholds = false }: { path?: string; hold?: boolean; holdHouseholds?: boolean } = {}) {
  vi.stubGlobal('scrollTo', vi.fn());
  let current = initial, released = false;
  const bootstrapGates: Gate[] = [], householdGates: Gate[] = [];
  const households = [{ householdId: ids.first, name: 'Alder household', role: 'payer' }, { householdId: ids.second, name: 'Birch household', role: 'member' }];
  let householdLoads = 0;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/demo') return Response.json({ data: { mode: 'disabled' } });
    if (path === '/api/portal/households/current') { current = (JSON.parse(String(init!.body)) as { householdId: string }).householdId; return Response.json({ data: null }); }
    if (path === '/api/portal/households') {
      const answer = Response.json({ data: { current, households } });
      if (holdHouseholds && householdLoads++ > 0 && !released) { const held = gate(); householdGates.push(held); await held.wait; }
      return answer;
    }
    if (path === '/api/portal/context') return current === ids.first ? Response.json({ data: { role: 'payer', householdId: ids.first, memberId: null } })
      : current === ids.second ? Response.json({ data: { role: 'member', householdId: ids.second, memberId: ids.member } }) : new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  let bootstrapLoads = 0;
  const services: ShellServices = { loadBootstrap: async () => {
    // The server names the person by the household that is open when the request arrives.
    const session = { userId: ids.user, displayName: current === ids.second ? 'Noa Second' : 'Test User', roles: [], member: true };
    if (hold && bootstrapLoads++ > 0 && !released) { const held = gate(); bootstrapGates.push(held); await held.wait; }
    return { gym: { id: ids.user, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session, login: { password: true, magicLink: false } };
  }, signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  // The same providers `App` supplies, with the cache in hand so a test can do what garbage collection does.
  const cache = createShellQueryClient();
  render(<QueryClientProvider client={cache}><ShellServicesContext.Provider value={services}><RouterProvider router={router} /></ShellServicesContext.Provider></QueryClientProvider>);
  const selections = () => fetcher.mock.calls.filter(([path]) => path === '/api/portal/households/current').map(([, init]) => JSON.parse(String(init!.body)));
  // What the server does on its own, such as falling back to another household when a link is revoked.
  const serverOpens = (householdId: string) => { current = householdId; };
  const release = () => { released = true; for (const held of [...bootstrapGates, ...householdGates]) held.settle(); };
  return { fetcher, selections, router, release, serverOpens, bootstrapGates, householdGates, cache };
}
const identity = () => screen.getByTestId('signed-in-identity').textContent;
it('asks a login with several households to choose one before showing the portal', async () => {
  const f = portal(null), user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: 'Choose a household' })).toBeDefined();
  expect(f.fetcher.mock.calls.some(([path]) => path === '/api/portal/context')).toBe(false);
  expect(screen.queryByRole('heading', { name: 'Welcome to your member portal' })).toBeNull();
  await user.click(screen.getByRole('button', { name: /Birch household/ }));
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  expect(f.selections()).toEqual([{ householdId: ids.second }]);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.second);
});
it('switches households from the header and reloads the portal for the new household only', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  await waitFor(() => expect(screen.getByTestId('signed-in-identity').textContent).toBe('Test User · Account holder'));
  const contextCalls = () => f.fetcher.mock.calls.filter(([path]) => path === '/api/portal/context').length, before = contextCalls();
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.second));
  expect(f.selections()).toEqual([{ householdId: ids.second }]);
  expect(contextCalls()).toBeGreaterThan(before);
  // The scope follows the household that is open: the same person is only a member of the second one.
  // and so does the name, which the server derives from the open household, not a cached copy from the first one.
  await waitFor(() => expect(screen.getByTestId('signed-in-identity').textContent).toBe('Noa Second · Member'));
});
it('updates the header name when the server opens another household on its own', async () => {
  const f = portal(ids.first);
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  await waitFor(() => expect(screen.getByTestId('signed-in-identity').textContent).toBe('Test User · Account holder'));
  // A revoked link makes the server fall back to the other household; the next households load reports it.
  f.serverOpens(ids.second);
  act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
  await waitFor(() => expect(screen.getByTestId('signed-in-identity').textContent).toBe('Noa Second · Member'));
  expect(f.selections()).toEqual([]);
});
it('navigates a household switch home before the name refetch settles', async () => {
  const f = portal(ids.first, { path: '/portal/schedule', hold: true }), user = userEvent.setup();
  await screen.findByRole('combobox');
  expect(f.router.state.location.pathname).toBe('/portal/schedule');
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  // The bootstrap refetch is held, yet the switch has already gone home.
  await waitFor(() => expect(f.router.state.location.pathname).toBe('/portal'));
  expect(screen.getByTestId('signed-in-identity').textContent).toContain('Test User');
  f.release();
  await waitFor(() => expect(screen.getByTestId('signed-in-identity').textContent).toBe('Noa Second · Member'));
});
const claimHeading = () => screen.findByRole('heading', { name: 'Set up your portal login' });
it('refetches the name when the layout remounts while a household switch settles', async () => {
  const f = portal(ids.first, { hold: true, holdHouseholds: true }), user = userEvent.setup();
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  // The switch is stored; it waits only for the household list it reset.
  await waitFor(() => expect(f.householdGates).toHaveLength(1));
  // The layout unmounts and mounts again before the switch finishes, so nothing it remembered survives.
  await act(() => f.router.navigate({ to: '/portal/claim' }));
  await claimHeading();
  f.householdGates[0]!.settle();
  await waitFor(() => expect(f.router.state.location.pathname).toBe('/portal'));
  await screen.findByRole('combobox');
  // The switch itself asked for the new name; the remounted layout did not have to notice the change.
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
  f.bootstrapGates[0]!.settle();
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
});
it('refetches the name when the layout remounts after the server opened another household and the cache lost the lists', async () => {
  const f = portal(ids.first, { hold: true });
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  await act(() => f.router.navigate({ to: '/portal/claim' }));
  await claimHeading();
  // A link was revoked meanwhile, and the household lists were collected, as an unwatched query is after a while.
  f.serverOpens(ids.second);
  f.cache.removeQueries({ queryKey: ['portal'] });
  await act(() => f.router.navigate({ to: '/portal' }));
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
  f.bootstrapGates[0]!.settle();
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
});
it('refetches the name for every switch of an A → B → A series, and the last answer wins', async () => {
  const f = portal(ids.first, { hold: true }), user = userEvent.setup();
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
  // The switch back comes while the first refetch is still in flight.
  await waitFor(() => expect(screen.getByRole('combobox')).toBeDefined());
  await user.selectOptions(screen.getByRole('combobox'), ids.first);
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(2));
  expect(f.selections()).toEqual([{ householdId: ids.second }, { householdId: ids.first }]);
  // The slow answer for B arrives after the one for A was asked for, and must not name the person.
  f.bootstrapGates[0]!.settle(); f.bootstrapGates[1]!.settle();
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.first));
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  // And a third switch asks again, as every one does.
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(3));
  f.bootstrapGates[2]!.settle();
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
});
it('refetches the name even when going home fails after the switch was stored', async () => {
  const f = portal(ids.first, { hold: true }), user = userEvent.setup();
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  vi.spyOn(f.router, 'navigate').mockRejectedValueOnce(new Error('navigation refused'));
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
  f.bootstrapGates[0]!.settle();
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
});
it('shows the generic label, not the previous household\'s member name, when the name refetch fails', async () => {
  const f = portal(ids.first, { hold: true }), user = userEvent.setup();
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
  // The portal stays up for the new household, but the first household's member name is gone.
  f.bootstrapGates[0]!.fail();
  await waitFor(() => expect(identity()).toBe('Signed in · Member'));
  expect(document.body.textContent).not.toContain('Test User');
  expect(screen.getByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  // The next successful load names the person again.
  await user.selectOptions(screen.getByRole('combobox'), ids.first);
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(2));
  f.bootstrapGates[1]!.settle();
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
});
it('shows a generic label, never an ID, for a session the server could not name', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  const householdId = ids.first;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/demo' ? { data: { mode: 'disabled' } }
    : path === '/api/portal/households' ? { data: { current: householdId, households: [{ householdId, name: 'Only household', role: 'payer' }] } }
    : { data: { role: 'payer', householdId, memberId: null } })));
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: ids.user, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: ids.user, displayName: null, roles: [], member: true }, login: { password: true, magicLink: false } }), signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  render(<App services={services} router={createAppRouter(createMemoryHistory({ initialEntries: ['/portal'] }))} />);
  await waitFor(() => expect(screen.getByTestId('signed-in-identity').textContent).toBe('Signed in · Account holder'));
  expect(document.body.textContent).not.toContain(ids.user);
});
it('completes a claim from the login-link callback and removes its code from the address bar', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  const code = 'a'.repeat(40) + '.' + 'b'.repeat(43), assign = vi.fn(), replaceState = vi.spyOn(history, 'replaceState');
  vi.stubGlobal('location', { ...window.location, pathname: '/portal/claim', search: '?claim=' + code, hash: '', assign });
  const fetcher = vi.fn(async (path: string) => Response.json(path === '/api/demo' ? { data: { mode: 'disabled' } } : { data: null }));
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: ids.user, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: ids.user, displayName: 'Test User', roles: [], member: false }, login: { password: false, magicLink: true } }), signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  render(<App services={services} router={createAppRouter(createMemoryHistory({ initialEntries: ['/portal/claim?claim=' + code] }))} />);
  await waitFor(() => expect(assign).toHaveBeenCalledWith('/portal'));
  const call = fetcher.mock.calls.find(([path]) => path === '/api/portal/claims/complete') as unknown as [string, RequestInit];
  expect(JSON.parse(String(call[1].body))).toEqual({ claim: code });
  expect(replaceState).toHaveBeenCalledWith(null, '', '/portal/claim');
});
