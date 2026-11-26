// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, onlineManager, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { NavigationEntry } from '@plaingym/shared';
import { App, createShellQueryClient, readsWait } from '../../../app.js';
import { bootstrapKey, ShellServicesContext } from '../../../app/context.js';
import { createAppRouter } from '../../../app/router.js';
import type { ShellServices } from '../../../app/services.js';
import { themeStorageKey } from '../../../lib/theme.js';
import { portalNavigation } from './shell.js';

// Keep shell request-order assertions independent of home summaries, covered in home.test.tsx and End-to-end.
vi.mock('./home.js', () => ({ PortalHome: () => <h1>Welcome to your member portal</h1> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
  window.history.replaceState(null, '', '/');
  localStorage.removeItem(themeStorageKey);
  document.documentElement.classList.remove('theme-system', 'light', 'dark');
});
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
    : { data: { role: 'payer', memberId: null }, householdId }));
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
  await user.click(screen.getByRole('button', { name: 'Account' }));
  expect(screen.getByRole('link', { name: 'Your account' }).getAttribute('href')).toBe('/portal/account');
  await user.click(screen.getByRole('button', { name: 'Sign out' })); await waitFor(() => expect(services.signOut).toHaveBeenCalledOnce());
});

const ids = { user: '00000000-0000-7000-8000-000000000001', first: '00000000-0000-7000-8000-000000000002', second: '00000000-0000-7000-8000-000000000003', member: '00000000-0000-7000-8000-000000000004', invoice: '00000000-0000-7000-8000-000000000005' };
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
function portal(initial: string | null, { path = '/portal', hold = false, holdHouseholds = false, holdCredits = false, holdInvoices = false, app = false }:
  { path?: string; hold?: boolean; holdHouseholds?: boolean; holdCredits?: boolean; holdInvoices?: boolean; app?: boolean } = {}) {
  vi.stubGlobal('scrollTo', vi.fn());
  let current = initial, released = false;
  const bootstrapGates: Gate[] = [], householdGates: Gate[] = [], creditGates: Gate[] = [], invoiceGates: Gate[] = [];
  const households = [{ householdId: ids.first, name: 'Alder household', role: 'payer' }, { householdId: ids.second, name: 'Birch household', role: holdInvoices ? 'payer' : 'member' }];
  let householdLoads = 0;
  // With `lagLists`, the household lists keep naming that household whatever the server has open (a lagging read).
  let lagging: string | null = null;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/demo') return Response.json({ data: { mode: 'disabled' } });
    if (path === '/api/portal/households/current') { current = (JSON.parse(String(init!.body)) as { householdId: string }).householdId; return Response.json({ data: null }); }
    if (path === '/api/portal/households') {
      const answer = Response.json({ data: { current: lagging ?? current, households } });
      if (holdHouseholds && householdLoads++ > 0 && !released) { const held = gate(); householdGates.push(held); await held.wait; }
      return answer;
    }
    // A portal page: it answers for the household the server has open when the request arrives, numbered 11 or 22 by household.
    if (path === '/api/portal/credits') {
      const balance = current === ids.first ? 11 : 22, answer = { data: [{ memberId: ids.member, firstName: 'Alex', lastName: 'Example', balance, soonestExpiry: null }], householdId: current };
      if (holdCredits && !released) { const held = gate(); creditGates.push(held); await held.wait; }
      return Response.json(answer);
    }
    if (path.startsWith('/api/portal/invoices?')) {
      const number = current === ids.first ? 11 : 22;
      const answer = { data: holdInvoices ? [{ id: ids.invoice, number, kind: 'one_off', status: 'paid', dueOn: '2026-10-20', amountCents: 1000, currency: 'USD', paidAt: '2026-10-20T12:00:00Z' }] : [], pagination: { limit: 20, offset: 0, total: holdInvoices ? 1 : 0 }, householdId: current };
      if (holdInvoices && !released) { const held = gate(); invoiceGates.push(held); await held.wait; }
      return Response.json(answer);
    }
    if (path === '/api/portal/payment-methods') return Response.json({ data: [], householdId: current });
    if (path === '/api/portal/household') return Response.json({ data: { id: current, name: 'Household', email: null, phone: null, sms: { phoneValid: false, phoneE164: null, notices: null }, address: {}, billingDay: 1, revision: 1 }, householdId: current });
    if (path.startsWith('/api/portal/members?')) return Response.json({ data: [], pagination: { limit: 100, offset: 0, total: 0 }, householdId: current });
    if (path.startsWith('/api/portal/schedule') || path === '/api/portal/act-for') return Response.json({ data: [], pagination: { limit: 100, offset: 0, total: 0 }, householdId: current });
    if (path === '/api/portal/context') return current === ids.first ? Response.json({ data: { role: 'payer', memberId: null }, householdId: ids.first })
      : current === ids.second ? Response.json({ data: { role: holdInvoices ? 'payer' : 'member', memberId: ids.member }, householdId: ids.second }) : new Response(null, { status: 404 });
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
  // The same providers `App` supplies, with the cache in hand so a test can do what garbage collection does. With `app`,
  // `App` itself renders (with a cache of its own), so its router listener runs too.
  const cache = createShellQueryClient();
  render(app ? <App services={services} router={router} />
    : <QueryClientProvider client={cache}><ShellServicesContext.Provider value={services}><RouterProvider router={router} /></ShellServicesContext.Provider></QueryClientProvider>);
  const selections = () => fetcher.mock.calls.filter(([path]) => path === '/api/portal/households/current').map(([, init]) => JSON.parse(String(init!.body)));
  // What the server does on its own, such as falling back to another household when a link is revoked.
  const serverOpens = (householdId: string | null) => { current = householdId; };
  const lagLists = (householdId: string | null) => { lagging = householdId; };
  const release = () => { released = true; for (const held of [...bootstrapGates, ...householdGates, ...creditGates, ...invoiceGates]) held.settle(); };
  return { fetcher, signOut: vi.mocked(services.signOut), selections, router, release, serverOpens, lagLists, bootstrapGates, householdGates, creditGates, invoiceGates, cache, server: () => current };
}
const identity = () => screen.getByTestId('signed-in-identity').textContent;
it.each(['dismiss', 'navigate', 'switch', 'lists'] as const)('explains a move discovered by a read and clears the notice on %s', async action => {
  const f = portal(ids.first), user = userEvent.setup();
  await screen.findByRole('combobox');
  f.serverOpens(ids.second);
  await act(async () => { await f.cache.invalidateQueries({ queryKey: action === 'lists' ? [...base, 'households'] : [...household(ids.first), 'shell', 'context'], exact: true }); });
  const notice = await screen.findByText(/Your household changed/);
  expect(notice.textContent).not.toContain('action was not completed');
  expect(notice.textContent).toContain('check any unfinished work');
  if (action === 'dismiss' || action === 'lists') await user.click(screen.getByRole('button', { name: 'Dismiss notice' }));
  if (action === 'navigate') await act(async () => { await f.router.navigate({ to: '/portal/schedule' }); });
  if (action === 'switch') {
    await user.selectOptions(screen.getByRole('combobox'), ids.first);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.first));
  }
  await waitFor(() => expect(screen.queryByText(/Your household changed/)).toBeNull());
});
it('keeps a household draft mounted when the shell context starts a recovery that fails', async () => {
  const f = portal(ids.first, { path: '/portal/household', holdHouseholds: true }), user = userEvent.setup();
  const phone = await screen.findByLabelText('Phone');
  await user.type(phone, '5550199');
  f.serverOpens(ids.second);
  act(() => { void f.cache.invalidateQueries({ queryKey: [...household(ids.first), 'shell', 'context'], exact: true }); });
  await waitFor(() => expect(f.householdGates).toHaveLength(1));
  expect(phone.isConnected).toBe(true);
  f.householdGates[0]!.fail();
  await screen.findByText(/couldn.t load your portal/);
  expect(screen.getByLabelText('Phone')).toBe(phone);
  expect((phone as HTMLInputElement).value).toBe('5550199');
});
it('keeps loading while a first context 404 reads the lists, and fails only if they stay on that household', async () => {
  const f = portal(ids.first, { holdHouseholds: true });
  f.lagLists(ids.first); f.serverOpens(null);
  await waitFor(() => expect(f.householdGates).toHaveLength(1));
  expect(screen.getByRole('status').textContent).toContain('Loading');
  expect(screen.queryByText(/couldn.t load your portal/)).toBeNull();
  await act(async () => { f.release(); });
  await screen.findByText(/couldn.t load your portal/);
});
it('keeps a page read failure loading while the shell context 404 refreshes household lists', async () => {
  const f = portal(ids.first, { path: '/portal/household', holdHouseholds: true });
  await screen.findByLabelText('Phone');
  const fetch = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation((path, init) => path === '/api/portal/context' ? Promise.resolve(new Response(null, { status: 404 }))
    : path === '/api/portal/household' ? Promise.resolve(new Response(null, { status: 500 })) : fetch(path, init));
  act(() => {
    void f.cache.invalidateQueries({ queryKey: [...household(ids.first), 'shell', 'context'], exact: true });
    void f.cache.resetQueries({ queryKey: [...household(ids.first), 'household', 'details'], exact: true });
  });
  await waitFor(() => expect(f.householdGates).toHaveLength(1));
  await waitFor(() => expect(f.cache.getQueryState([...household(ids.first), 'household', 'details'])?.status).toBe('error'));
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(within(screen.getByRole('main')).getByRole('status').textContent).toContain('Loading');
  await act(async () => { f.release(); });
  expect((await screen.findAllByRole('button', { name: 'Try again' })).length).toBeGreaterThan(0);
});
it('asks a login with several households to choose one before showing the portal', async () => {
  const f = portal(null), user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: 'Choose a household' })).toBeDefined();
  expect(f.fetcher.mock.calls.some(([path]) => path === '/api/portal/context')).toBe(false);
  expect(screen.queryByRole('heading', { name: 'Welcome to your member portal' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Account' }));
  expect(screen.queryByRole('link', { name: 'Your account' })).toBeNull();
  expect(screen.getByRole('group', { name: 'Theme' })).toBeDefined();
  await user.click(screen.getByRole('button', { name: /Birch household/ }));
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  expect(f.selections()).toEqual([{ householdId: ids.second }]);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.second);
});
it('shows System by default and remembers the theme when the portal account menu reopens', async () => {
  portal(ids.first);
  const user = userEvent.setup();
  const account = await screen.findByRole('button', { name: 'Account' });
  await user.click(account);
  const theme = within(screen.getByRole('group', { name: 'Theme' }));
  expect(theme.getByRole('radio', { name: 'System', checked: true })).toBeDefined();
  for (const [label, choice, className] of [['Light', 'light', 'light'], ['Dark', 'dark', 'dark'], ['System', 'system', 'theme-system']] as const) {
    await user.click(theme.getByRole('radio', { name: label }));
    expect(theme.getAllByRole('radio', { checked: true })).toEqual([theme.getByRole('radio', { name: label })]);
    expect(document.documentElement.className).toBe(className);
    expect(localStorage.getItem(themeStorageKey)).toBe(choice);
  }
  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  await user.click(account);
  await user.click(account);
  expect(screen.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();
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
  // The bootstrap refetch is held, yet the switch has already gone home. Until it answers, the name is not the previous one's.
  await waitFor(() => expect(f.router.state.location.pathname).toBe('/portal'));
  await waitFor(() => expect(identity()).toBe('Signed in · Member'));
  expect(document.body.textContent).not.toContain('Test User');
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
  // The server has the switch, so the portal is the new household's, not an error about a switch that happened.
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.second);
  expect(screen.queryByText(/couldn’t open that household/)).toBeNull();
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
const fetchCount = (f: ReturnType<typeof portal>, path: string) => f.fetcher.mock.calls.filter(([called]) => called === path).length;
const base = ['portal', ids.user, ids.user] as const;
/** Everything the portal caches for one household; every portal page's key starts with it. */
const household = (householdId: string) => [...base, 'household', householdId] as const;
const bodyText = () => document.body.textContent ?? '';
/** Every state the page passes through, so a test can look at the moments between the ones it waits for. */
function watchPage() {
  const seen: string[] = [];
  const watch = new MutationObserver(() => seen.push(bodyText()));
  watch.observe(document.body, { subtree: true, childList: true, characterData: true });
  return { seen, stop: () => watch.disconnect() };
}
it('discards only the previous household\'s entries on a switch, and refetches nothing under its key', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  // Root queries and the shell's own entries are not the portal's.
  // (The fixture's discovery answer doesn't satisfy the real schema, so the test gives the query a settled answer of its own.)
  f.cache.setQueryData(['demo', 'discovery', window.location.origin], { data: { mode: 'disabled' } });
  const discovery = f.cache.getQueryCache().findAll({ queryKey: ['demo', 'discovery'] })[0];
  expect(discovery?.state.status).toBe('success');
  const discoveryLoaded = discovery!.state.dataUpdatedAt, discoveryCalls = fetchCount(f, '/api/demo'), contextCalls = fetchCount(f, '/api/portal/context');
  const oldContext = [...household(ids.first), 'shell', 'context'];
  expect(f.cache.getQueryData(oldContext)).toBeDefined();
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  expect(f.cache.getQueryCache().findAll({ queryKey: ['demo', 'discovery'] })).toEqual([discovery]);
  expect(discovery!.state.status).toBe('success'); expect(discovery!.state.dataUpdatedAt).toBe(discoveryLoaded);
  expect(fetchCount(f, '/api/demo')).toBe(discoveryCalls);
  // Nothing is left under the previous household's prefix, and the only context asked for since is the new household's.
  expect(f.cache.getQueryCache().findAll({ queryKey: household(ids.first) })).toEqual([]);
  expect(f.cache.getQueryData([...household(ids.second), 'shell', 'context'])).toEqual({ role: 'member', memberId: ids.member });
  expect(fetchCount(f, '/api/portal/context')).toBe(contextCalls + 1);
  // The household lists are not the previous household's: they stay, and now name the new one.
  expect(f.cache.getQueryData([...base, 'households'])).toMatchObject({ current: ids.second });
  expect(f.cache.getQueryData(['shell', 'portal-household', ids.user])).toBe(ids.second);
});
// H: the household lists answer, which is when the change is noticed. A: a page load that started for the previous household
// answers. B: the bootstrap refetch answers. P: the page load for the new household answers. Only H comes first among H, B and P.
it.each(['AHBP', 'AHPB', 'HABP', 'HAPB', 'HBAP', 'HBPA', 'HPAB', 'HPBA'])('shows nothing of the previous household once the server opened another on its own, whatever the answering order (%s)', async order => {
  // The billing page is a real portal page: its key comes from `usePortalScope`, and it answers for the household open when asked.
  const f = portal(ids.first, { path: '/portal/billing', hold: true, holdHouseholds: true, holdCredits: true });
  await waitFor(() => expect(f.creditGates).toHaveLength(1)); f.creditGates[0]!.settle();
  await waitFor(() => expect(bodyText()).toContain('11 classes left'));
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  const page = watchPage();
  try {
    // A load for the previous household is in flight when the server opens the other one and the lists are read again.
    void f.cache.refetchQueries({ queryKey: [...household(ids.first), 'billing', 'credits'] }); await waitFor(() => expect(f.creditGates).toHaveLength(2));
    f.serverOpens(ids.second);
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await waitFor(() => expect(f.householdGates.length).toBeGreaterThan(0));
    let noticed = -1;
    for (const event of order) {
      if (event === 'A') f.creditGates[1]!.settle();
      if (event === 'H') {
        // Every state from the moment the lists answer counts, including the renders before anything has been asked for.
        noticed = page.seen.length;
        for (const held of f.householdGates) held.settle();
        // The page asks again under the new household's key, and the name is asked for.
        await waitFor(() => expect(f.creditGates).toHaveLength(3)); await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
      }
      if (event === 'B') f.bootstrapGates[0]!.settle();
      if (event === 'P') f.creditGates[2]!.settle();
      await act(async () => { await Promise.resolve(); });
      if (noticed >= 0) expect(bodyText()).not.toContain('11 classes left');
    }
    await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
    await waitFor(() => expect(bodyText()).toContain('22 classes left'));
    // Nothing of the previous household was shown after the change: not by the page, and not as its name beside the new scope.
    const after = page.seen.slice(noticed);
    expect(after.some(text => text.includes('11 classes left'))).toBe(false);
    expect(after.some(text => text.includes('Test User · Member'))).toBe(false);
    expect(f.cache.getQueryCache().findAll({ queryKey: household(ids.first) })).toEqual([]);
  } finally { page.stop(); }
});
it.each(['AHBP', 'AHPB', 'HABP', 'HAPB', 'HBAP', 'HBPA', 'HPAB', 'HPBA'])('shows nothing of the previous household once the server opened another on its own, for payer invoices, whatever the answering order (%s)', async order => {
  // The billing page is a real portal page: its key comes from `usePortalScope`, and it answers for the household open when asked.
  const f = portal(ids.first, { path: '/portal/billing', hold: true, holdHouseholds: true, holdInvoices: true });
  await waitFor(() => expect(f.invoiceGates).toHaveLength(1)); f.invoiceGates[0]!.settle();
  await waitFor(() => expect(bodyText()).toContain('Invoice #11'));
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  const page = watchPage();
  try {
    // A load for the previous household is in flight when the server opens the other one and the lists are read again.
    void f.cache.refetchQueries({ queryKey: [...household(ids.first), 'billing', 'invoices'] }); await waitFor(() => expect(f.invoiceGates).toHaveLength(2));
    f.serverOpens(ids.second);
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await waitFor(() => expect(f.householdGates.length).toBeGreaterThan(0));
    let noticed = -1;
    for (const event of order) {
      if (event === 'A') f.invoiceGates[1]!.settle();
      if (event === 'H') {
        // Every state from the moment the lists answer counts, including the renders before anything has been asked for.
        noticed = page.seen.length;
        for (const held of f.householdGates) held.settle();
        // The page asks again under the new household's key, and the name is asked for.
        await waitFor(() => expect(f.invoiceGates).toHaveLength(3)); await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
      }
      if (event === 'B') f.bootstrapGates[0]!.settle();
      if (event === 'P') f.invoiceGates[2]!.settle();
      await act(async () => { await Promise.resolve(); });
      if (noticed >= 0) expect(bodyText()).not.toContain('Invoice #11');
    }
    await waitFor(() => expect(identity()).toBe('Noa Second · Account holder'));
    await waitFor(() => expect(bodyText()).toContain('Invoice #22'));
    // Nothing of the previous household was shown after the change: not by the page, and not as its name beside the new scope.
    const after = page.seen.slice(noticed);
    expect(after.some(text => text.includes('Invoice #11'))).toBe(false);
    expect(f.cache.getQueryCache().findAll({ queryKey: household(ids.first) })).toEqual([]);
  } finally { page.stop(); }
});
it('shows the switched portal, not an error, when the list read after the stored switch is refused', async () => {
  const f = portal(ids.first, { path: '/portal/schedule', hold: true, holdHouseholds: true }), user = userEvent.setup();
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  // The server has the switch and the lists are being read again; this read is refused.
  await waitFor(() => expect(f.householdGates).toHaveLength(1));
  expect(f.selections()).toEqual([{ householdId: ids.second }]);
  f.householdGates[0]!.fail();
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.second));
  expect(screen.queryByText(/couldn’t open that household/)).toBeNull();
  // The previous household's entries are gone even though the read failed: the keys follow the stored switch, not the read.
  expect(f.cache.getQueryCache().findAll({ queryKey: household(ids.first) })).toEqual([]);
  expect(f.cache.getQueryData([...base, 'households'])).toMatchObject({ current: ids.second });
  await waitFor(() => expect(f.router.state.location.pathname).toBe('/portal'));
  // The name is asked for again, and the new household's scope shows meanwhile.
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(1));
  expect(identity()).toBe('Signed in · Member');
  f.bootstrapGates[0]!.settle();
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
});
it('offers a retry, not a spinner, when the server opened another household but the lists still name the previous one', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  // The switch is stored, but every read of the lists still names the first household.
  f.lagLists(ids.first);
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  const message = await screen.findByText(/couldn.t load your portal/);
  // The view's only status is the one for signing out, empty here.
  expect(document.querySelector('[data-loading]')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('');
  f.lagLists(null);
  await user.click(within(message.parentElement!.parentElement!).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  await waitFor(() => expect(f.cache.getQueryCache().findAll({ queryKey: household(ids.first) }).map(q => q.queryKey.slice(4))).toEqual([]));
});
it('never stores the new household\'s context under the old household\'s key when the server moved before the lists did', async () => {
  const f = portal(ids.first, { hold: true, holdHouseholds: true });
  await screen.findByRole('combobox');
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  const contextCalls = fetchCount(f, '/api/portal/context'), oldContext = [...household(ids.first), 'shell', 'context'];
  f.serverOpens(ids.second);
  act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
  // The context answers first, for the household the server has open now, and the lists have not said so yet.
  await waitFor(() => expect(f.householdGates.length).toBeGreaterThan(0));
  await waitFor(() => expect(f.cache.getQueryState(oldContext)?.error).toBeInstanceOf(Error));
  expect(f.cache.getQueryData(oldContext)).toEqual({ role: 'payer', memberId: null });
  expect(document.body.textContent).not.toContain('Test User · Member');
  for (const held of f.householdGates) held.settle();
  await waitFor(() => expect(f.bootstrapGates).toHaveLength(1)); f.bootstrapGates[0]!.settle();
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  expect(f.cache.getQueryCache().findAll({ queryKey: household(ids.first) })).toEqual([]);
  // One refused answer under the old key, and one load for the new household.
  expect(fetchCount(f, '/api/portal/context')).toBe(contextCalls + 2);
});
it('shows a generic label, never an ID, for a session the server could not name', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  const householdId = ids.first;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/demo' ? { data: { mode: 'disabled' } }
    : path === '/api/portal/households' ? { data: { current: householdId, households: [{ householdId, name: 'Only household', role: 'payer' }] } }
    : { data: { role: 'payer', householdId, memberId: null }, householdId })));
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: ids.user, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: ids.user, displayName: null, roles: [], member: true }, login: { password: true, magicLink: false } }), signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  render(<App services={services} router={createAppRouter(createMemoryHistory({ initialEntries: ['/portal'] }))} />);
  await waitFor(() => expect(screen.getByTestId('signed-in-identity').textContent).toBe('Signed in · Account holder'));
  expect(document.body.textContent).not.toContain(ids.user);
});
const offlineBanner = 'You are offline. Connect to the internet to use the member portal.';
/** The loading state's own text; the offline banner is a status too, so the role doesn't tell them apart. */
const loading = () => document.querySelector('[data-loading]')?.textContent;
/** The browser's own answer; the returned function changes it, with the event a browser sends unless told to stay quiet. */
function browserConnection() {
  let online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  return (next: boolean, { event = true }: { event?: boolean } = {}) => {
    online = next;
    if (event) act(() => { window.dispatchEvent(new Event(next ? 'online' : 'offline')); });
  };
}
it('holds a section\'s reads while offline, under the banner, and runs them once the browser is online', async () => {
  const connect = browserConnection(), f = portal(ids.first);
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => {
    if (!navigator.onLine) throw new TypeError('Failed to fetch');
    return answer(path, init);
  });
  connect(false);
  const before = f.fetcher.mock.calls.length;
  await act(async () => { await f.router.navigate({ to: '/portal/billing' }); });
  expect(await screen.findByRole('heading', { name: 'Billing' })).toBeDefined();
  expect(screen.getByText('You are offline. Connect to the internet to use the member portal.')).toBeDefined();
  expect(f.fetcher.mock.calls.slice(before).map(([path]) => path).filter(path => path.startsWith('/api/portal/'))).toEqual([]);
  expect(bodyText()).not.toContain('Something went wrong');
  expect(screen.queryByRole('alert')).toBeNull();
  connect(true);
  await waitFor(() => expect(bodyText()).toContain('11 classes left'));
  expect(fetchCount(f, '/api/portal/credits')).toBe(1);
  expect(screen.queryByText(/You are offline/)).toBeNull();
});
it.each([false, true])('checks the browser again on navigation when no event announced the change (online: %s)', async next => {
  const connect = browserConnection(), f = portal(ids.first);
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  if (next) connect(false);
  connect(next, { event: false });
  expect(onlineManager.isOnline()).toBe(!next);
  const before = f.fetcher.mock.calls.length;
  await act(async () => { await f.router.navigate({ to: '/portal/billing' }); });
  await waitFor(() => expect(onlineManager.isOnline()).toBe(next));
  if (next) await waitFor(() => expect(bodyText()).toContain('11 classes left'));
  else expect(f.fetcher.mock.calls.slice(before).map(([path]) => path).filter(path => path.startsWith('/api/portal/'))).toEqual([]);
  expect(!!screen.queryByText(/You are offline/)).toBe(!next);
});
it.each([['/portal', false], ['/admin', true], ['/portal/claim', true]])('starts offline when the browser already was before anything listened, in the portal only (%s)', async (path, online) => {
  const connect = browserConnection();
  window.history.replaceState(null, '', path);
  connect(false, { event: false });
  // The listener is set up again when the next client subscribes, and reads the browser's answer then.
  const client = createShellQueryClient();
  client.mount();
  try { expect(onlineManager.isOnline()).toBe(online); } finally { client.unmount(); }
});
it('holds reads only for paths in the portal, and only while offline', () => {
  const connect = browserConnection(), inside = ['/portal', '/portal/', '/portal/billing', '/portal?tab=1', '/portal#top', '/portal/claims'];
  for (const path of inside) expect(readsWait(path), path).toBe(false);
  connect(false);
  for (const path of inside) expect(readsWait(path), path).toBe(true);
  for (const path of ['/', '/portals', '/admin', '/admin/portal', '/login', '/setup', '/kiosk', '/portal/claim', '/portal/claim/', '/portal/claim?claim=code', '/portal/claim#token'])
    expect(readsWait(path), path).toBe(false);
});
it('answers again on each navigation between the portal and other pages while offline', async () => {
  vi.stubGlobal('scrollTo', vi.fn()); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { mode: 'disabled' } })));
  const connect = browserConnection();
  window.history.replaceState(null, '', '/portal');
  connect(false);
  // A bootstrap that never answers keeps each page from redirecting away on what it would learn.
  const services: ShellServices = { loadBootstrap: () => new Promise(() => undefined), signOut: vi.fn(), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/portal'] }));
  render(<App services={services} router={router} />);
  await waitFor(() => expect(loading()).toContain('Loading'));
  expect(onlineManager.isOnline()).toBe(false);
  await act(() => router.navigate({ to: '/admin' }));
  expect(onlineManager.isOnline()).toBe(true);
  await act(() => router.navigate({ to: '/portal' }));
  expect(onlineManager.isOnline()).toBe(false);
});
it('lets other pages read after leaving an open portal while offline', async () => {
  const connect = browserConnection();
  window.history.replaceState(null, '', '/portal');
  const f = portal(ids.first, { app: true });
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  connect(false);
  expect(onlineManager.isOnline()).toBe(false);
  await act(() => f.router.navigate({ to: '/kiosk' }));
  expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  expect(onlineManager.isOnline()).toBe(true);
});
it('fails a household switch made while offline at once, under the header and banner, and never sends it later', async () => {
  const connect = browserConnection(), f = portal(ids.first), user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => {
    if (!navigator.onLine) throw new TypeError('Failed to fetch');
    return answer(path, init);
  });
  connect(false);
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  expect(await screen.findByText(/couldn’t open that household/)).toBeDefined();
  expect(f.selections()).toEqual([{ householdId: ids.second }]);
  expect(screen.getByRole('banner').textContent).toContain('Test Gym');
  expect(screen.getByText(offlineBanner)).toBeDefined();
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ids.first);
  connect(true);
  await waitFor(() => expect(screen.queryByText(offlineBanner)).toBeNull());
  await act(() => f.cache.resumePausedMutations());
  expect(f.selections()).toHaveLength(1);
  expect(f.server()).toBe(ids.first);
});
const signOutFailed = "We couldn't sign you out. Check your connection and try again.";
it.each(['picker', 'failed load', 'open portal'] as const)('says a sign-out made while offline failed, on the %s view, and never sends it later', async view => {
  const connect = browserConnection(), f = portal(view === 'picker' ? null : ids.first);
  const answer = f.fetcher.getMockImplementation()!;
  if (view === 'failed load') f.fetcher.mockImplementation(async (path, init) => path === '/api/portal/households' ? new Response(null, { status: 500 }) : answer(path, init));
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  const user = userEvent.setup();
  if (view === 'picker') await screen.findByRole('heading', { name: 'Choose a household' });
  else if (view === 'failed load') await screen.findByText(/couldn.t load your portal/);
  else await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  expect(screen.queryByText(signOutFailed)).toBeNull();
  connect(false);
  if (view !== 'failed load') await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByText(signOutFailed)).toBeDefined();
  expect(assign).not.toHaveBeenCalled();
  connect(true);
  await act(() => f.cache.resumePausedMutations());
  expect(f.signOut).toHaveBeenCalledOnce();
});
it('says a sign-out failed after a household switch failed too, and brings it into view', async () => {
  const connect = browserConnection(), f = portal(ids.first), user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => {
    if (!navigator.onLine) throw new TypeError('Failed to fetch');
    return answer(path, init);
  });
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  connect(false);
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  expect(await screen.findByText(/couldn’t open that household/)).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  const failure = (await screen.findByText(signOutFailed)).closest('[role="alert"]');
  expect(document.activeElement).toBe(failure);
  expect(screen.getByText(/couldn’t open that household/)).toBeDefined();
});
it('closes the account menu for a failed sign-out, and a household choice clears its error', async () => {
  const f = portal(null), user = userEvent.setup();
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  await screen.findByRole('heading', { name: 'Choose a household' });
  const account = screen.getByRole('button', { name: 'Account' });
  await user.click(account);
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  const failure = (await screen.findByText(signOutFailed)).closest('[role="alert"]');
  expect(account.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(failure);
  await user.click(screen.getByRole('button', { name: /Alder household/ }));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  expect(screen.queryByText(signOutFailed)).toBeNull();
});
it('says it is signing out once the account menu has closed', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const account = screen.getByRole('button', { name: 'Account' });
  expect(screen.queryByText('Signing out…')).toBeNull();
  await user.click(account);
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect((await screen.findByText('Signing out…')).getAttribute('role')).toBe('status');
  expect(account.getAttribute('aria-expanded')).toBe('false');
  expect(f.signOut).toHaveBeenCalledOnce();
});
it('clears a failed sign-out when the household switcher chooses another household', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText(signOutFailed);
  await user.selectOptions(screen.getByRole('combobox'), ids.second);
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  expect(screen.queryByText(signOutFailed)).toBeNull();
});
it('holds the household picker while a sign-out is being sent, and frees it once the sign-out fails', async () => {
  const f = portal(null), user = userEvent.setup();
  let fail!: (cause: unknown) => void;
  f.signOut.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await screen.findByRole('heading', { name: 'Choose a household' });
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText('Signing out…');
  const choices = () => screen.getAllByRole<HTMLButtonElement>('button', { name: /household/ });
  expect(choices()).toHaveLength(2);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Alder household/ }).disabled).toBe(true);
  expect(choices().every(button => button.disabled)).toBe(true);
  await act(async () => fail(new TypeError('Failed to fetch')));
  expect(await screen.findByText(signOutFailed)).toBeDefined();
  expect(choices().every(button => !button.disabled)).toBe(true);
  await user.click(screen.getByRole('button', { name: /Alder household/ }));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  expect(screen.queryByText(signOutFailed)).toBeNull();
});
it('holds the household switcher while a sign-out is being sent', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect((await screen.findByText('Signing out…')).getAttribute('role')).toBe('status');
  expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true);
  expect(screen.getByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
});
it('still reports a sign-out that fails after a retry made while it was being sent', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  let fail!: (cause: unknown) => void;
  f.signOut.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => path === '/api/portal/context' ? new Response(null, { status: 500 }) : answer(path, init));
  await act(() => f.cache.refetchQueries({ queryKey: [...household(ids.first), 'shell', 'context'] }));
  const retry = await screen.findByRole('button', { name: 'Try again' });
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText('Signing out…');
  f.fetcher.mockImplementation(answer);
  await user.click(retry);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
  expect(screen.getByText('Signing out…')).toBeDefined();
  await act(async () => fail(new TypeError('Failed to fetch')));
  expect(await screen.findByText(signOutFailed)).toBeDefined();
});
it('clears a failed sign-out on a retry of the failed-load view', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  const answer = f.fetcher.getMockImplementation()!;
  let failing = true;
  f.fetcher.mockImplementation(async (path, init) => failing && path === '/api/portal/households' ? new Response(null, { status: 500 }) : answer(path, init));
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  await screen.findByText(/couldn.t load your portal/);
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText(signOutFailed);
  failing = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  expect(screen.queryByText(signOutFailed)).toBeNull();
});
it('keeps the signing-out status mounted while a household the server opened loads', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const account = screen.getByRole('button', { name: 'Account' });
  await user.click(account);
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  const status = await screen.findByText('Signing out…');
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => path === '/api/portal/context' ? new Promise<Response>(() => undefined) : answer(path, init));
  f.serverOpens(ids.second);
  act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
  await waitFor(() => {
    expect(document.querySelector('main [data-loading]')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Welcome to your member portal' })).toBeNull();
  });
  expect(status.isConnected).toBe(true);
  expect(screen.getByText('Signing out…')).toBe(status);
  expect(screen.getByRole('button', { name: 'Account' })).toBe(account);
});
it('says it is signing out on the failed-load view, and holds the retry until the sign-out fails', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  const answer = f.fetcher.getMockImplementation()!;
  let failing = true;
  f.fetcher.mockImplementation(async (path, init) => failing && path === '/api/portal/households' ? new Response(null, { status: 500 }) : answer(path, init));
  let fail!: (cause: unknown) => void;
  f.signOut.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await screen.findByText(/couldn.t load your portal/);
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('');
  const retry = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Try again' });
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(status.textContent).toBe('Signing out…'));
  expect(retry().disabled).toBe(true);
  await act(async () => fail(new TypeError('Failed to fetch')));
  expect(await screen.findByText(signOutFailed)).toBeDefined();
  expect(status.textContent).toBe('');
  // Empty again, it leaves no gap between the button and the failure.
  expect(status.className).toBe('sr-only');
  expect(retry().disabled).toBe(false);
  failing = false;
  await user.click(retry());
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  expect(screen.queryByText(signOutFailed)).toBeNull();
});
/** Long enough for a read that a focus or reconnect starts to be sent, and for the view to render it. */
const settled = () => act(() => new Promise<void>(resolve => { setTimeout(resolve, 10); }));
const focusAgain = async () => { act(() => { focusManager.setFocused(false); focusManager.setFocused(true); }); await settled(); };
const reconnect = async () => { act(() => { onlineManager.setOnline(false); onlineManager.setOnline(true); }); await settled(); };
const loadingInside = () => document.querySelector('main [data-loading]');
it('says a sign-out failed above the loading state while a household the server opened is still loading', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  let fail!: (cause: unknown) => void;
  f.signOut.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const account = screen.getByRole('button', { name: 'Account' });
  await user.click(account);
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText('Signing out…');
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => path === '/api/portal/context' ? new Promise<Response>(() => undefined) : answer(path, init));
  f.serverOpens(ids.second);
  await focusAgain();
  await waitFor(() => {
    expect(loadingInside()).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Welcome to your member portal' })).toBeNull();
  });
  await act(async () => fail(new TypeError('Failed to fetch')));
  const failure = await screen.findByText(signOutFailed);
  expect(failure.compareDocumentPosition(loadingInside()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.getByRole('button', { name: 'Account' })).toBe(account);
});
it('leaves a failed household list unread on a focus or reconnect while a sign-out is being sent', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  const answer = f.fetcher.getMockImplementation()!;
  let unanswered = false;
  f.fetcher.mockImplementation(async (path, init) => path !== '/api/portal/households' ? answer(path, init)
    : unanswered ? new Promise<Response>(() => undefined) : new Response(null, { status: 500 }));
  let fail!: (cause: unknown) => void;
  f.signOut.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await screen.findByText(/couldn.t load your portal/);
  const status = screen.getByRole('status');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(status.textContent).toBe('Signing out…'));
  const reads = fetchCount(f, '/api/portal/households');
  await focusAgain();
  expect(fetchCount(f, '/api/portal/households')).toBe(reads);
  await reconnect();
  expect(fetchCount(f, '/api/portal/households')).toBe(reads);
  expect(screen.getByText('Signing out…')).toBe(status);
  await act(async () => fail(new TypeError('Failed to fetch')));
  await screen.findByText(signOutFailed);
  unanswered = true;
  await focusAgain();
  expect(fetchCount(f, '/api/portal/households')).toBe(reads + 1);
  await waitFor(() => expect(loadingInside()).not.toBeNull());
  expect(screen.getByText(signOutFailed)).toBeDefined();
  // The lists name no household yet, so there is no account page to link to.
  await user.click(screen.getByRole('button', { name: 'Account' }));
  expect(screen.queryByRole('link', { name: 'Your account' })).toBeNull();
});
it('keeps the failed-load view and its status while the lists are read again during a sign-out', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  const answer = f.fetcher.getMockImplementation()!;
  const held = gate();
  let holding = false;
  f.fetcher.mockImplementation(async (path, init) => {
    if (path === '/api/portal/context') return new Response(null, { status: 500 });
    if (path === '/api/portal/households' && holding) await held.wait;
    return answer(path, init);
  });
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByText(/couldn.t load your portal/);
  const status = screen.getByRole('status');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(status.textContent).toBe('Signing out…'));
  const lists = fetchCount(f, '/api/portal/households'), contexts = fetchCount(f, '/api/portal/context');
  holding = true;
  await focusAgain();
  expect(fetchCount(f, '/api/portal/households')).toBe(lists + 1);
  expect(screen.getByText('Signing out…')).toBe(status);
  await act(async () => held.settle());
  await settled();
  expect(screen.getByText('Signing out…')).toBe(status);
  await reconnect();
  expect(screen.getByText('Signing out…')).toBe(status);
  expect(fetchCount(f, '/api/portal/context')).toBe(contexts);
});
it('shows no menu on the household picker, which has no section to list', async () => {
  const f = portal(null), user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Choose a household' });
  expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Member navigation' })).toBeNull();
  await user.click(screen.getByRole('button', { name: /Birch household/ }));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  expect(f.selections()).toEqual([{ householdId: ids.second }]);
  expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('navigation', { name: 'Member navigation' })).toBeDefined();
});
it('closes an open phone menu when a household the server opened has nothing to list yet', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText('Signing out…');
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  const main = screen.getByRole('main');
  expect(main.hasAttribute('inert')).toBe(true);
  expect(document.body.style.overflow).toBe('clip');
  const answer = f.fetcher.getMockImplementation()!, held = gate();
  f.fetcher.mockImplementation(async (path, init) => { if (path === '/api/portal/context') await held.wait; return answer(path, init); });
  f.serverOpens(ids.second);
  await focusAgain();
  await waitFor(() => expect(loadingInside()).not.toBeNull());
  expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Member navigation' })).toBeNull();
  expect(main.hasAttribute('inert')).toBe(false);
  expect(document.body.style.overflow).not.toBe('clip');
  // The menu was closed, not only taken away: it comes back closed with the new household's sections.
  await act(async () => held.settle());
  expect((await screen.findByRole('button', { name: 'Menu' })).getAttribute('aria-expanded')).toBe('false');
  expect(main.hasAttribute('inert')).toBe(false);
});
it.each(['names another household', 'is not found'] as const)('keeps the loading layout and its signing-out status when the server moves again and the context read %s', async second => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  const status = await screen.findByText('Signing out…');
  const answer = f.fetcher.getMockImplementation()!, context = gate(), lists = gate();
  let holdContext = true, holdLists = false;
  f.fetcher.mockImplementation(async (path, init) => {
    if (path === '/api/portal/context' && holdContext) { await context.wait; return second === 'is not found' ? new Response(null, { status: 404 }) : answer(path, init); }
    if (path === '/api/portal/households' && holdLists) await lists.wait;
    return answer(path, init);
  });
  f.serverOpens(ids.second);
  await focusAgain();
  await waitFor(() => expect(loadingInside()).not.toBeNull());
  // The server moves again before the new household's context is read, and the lists are slow to say so.
  holdContext = false; holdLists = true;
  f.serverOpens(ids.first);
  const reads = fetchCount(f, '/api/portal/households');
  await act(async () => context.settle());
  await settled();
  expect(fetchCount(f, '/api/portal/households')).toBeGreaterThan(reads);
  expect(screen.queryByText(/couldn.t load your portal/)).toBeNull();
  expect(loadingInside()).not.toBeNull();
  expect(screen.getByText('Signing out…')).toBe(status);
  await act(async () => lists.settle());
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  expect(screen.getByText('Signing out…')).toBe(status);
});
/** Holds every context read until the returned gate settles, then has the server open the other household on its own. */
async function moveWithContextHeld(f: ReturnType<typeof portal>) {
  const answer = f.fetcher.getMockImplementation()!, held = gate();
  f.fetcher.mockImplementation(async (path, init) => { if (path === '/api/portal/context') await held.wait; return answer(path, init); });
  f.serverOpens(ids.second);
  await focusAgain();
  return held;
}
const accountButton = () => screen.getByRole('button', { name: 'Account' });
const sidebarLink = () => within(screen.getByRole('navigation', { name: 'Member navigation' })).getByRole('link', { name: 'Home' });
it.each(['a sidebar link', 'the closed Menu button'] as const)('moves the focus from %s to Account when a household the server opened loads during a sign-out', async from => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  await user.click(accountButton());
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText('Signing out…');
  const control = from === 'a sidebar link' ? sidebarLink() : screen.getByRole('button', { name: 'Menu' });
  act(() => control.focus());
  expect(document.activeElement).toBe(control);
  await moveWithContextHeld(f);
  await waitFor(() => expect(loadingInside()).not.toBeNull());
  expect(control.isConnected).toBe(false);
  expect(document.activeElement).toBe(accountButton());
});
it('moves the focus from the switcher to Account when a household the server opened loads after a failed sign-out', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  await user.click(accountButton());
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText(signOutFailed);
  const switcher = screen.getByRole('combobox');
  act(() => switcher.focus());
  expect(document.activeElement).toBe(switcher);
  await moveWithContextHeld(f);
  await waitFor(() => expect(loadingInside()).not.toBeNull());
  expect(switcher.isConnected).toBe(false);
  expect(document.activeElement).toBe(accountButton());
});
it('moves the focus to Account once a view with the header shows again after a household the server opened', async () => {
  const f = portal(ids.first);
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const switcher = screen.getByRole('combobox');
  act(() => switcher.focus());
  const held = await moveWithContextHeld(f);
  await waitFor(() => expect(screen.queryByRole('banner')).toBeNull());
  expect(loading()).toContain('Loading');
  expect(document.activeElement).toBe(document.body);
  await act(async () => held.settle());
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  expect(document.activeElement).toBe(accountButton());
});
it('moves the focus to Account once a household chosen with the switcher shows', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const switcher = screen.getByRole('combobox');
  await user.selectOptions(switcher, ids.second);
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  expect(f.selections()).toEqual([{ householdId: ids.second }]);
  expect(switcher.isConnected).toBe(false);
  expect(document.activeElement).toBe(accountButton());
});
it.each(['', ', although a header control had it before'] as const)('leaves Account alone when a move removes a focused page control%s', async before => {
  const f = portal(ids.first);
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  if (before) act(() => screen.getByRole('combobox').focus());
  // The stand-in home page has no control of its own.
  const control = screen.getByRole('main').appendChild(document.createElement('button'));
  act(() => control.focus());
  expect(document.activeElement).toBe(control);
  const held = await moveWithContextHeld(f);
  await waitFor(() => expect(screen.queryByRole('banner')).toBeNull());
  expect(control.isConnected).toBe(false);
  await act(async () => held.settle());
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  expect(document.activeElement).toBe(document.body);
});
it.each([
  ['page text', 'the switcher'], ['page text', 'a theme choice the closing menu removes'],
  ['the gym name in the header', 'the switcher'], ['the gym name in the header', 'a theme choice the closing menu removes'],
] as const)('leaves Account alone after a press on %s took the focus from %s', async (on, from) => {
  const f = portal(ids.first), user = userEvent.setup();
  const heading = await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  if (from === 'the switcher') act(() => screen.getByRole('combobox').focus());
  else {
    await user.click(accountButton());
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Light' }));
  }
  await user.click(on === 'page text' ? heading : within(screen.getByRole('banner')).getByText('Test Gym'));
  expect(screen.queryByRole('radio')).toBeNull();
  expect(document.activeElement).toBe(document.body);
  const held = await moveWithContextHeld(f);
  await waitFor(() => expect(screen.queryByRole('banner')).toBeNull());
  await act(async () => held.settle());
  await waitFor(() => expect(identity()).toBe('Noa Second · Member'));
  expect(document.activeElement).toBe(document.body);
});
it('moves no focus on the first load', async () => {
  portal(ids.first);
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  await waitFor(() => expect(identity()).toBe('Test User · Account holder'));
  expect(document.activeElement).toBe(document.body);
});
it('keeps a failed-load view already shown while the lists are read again during a sign-out, when the context is not found', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  const answer = f.fetcher.getMockImplementation()!, held = gate();
  let holding = false;
  f.fetcher.mockImplementation(async (path, init) => {
    if (path === '/api/portal/context') return new Response(null, { status: 404 });
    if (path === '/api/portal/households' && holding) await held.wait;
    return answer(path, init);
  });
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByText(/couldn.t load your portal/);
  const status = screen.getByRole('status');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(status.textContent).toBe('Signing out…'));
  const lists = fetchCount(f, '/api/portal/households');
  holding = true;
  await focusAgain();
  expect(fetchCount(f, '/api/portal/households')).toBe(lists + 1);
  expect(screen.getByText(/couldn.t load your portal/)).toBeDefined();
  expect(screen.getByText('Signing out…')).toBe(status);
  await act(async () => held.settle());
  await settled();
  expect(screen.getByText('Signing out…')).toBe(status);
});
it('keeps a sign-out failure the same alert, and the focus where it is, while a household the server opened loads', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const account = screen.getByRole('button', { name: 'Account' });
  await user.click(account);
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  const failure = (await screen.findByText(signOutFailed)).closest('[role="alert"]');
  act(() => account.focus());
  const answer = f.fetcher.getMockImplementation()!, held = gate();
  f.fetcher.mockImplementation(async (path, init) => { if (path === '/api/portal/context') await held.wait; return answer(path, init); });
  f.serverOpens(ids.second);
  await focusAgain();
  await waitFor(() => expect(loadingInside()).not.toBeNull());
  expect(screen.getByText(signOutFailed).closest('[role="alert"]')).toBe(failure);
  expect(document.activeElement).toBe(account);
  await act(async () => held.settle());
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  expect(screen.getByText(signOutFailed).closest('[role="alert"]')).toBe(failure);
  expect(document.activeElement).toBe(account);
});
it.each(['a link', 'the Menu button'] as const)('moves the focus from %s to Account when the phone menu closes with nothing to list', async from => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockImplementation(() => new Promise(() => undefined));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const account = screen.getByRole('button', { name: 'Account' });
  await user.click(account);
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText('Signing out…');
  const menu = screen.getByRole('button', { name: 'Menu' });
  await user.click(menu);
  const nav = screen.getByRole('navigation', { name: 'Member navigation' });
  if (from === 'the Menu button') act(() => menu.focus());
  expect(from === 'a link' ? nav.contains(document.activeElement) : document.activeElement === menu).toBe(true);
  const answer = f.fetcher.getMockImplementation()!, held = gate();
  f.fetcher.mockImplementation(async (path, init) => { if (path === '/api/portal/context') await held.wait; return answer(path, init); });
  f.serverOpens(ids.second);
  await focusAgain();
  await waitFor(() => expect(loadingInside()).not.toBeNull());
  expect(screen.queryByRole('navigation', { name: 'Member navigation' })).toBeNull();
  expect(document.activeElement).toBe(account);
});
it.each(['never answers', 'fails'] as const)('pads the first load, which has no portal layout around it, when the bootstrap %s', async load => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { mode: 'disabled' } })));
  const loadBootstrap = () => load === 'fails' ? Promise.reject(new Error('refused')) : new Promise<never>(() => undefined);
  const services: ShellServices = { loadBootstrap, signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  render(<App services={services} router={createAppRouter(createMemoryHistory({ initialEntries: ['/portal'] }))} />);
  const state = await waitFor(() => {
    const element = document.querySelector(load === 'fails' ? '[role="alert"]' : '[data-loading]');
    expect(element).not.toBeNull();
    return element!;
  });
  expect([...state.parentElement!.classList]).toEqual(expect.arrayContaining(['px-4', 'py-6', 'sm:px-6']));
});
it('pads the failed-load view, which has no portal layout around it', async () => {
  const f = portal(ids.first);
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => path === '/api/portal/households' ? new Response(null, { status: 500 }) : answer(path, init));
  await screen.findByText(/couldn.t load your portal/);
  expect([...screen.getByRole('status').parentElement!.classList]).toEqual(expect.arrayContaining(['px-4', 'py-6', 'sm:px-6']));
});
it('clears a failed sign-out on a retry of an error inside the portal', async () => {
  const f = portal(ids.first), user = userEvent.setup();
  f.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => path === '/api/portal/context' ? new Response(null, { status: 500 }) : answer(path, init));
  await act(() => f.cache.refetchQueries({ queryKey: [...household(ids.first), 'shell', 'context'] }));
  const retry = await screen.findByRole('button', { name: 'Try again' });
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText(signOutFailed);
  f.fetcher.mockImplementation(answer);
  await user.click(retry);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
  expect(screen.queryByText(signOutFailed)).toBeNull();
});
it('runs a write at once while offline and never sends it again once online', async () => {
  const connect = browserConnection();
  window.history.replaceState(null, '', '/portal');
  connect(false);
  const client = createShellQueryClient();
  client.mount();
  try {
    expect(onlineManager.isOnline()).toBe(false);
    const mutationFn = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const mutation = client.getMutationCache().build(client, { mutationFn });
    const outcome = mutation.execute(undefined).catch((error: unknown) => error);
    await waitFor(() => expect(mutationFn).toHaveBeenCalledOnce());
    expect(await outcome).toBeInstanceOf(TypeError);
    expect(mutation.state).toMatchObject({ status: 'error', isPaused: false });
    connect(true);
    expect(onlineManager.isOnline()).toBe(true);
    await client.resumePausedMutations();
    expect(mutationFn).toHaveBeenCalledOnce();
  } finally { client.unmount(); }
});
it('shows the offline banner with the loading state when the portal opens offline, and opens once online', async () => {
  const connect = browserConnection();
  window.history.replaceState(null, '', '/portal');
  connect(false);
  const f = portal(ids.first);
  expect(await screen.findByText(offlineBanner)).toBeDefined();
  expect(loading()).toContain('Loading');
  // The gym's name isn't loaded yet, so there's no header.
  expect(screen.queryByRole('banner')).toBeNull();
  expect(f.cache.getQueryState(bootstrapKey)).toMatchObject({ status: 'pending', fetchStatus: 'paused' });
  expect(f.fetcher.mock.calls.filter(([path]) => path.startsWith('/api/portal/'))).toEqual([]);
  connect(true);
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  expect(screen.queryByText(offlineBanner)).toBeNull();
});
it.each(['/api/portal/households', '/api/portal/context'])('shows the offline banner while %s is still loading', async held => {
  const connect = browserConnection(), f = portal(ids.first);
  const answer = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation((path, init) => path === held ? new Promise<Response>(() => undefined) : answer(path, init));
  await waitFor(() => expect(fetchCount(f, held)).toBe(1));
  expect(loading()).toContain('Loading');
  expect(screen.queryByText(offlineBanner)).toBeNull();
  connect(false);
  expect(screen.getByText(offlineBanner)).toBeDefined();
  expect(loading()).toContain('Loading');
  expect(screen.queryByRole('banner')).toBeNull();
  connect(true);
  expect(screen.queryByText(offlineBanner)).toBeNull();
});
/** jsdom reads a `calc()` that subtracts twice back with its last term added, so keep the string the layout writes. */
function keepMaxHeight(element: HTMLElement) {
  let written = '';
  Object.defineProperty(element.style, 'maxHeight', { configurable: true, get: () => written, set: (value: string) => { written = value; } });
}
const portalMenu = async () => {
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  return { menu: screen.getByRole('button', { name: 'Menu' }), nav: screen.getByRole('navigation', { name: 'Member navigation' }),
    backdrop: () => document.querySelector<HTMLElement>('div[aria-hidden="true"].fixed') };
};
it('moves focus into the open phone menu, back to Menu on Escape, and keeps the page behind it inert', async () => {
  portal(ids.first);
  const user = userEvent.setup(), { menu, nav } = await portalMenu(), main = screen.getByRole('main');
  expect(main.hasAttribute('inert')).toBe(false);
  await user.click(menu);
  expect(document.activeElement).toBe(within(nav).getAllByRole('link')[0]);
  expect(main.hasAttribute('inert')).toBe(true);
  await user.keyboard('{Escape}');
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(menu);
  expect(main.hasAttribute('inert')).toBe(false);
  // A press inside the panel keeps it open; one outside the panel and the button closes it.
  await user.click(menu);
  act(() => { within(nav).getByRole('list').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(menu.getAttribute('aria-expanded')).toBe('true');
  act(() => { within(screen.getByRole('banner')).getByText('Test Gym').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  expect(main.hasAttribute('inert')).toBe(false);
  // The backdrop stays through the press and closes on the click, so a tap can't land on the page under it.
  await user.click(menu);
  const backdrop = document.querySelector<HTMLElement>('div[aria-hidden="true"].fixed')!;
  act(() => { backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(backdrop.isConnected).toBe(true);
  expect(menu.getAttribute('aria-expanded')).toBe('true');
  await user.click(backdrop);
  expect(menu.getAttribute('aria-expanded')).toBe('false');
});
it('stops the open phone menu short of the screen\'s bottom and makes what it covers inert until Escape', async () => {
  const link = document.createElement('a'), footer = document.createElement('footer');
  for (const element of [link, footer]) { element.setAttribute('data-menu-covers', ''); element.inert = false; document.body.append(element); }
  try {
    portal(ids.first);
    const user = userEvent.setup(), { menu, nav } = await portalMenu();
    keepMaxHeight(nav);
    await user.click(menu);
    expect(nav.style.maxHeight).toMatch(/px - 3rem\), calc\(4\.25rem \+ 1px\)\)$/);
    expect([link.inert, footer.inert]).toEqual([true, true]);
    await user.keyboard('{Escape}');
    expect([link.inert, footer.inert]).toEqual([false, false]);
  } finally { link.remove(); footer.remove(); }
});
it('takes a press above the phone menu and closes it on the click, so what is above the portal is never clicked', async () => {
  const rows = document.createElement('div'), control = document.createElement('button'), clicked = vi.fn();
  control.addEventListener('click', clicked);
  rows.setAttribute('data-menu-covers', ''); rows.inert = false; rows.append(control); document.body.prepend(rows);
  try {
    portal(ids.first);
    const user = userEvent.setup(), { menu } = await portalMenu(), header = screen.getByRole('banner');
    vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({ bottom: 121 }) as DOMRect);
    const cover = () => document.querySelector<HTMLElement>('div[aria-hidden="true"].top-0');
    expect(cover()).toBeNull();
    await user.click(menu);
    const above = cover()!;
    expect([...above.classList]).toEqual(expect.arrayContaining(['fixed', 'inset-x-0', 'top-0', 'z-10', 'md:hidden']));
    expect(above.style.height).toBe('121px');
    // The press leaves the menu open, so what is under the cover stays inert until the click.
    act(() => { above.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(rows.inert).toBe(true);
    expect(above.closest('[inert]')).toBeNull();
    await user.click(above);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(cover()).toBeNull();
    expect(rows.inert).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  } finally { rows.remove(); }
});
it('starts the phone menu high enough to show one link when the header leaves less room than that', async () => {
  const innerHeight = window.innerHeight;
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 300 });
  document.documentElement.style.fontSize = '16px';
  try {
    portal(ids.first);
    const user = userEvent.setup(), { menu, nav } = await portalMenu(), header = screen.getByRole('banner');
    let bottom = 280;
    vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({ bottom }) as DOMRect);
    keepMaxHeight(nav);
    await user.click(menu);
    // One link's floor is 4.25rem and the border, 69px.
    const at = (top: number, layer: 'z-20' | 'z-40', menuTop: number) => {
      expect(nav.style.top).toBe(`${top}px`);
      expect(nav.classList).toContain(layer);
      expect(nav.classList).not.toContain(layer === 'z-20' ? 'z-40' : 'z-20');
      expect(nav.style.maxHeight).toBe(`max(calc(100dvh - ${menuTop}px - 3rem), calc(4.25rem + 1px))`);
      // The backdrop and the cover keep meeting under the header.
      expect(document.querySelector<HTMLElement>('div[aria-hidden="true"].bottom-0')!.style.top).toBe(`${menuTop}px`);
      expect(document.querySelector<HTMLElement>('div[aria-hidden="true"].top-0')!.style.height).toBe(`${menuTop}px`);
    };
    at(231, 'z-40', 280);
    // A taller screen moves the capped panel with it, though the header hasn't moved.
    window.innerHeight = 320;
    act(() => { window.dispatchEvent(new Event('resize')); });
    at(251, 'z-40', 280);
    bottom = 100;
    act(() => { window.dispatchEvent(new Event('scroll')); });
    at(100, 'z-20', 100);
  } finally {
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: innerHeight });
    document.documentElement.style.fontSize = '';
  }
});
it('keeps the open phone menu under the header as the page around it resizes or scrolls', async () => {
  const observers = new Set<{ callback: ResizeObserverCallback; observed: Set<Element> }>();
  vi.stubGlobal('ResizeObserver', class {
    private own: { callback: ResizeObserverCallback; observed: Set<Element> };
    constructor(callback: ResizeObserverCallback) { this.own = { callback, observed: new Set() }; observers.add(this.own); }
    observe(element: Element) { this.own.observed.add(element); }
    unobserve(element: Element) { this.own.observed.delete(element); }
    disconnect() { observers.delete(this.own); }
  });
  portal(ids.first);
  const user = userEvent.setup(), { menu, nav, backdrop } = await portalMenu(), header = screen.getByRole('banner');
  let bottom = 121;
  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({ bottom }) as DOMRect);
  keepMaxHeight(nav);
  await user.click(menu);
  const observed = () => [...observers].flatMap(observer => [...observer.observed]);
  expect(observed()).toContain(document.body);
  expect(observed()).toContain(header);
  expect(observed()).toContain(header.parentElement);
  const at = (top: number) => {
    expect(nav.style.top).toBe(`${top}px`);
    expect(backdrop()!.style.top).toBe(`${top}px`);
    expect(nav.style.maxHeight).toBe(`max(calc(100dvh - ${top}px - 3rem), calc(4.25rem + 1px))`);
  };
  at(121);
  expect(nav.classList).not.toContain('bottom-0');
  expect(backdrop()!.classList).toContain('bottom-0');
  // Content above the portal grows.
  bottom = 161;
  act(() => { for (const observer of observers) observer.callback([], {} as ResizeObserver); });
  at(161);
  // The page moves without anything resizing.
  bottom = 121;
  act(() => { window.dispatchEvent(new Event('scroll')); });
  at(121);
  bottom = 161;
  act(() => { window.dispatchEvent(new Event('scroll')); });
  at(161);
  // A header scrolled off the screen leaves the panel at the top, not above it.
  bottom = -40;
  act(() => { window.dispatchEvent(new Event('scroll')); });
  at(0);
  await user.keyboard('{Escape}');
  expect(nav.getAttribute('style') ?? '').toBe('');
  const measured = vi.mocked(header.getBoundingClientRect).mock.calls.length;
  act(() => { window.dispatchEvent(new Event('scroll')); });
  expect(header.getBoundingClientRect).toHaveBeenCalledTimes(measured);
});
it('pads the page\'s scrolling by the docked header\'s height, and not once the header scrolls away', async () => {
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.tagName === 'HEADER' ? 121 : 0; } });
  let position = 'sticky';
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (element.tagName === 'HEADER') Object.defineProperty(style, 'position', { configurable: true, get: () => position });
    return style;
  });
  const root = document.documentElement.style;
  root.scrollPaddingTop = '3px';
  try {
    portal(ids.first);
    await screen.findByRole('heading', { name: 'Welcome to your member portal' });
    const header = screen.getByRole('banner'), height = () => header.parentElement!.style.getPropertyValue('--portal-header-height');
    expect(header.classList).toContain('[@media(max-height:500px)]:static');
    await waitFor(() => expect(root.scrollPaddingTop).toBe('129px'));
    expect(height()).toBe('121px');
    // A screen turned to landscape stops docking the header.
    position = 'static';
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(root.scrollPaddingTop).toBe('3px');
    expect(height()).toBe('0px');
    position = 'sticky';
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(root.scrollPaddingTop).toBe('129px');
    cleanup();
    expect(root.scrollPaddingTop).toBe('3px');
  } finally {
    root.scrollPaddingTop = '';
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  }
});
it('docks the header and opens the phone menu as a panel under it, closed by a link, Escape or the backdrop', async () => {
  portal(ids.first);
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Welcome to your member portal' });
  const header = screen.getByRole('banner');
  for (const name of ['sticky', 'top-0', 'z-30', 'bg-background']) expect(header.classList).toContain(name);
  const menu = screen.getByRole('button', { name: 'Menu' }), nav = screen.getByRole('navigation', { name: 'Member navigation' });
  const backdrop = () => document.querySelector<HTMLElement>('div[aria-hidden="true"].fixed');
  const open = async () => {
    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(nav.classList).toContain('fixed');
    expect(backdrop()).not.toBeNull();
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('clip');
  };
  const closed = () => {
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(nav.classList).not.toContain('fixed');
    expect(nav.classList).toContain('hidden');
    expect(backdrop()).toBeNull();
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.body.style.overflow).toBe('');
  };
  closed();
  // A link to the page already open changes no pathname, and still closes the menu.
  await open(); await user.click(within(nav).getByRole('link', { name: 'Home' })); closed();
  await open(); await user.keyboard('{Escape}'); closed();
  await open(); await user.click(backdrop()!); closed();
  await open(); await user.click(menu); closed();
  await open(); await user.click(within(nav).getByRole('link', { name: 'Billing' }));
  await screen.findByRole('heading', { name: 'Billing' }); closed();
  // Leaving the portal layout with the menu open releases the page.
  await open(); cleanup();
  expect(document.documentElement.style.overflow).toBe('');
  expect(document.body.style.overflow).toBe('');
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
