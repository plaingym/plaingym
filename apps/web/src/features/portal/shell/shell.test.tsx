// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory } from '@tanstack/react-router';
import type { NavigationEntry } from '@plaingym/shared';
import { App } from '../../../app.js';
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
function portal(initial: string | null, { path = '/portal', hold = false }: { path?: string; hold?: boolean } = {}) {
  vi.stubGlobal('scrollTo', vi.fn());
  let current = initial;
  const households = [{ householdId: ids.first, name: 'Alder household', role: 'payer' }, { householdId: ids.second, name: 'Birch household', role: 'member' }];
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/demo') return Response.json({ data: { mode: 'disabled' } });
    if (path === '/api/portal/households/current') { current = (JSON.parse(String(init!.body)) as { householdId: string }).householdId; return Response.json({ data: null }); }
    if (path === '/api/portal/households') return Response.json({ data: { current, households } });
    if (path === '/api/portal/context') return current === ids.first ? Response.json({ data: { role: 'payer', householdId: ids.first, memberId: null } })
      : current === ids.second ? Response.json({ data: { role: 'member', householdId: ids.second, memberId: ids.member } }) : new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  // With `hold`, every bootstrap load after the first waits until `release()`, so a test can act while a refetch is in flight.
  let loads = 0, release = () => undefined as void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const services: ShellServices = { loadBootstrap: async () => {
    if (hold && loads++ > 0) await gate;
    return { gym: { id: ids.user, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: ids.user, displayName: current === ids.second ? 'Noa Second' : 'Test User', roles: [], member: true }, login: { password: true, magicLink: false } };
  }, signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<App services={services} router={router} />);
  const selections = () => fetcher.mock.calls.filter(([path]) => path === '/api/portal/households/current').map(([, init]) => JSON.parse(String(init!.body)));
  // What the server does on its own, such as falling back to another household when a link is revoked.
  const serverOpens = (householdId: string) => { current = householdId; };
  return { fetcher, selections, router, release, serverOpens };
}
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
