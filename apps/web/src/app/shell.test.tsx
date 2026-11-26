// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { NavigationEntry } from '@plaingym/shared';
import { App } from '../app.js';
import { createAppRouter } from './router.js';
import type { ShellBootstrap, ShellServices } from './services.js';
import { createWebRegistries } from '@plaingym/shared';
import { AdminShell, adminNavigationGroups, visibleAdminNavigation } from './admin-shell.js';
import { Dialog } from '../components/ui/dialog.js';
import { sessionName } from './identity.js';
import { resetThemeChoice, themeStorageKey } from '../lib/theme.js';
import { RootError, SourceFooter } from '../routes/__root.js';

// The real root shell discovers capabilities independently of the injected
// authentication services. Give these ordinary-gym fixtures a successful mode.
const ordinaryDiscovery = vi.hoisted(() => {
  const fetcher = globalThis.fetch;
  return (...args: Parameters<typeof fetch>) => args[0] === '/api/demo'
    ? Promise.resolve(Response.json({ data: { mode: 'disabled' } })) : fetcher(...args);
});

const anonymous: ShellBootstrap = {
  gym: { id: 'gym-a', name: 'Training Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: null,
  login: { password: true, magicLink: true },
};
function services(state: ShellBootstrap = anonymous): ShellServices {
  return { loadBootstrap: vi.fn().mockResolvedValue(state), signInWithPassword: vi.fn().mockResolvedValue(undefined),
    requestMagicLink: vi.fn().mockResolvedValue(undefined), signOut: vi.fn().mockResolvedValue(undefined) };
}
/** jsdom reads a `calc()` that subtracts twice back with its last term added, so keep the string the shell writes. */
function keepMaxHeight(element: HTMLElement) {
  let written = '';
  Object.defineProperty(element.style, 'maxHeight', { configurable: true, get: () => written, set: (value: string) => { written = value; } });
}
function start(service: ShellServices, path = '/login') {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<App services={service} router={router} />);
  return router;
}
beforeEach(() => { vi.stubGlobal('fetch', ordinaryDiscovery); vi.stubGlobal('scrollTo', vi.fn()); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.removeItem(themeStorageKey);
  resetThemeChoice();
  document.documentElement.classList.remove('theme-system', 'light', 'dark');
});

describe('login', () => {
  it('renders the gym and always exposes the source footer', async () => {
    start(services());
    expect(await screen.findByRole('heading', { name: 'Sign in to your gym' })).toBeDefined();
    expect(screen.getByText('Training Academy')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('/source');
  });
  it('signs in with a password, reloads the principal and sends staff to admin', async () => {
    const service = services();
    const staff = { ...anonymous, session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false } };
    vi.mocked(service.loadBootstrap).mockResolvedValueOnce(anonymous).mockResolvedValue(staff);
    const router = start(service);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'owner@example.org');
    await user.type(screen.getByLabelText('Password'), 'correct password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(service.signInWithPassword).toHaveBeenCalledWith('owner@example.org', 'correct password');
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
  it('supports password-only mode without offering email links', async () => {
    start(services({ ...anonymous, login: { password: true, magicLink: false } }));
    await screen.findByLabelText('Password');
    expect(screen.queryByRole('button', { name: 'Email me a sign-in link' })).toBeNull();
  });
  it('requests a magic link without requiring a password and offers a confirmation', async () => {
    const service = services(); start(service);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'member@example.org');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText(/If this address can sign in/)).toBeDefined();
    expect(service.requestMagicLink).toHaveBeenCalledWith('member@example.org');
    expect(service.signInWithPassword).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe('');
  });
  it('renders magic-link-only mode and submits by keyboard', async () => {
    const service = services({ ...anonymous, login: { password: false, magicLink: true } }); start(service);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'member@example.org{Enter}');
    await screen.findByText(/If this address can sign in/);
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(service.requestMagicLink).toHaveBeenCalledTimes(1);
  });
  it('does not send duplicate requests while pending', async () => {
    const service = services();
    let finish!: () => void;
    vi.mocked(service.requestMagicLink).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    start(service); const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'member@example.org');
    const submit = screen.getByRole('button', { name: 'Email me a sign-in link' });
    await user.click(submit); await user.click(submit);
    expect(service.requestMagicLink).toHaveBeenCalledTimes(1);
    finish(); await screen.findByText(/If this address can sign in/);
  });
  it('shows a safe error, clears the password and permits retry', async () => {
    const service = services();
    vi.mocked(service.signInWithPassword).mockRejectedValue(new Error('SQL secret stack trace'));
    start(service); const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'member@example.org');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to sign in');
    expect(document.body.textContent).not.toContain('SQL secret');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });
  it('shows no enabled login method when the server disables both', async () => {
    start(services({ ...anonymous, login: { password: false, magicLink: false } }));
    expect((await screen.findByText(/Sign-in is currently unavailable/)).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByLabelText('Email address')).toBeNull();
  });
  it('retries a failed bootstrap without exposing server details', async () => {
    const service = services();
    vi.mocked(service.loadBootstrap).mockRejectedValueOnce(new Error('private details')).mockResolvedValue(anonymous);
    start(service);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByLabelText('Email address');
    expect(document.body.textContent).not.toContain('private details');
  });
  it('sends a signed-in member to their portal', async () => {
    const router = start(services({ ...anonymous, session: { userId: 'member', displayName: 'Test User', roles: [], member: true } }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/portal'));
  });
});

const nav: NavigationEntry[] = [
  { id: 'members', labelKey: 'Members', href: '/admin/members', enabled: true, permission: { kind: 'staff', capability: 'members.read' } },
  { id: 'settings', labelKey: 'Settings', href: '/admin/settings', enabled: true, permission: { kind: 'staff', capability: 'settings.manage' } },
  { id: 'website', labelKey: 'Website', href: '/admin/waivers', enabled: true, moduleId: 'website', permission: { kind: 'staff', capability: 'members.read' } },
  { id: 'disabled', labelKey: 'Disabled', href: '/admin/ranks', enabled: false, permission: { kind: 'staff', capability: 'members.read' } },
  { id: 'public', labelKey: 'Public', href: '/login', enabled: true, permission: { kind: 'public' } },
];
describe('admin shell', () => {
  it('puts Dashboard first and keeps billing together regardless of registry order', () => {
    const paths = ['/admin/settings', '/admin/billing/plans', '/admin/members', '/admin', '/admin/billing/invoices'];
    const entries = paths.map(href => ({ ...nav[0]!, id: href, href }));
    expect(adminNavigationGroups(entries).map(group => [group.id, group.entries.map(entry => entry.href)])).toEqual([
      ['overview', ['/admin']], ['gym', ['/admin/members']],
      ['billing', ['/admin/billing/invoices', '/admin/billing/plans']], ['administration', ['/admin/settings']],
    ]);
  });
  it('filters enabled items by module and all of the principal roles', () => {
    const coach = { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false };
    expect(visibleAdminNavigation(nav, coach, []).map((x) => x.id)).toEqual(['members']);
    expect(visibleAdminNavigation(nav, coach, ['website']).map((x) => x.id)).toEqual(['members', 'website']);
    expect(visibleAdminNavigation(nav, { ...coach, roles: ['coach', 'admin'] }, []).map((x) => x.id)).toEqual(['members', 'settings']);
  });
  it('renders navigation links and toggles the mobile menu with accessible state', async () => {
    const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
    const signOut = vi.fn();
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={signOut}><p>Child content</p></AdminShell> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(<RouterProvider router={router} />);
    await screen.findByRole('navigation', { name: 'Gym navigation' });
    expect(screen.getByRole('link', { name: 'Members' }).getAttribute('href')).toBe('/admin/members');
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Website' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Disabled' })).toBeNull();
    expect(screen.getByText('Child content')).toBeDefined();
    const user = userEvent.setup();
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(menu.getAttribute('aria-label')).toBe('Close menu');
    // Opening moves focus into the menu; Escape closes it and returns focus to the button.
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Members' }));
    await user.keyboard('{Escape}');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
    await user.click(menu);
    fireEvent.pointerDown(screen.getByText('Child content'));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    const account = screen.getByRole('button', { name: 'Account' });
    expect(account.getAttribute('aria-expanded')).toBe('false');
    await user.click(account);
    expect(screen.getByText(/Signed in as/).textContent).toBe('Signed in as Test User (Coach)');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });
  it('shows the stored admin theme and applies each selection immediately', async () => {
    localStorage.setItem(themeStorageKey, 'light');
    const state = { ...anonymous, session: { userId: 'owner', displayName: 'Test Owner', roles: ['owner'] as const, member: false } };
    start(services(state), '/admin');
    const user = userEvent.setup();
    const account = await screen.findByRole('button', { name: 'Account' });
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
    await user.click(account);
    const theme = within(screen.getByRole('group', { name: 'Theme' }));
    expect(theme.getByRole('radio', { name: 'Light', checked: true })).toBeDefined();
    for (const [label, choice, className] of [['Dark', 'dark', 'dark'], ['System', 'system', 'theme-system'], ['Light', 'light', 'light']] as const) {
      await user.click(theme.getByRole('radio', { name: label }));
      expect(theme.getAllByRole('radio', { checked: true })).toEqual([theme.getByRole('radio', { name: label })]);
      expect(document.documentElement.className).toBe(className);
      expect(localStorage.getItem(themeStorageKey)).toBe(choice);
    }
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(account);
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
  });
  it('follows another tab theme change in the page and the open account menu', async () => {
    localStorage.setItem(themeStorageKey, 'light');
    const state = { ...anonymous, session: { userId: 'owner', displayName: 'Test Owner', roles: ['owner'] as const, member: false } };
    start(services(state), '/admin');
    const user = userEvent.setup();
    const account = await screen.findByRole('button', { name: 'Account' });
    await user.click(account);
    const theme = within(screen.getByRole('group', { name: 'Theme' }));
    expect(theme.getByRole('radio', { name: 'Light', checked: true })).toBeDefined();
    expect(document.documentElement.classList.contains('light')).toBe(true);

    localStorage.setItem(themeStorageKey, 'dark');
    fireEvent(window, new StorageEvent('storage', {
      key: themeStorageKey, oldValue: 'light', newValue: 'dark', storageArea: localStorage, url: window.location.href,
    }));
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
    expect(theme.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();

    await user.click(theme.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(theme.getAllByRole('radio', { checked: true })).toEqual([theme.getByRole('radio', { name: 'Light' })]);
    expect(localStorage.getItem(themeStorageKey)).toBe('light');
  });
  it('returns the page and the open account menu to System when another tab clears its storage', async () => {
    localStorage.setItem(themeStorageKey, 'dark');
    const state = { ...anonymous, session: { userId: 'owner', displayName: 'Test Owner', roles: ['owner'] as const, member: false } };
    start(services(state), '/admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Account' }));
    const theme = within(screen.getByRole('group', { name: 'Theme' }));
    expect(theme.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();

    localStorage.clear();
    fireEvent(window, new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage, url: window.location.href }));
    await waitFor(() => expect(theme.getByRole('radio', { name: 'System', checked: true })).toBeDefined());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
  it('applies another tab theme change while the account menu is closed', async () => {
    localStorage.setItem(themeStorageKey, 'light');
    const state = { ...anonymous, session: { userId: 'owner', displayName: 'Test Owner', roles: ['owner'] as const, member: false } };
    start(services(state), '/admin');
    const user = userEvent.setup();
    const account = await screen.findByRole('button', { name: 'Account' });
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();

    localStorage.setItem(themeStorageKey, 'dark');
    fireEvent(window, new StorageEvent('storage', {
      key: themeStorageKey, oldValue: 'light', newValue: 'dark', storageArea: localStorage, url: window.location.href,
    }));
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();

    await user.click(account);
    const theme = within(screen.getByRole('group', { name: 'Theme' }));
    expect(theme.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();
  });
  it('shows who is signed in, with every role, in the header outside the collapsed menus on every page', async () => {
    const state = { ...anonymous, session: { userId: 'owner', displayName: 'Dana Owner', roles: ['owner', 'coach'] as const, member: false } };
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
    const identity = await screen.findByTestId('signed-in-identity');
    expect(identity.textContent).toContain('Dana Owner · Owner, Coach');
    // Neither the phone navigation nor the account popover has to be opened to see it, and it stays on one truncated line.
    expect(identity.closest('header')).not.toBeNull();
    expect(identity.closest('nav, #account-menu')).toBeNull();
    expect(within(identity).getByText('Dana Owner').className).toContain('truncate');
  });
  it('shows a generic label, never the user ID, for a session the server could not name', async () => {
    const state = { ...anonymous, session: { userId: 'user-id-1', displayName: null, roles: ['coach'] as const, member: false } };
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
    expect((await screen.findByTestId('signed-in-identity')).textContent).toContain('Signed in · Coach');
    expect(document.body.textContent).not.toContain('user-id-1');
    expect(screen.getByText(/^Signed in \(Coach\)$/)).toBeDefined();
  });
  it('words an unnamed session the same in the account menu as in the header and the portal header', async () => {
    const state = { ...anonymous, session: { userId: 'user-id-1', displayName: null, roles: ['coach'] as const, member: false } };
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
    const label = sessionName(state.session);
    expect(within(await screen.findByTestId('signed-in-identity')).getByText(label)).toBeDefined();
    expect(screen.getByText(new RegExp(`^${label} \\(Coach\\)$`)).closest('#account-menu')).not.toBeNull();
  });
  it('closes the phone menu after navigating', async () => {
    const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const menu = await screen.findByRole('button', { name: 'Menu' });
    await user.click(menu);
    await user.click(screen.getByRole('link', { name: 'Members' }));
    await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'));
  });
  it('hides the phone menu group headings while keeping every group labelled for screen readers', async () => {
    const state = { ...anonymous, session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false } };
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
    const navigation = await screen.findByRole('navigation', { name: 'Gym navigation' });
    const heading = within(navigation).getByRole('heading', { name: 'Gym' });
    // The heading is removed from the phone layout, and returns unchanged from `md`.
    expect(heading.className).toContain('hidden');
    expect(heading.className).toContain('md:block');
    // Each group keeps its section (and therefore its label) while the links remain one list.
    expect(navigation.querySelector('section[aria-labelledby="nav-gym"]')).not.toBeNull();
    expect(navigation.querySelector('section[aria-labelledby="nav-administration"]')).not.toBeNull();
  });
  it('anchors the open phone menu below the sticky header after the page has scrolled', async () => {
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    const scrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.tagName === 'HEADER' ? 56 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return this.classList.contains('relative') ? 100 : 0; } });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Menu' }));
      // Content at 100px in the document, scrolled by 300px: the sticky header's 56px wins over the off-screen top.
      await waitFor(() => expect(screen.getByRole('navigation', { name: 'Gym navigation' }).style.top).toBe('56px'));
    } finally {
      for (const [key, descriptor] of [['offsetHeight', offsetHeight], ['offsetTop', offsetTop]] as const)
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      if (scrollY) Object.defineProperty(window, 'scrollY', scrollY);
      else delete (window as unknown as Record<string, unknown>).scrollY;
    }
  });
  it('measures the phone menu from the current scroll and again after closing and reopening', async () => {
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    const scrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    let contentTop = 1000, currentScroll = 300;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.tagName === 'HEADER' ? 56 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return this.classList.contains('relative') ? contentTop : 0; } });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => currentScroll });
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      const menu = await screen.findByRole('button', { name: 'Menu' });
      const navigation = screen.getByRole('navigation', { name: 'Gym navigation' });
      await user.click(menu);
      await waitFor(() => expect(navigation.style.top).toBe('700px'));
      // The scroll moves while the menu is open (a layout change can clamp it), so the next measurement must use it.
      currentScroll = 950;
      fireEvent.scroll(window);
      await waitFor(() => expect(navigation.style.top).toBe('56px'));
      // Closing drops the cached top; reopening measures the current scroll and content, not the old top.
      await user.keyboard('{Escape}');
      expect(menu.getAttribute('aria-expanded')).toBe('false');
      contentTop = 1300; currentScroll = 100;
      await user.click(menu);
      await waitFor(() => expect(navigation.style.top).toBe('1200px'));
    } finally {
      for (const [key, descriptor] of [['offsetHeight', offsetHeight], ['offsetTop', offsetTop]] as const)
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      if (scrollY) Object.defineProperty(window, 'scrollY', scrollY);
      else delete (window as unknown as Record<string, unknown>).scrollY;
    }
  });
  it('re-measures the phone menu when the content container changes size', async () => {
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    const scrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    let contentTop = 1000;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.tagName === 'HEADER' ? 56 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return this.classList.contains('relative') ? contentTop : 0; } });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 300 });
    const observed = new Set<Element>(), callbacks = new Set<ResizeObserverCallback>();
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) { callbacks.add(callback); }
      observe(element: Element) { observed.add(element); }
      disconnect() { callbacks.clear(); }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Menu' }));
      const navigation = screen.getByRole('navigation', { name: 'Gym navigation' });
      await waitFor(() => expect(navigation.style.top).toBe('700px'));
      expect(observed).toContain(navigation.parentElement);
      // A banner appearing above the content moves it down; the measured top follows.
      contentTop = 1300;
      for (const callback of callbacks) callback([], {} as ResizeObserver);
      await waitFor(() => expect(navigation.style.top).toBe('1000px'));
    } finally {
      for (const [key, descriptor] of [['offsetHeight', offsetHeight], ['offsetTop', offsetTop]] as const)
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      if (scrollY) Object.defineProperty(window, 'scrollY', scrollY);
      else delete (window as unknown as Record<string, unknown>).scrollY;
    }
  });
  it('pads the page\'s scrolling by the docked header while mounted, and restores it after', async () => {
    const root = document.documentElement.style;
    root.scrollPaddingTop = '3px';
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const route = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      await screen.findByRole('navigation', { name: 'Gym navigation' });
      expect(root.scrollPaddingTop).toBe('calc(var(--spacing-header) + 0.5rem)');
      cleanup();
      expect(root.scrollPaddingTop).toBe('3px');
    } finally {
      root.scrollPaddingTop = '';
    }
  });
  it('sizes the open phone menu to its links, up to the space below its top, so the backdrop shows', async () => {
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.tagName === 'HEADER' ? 56 : 0; } });
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      const opener = await screen.findByRole('button', { name: 'Menu' });
      const navigation = screen.getByRole('navigation', { name: 'Gym navigation' });
      keepMaxHeight(navigation);
      await user.click(opener);
      await waitFor(() => expect(navigation.style.top).toBe('56px'));
      expect(navigation.style.maxHeight).toBe('max(calc(100dvh - 56px - 3rem), calc(3.75rem + 1px))');
      expect(navigation.classList).toContain('fixed');
      expect(navigation.classList).not.toContain('bottom-0');
      expect(navigation.classList).not.toContain('max-h-dvh');
      const backdrop = document.querySelector<HTMLElement>('div[aria-hidden="true"].fixed')!;
      expect(backdrop.classList).toContain('bottom-0');
      expect(backdrop.style.top).toBe('56px');
      // The backdrop stays through the press and closes on the click, so a tap can't land on the page under it.
      const menu = screen.getByRole('button', { name: 'Close menu' });
      fireEvent.pointerDown(backdrop);
      expect(backdrop.isConnected).toBe(true);
      expect(menu.getAttribute('aria-expanded')).toBe('true');
      await user.click(backdrop);
      expect(menu.getAttribute('aria-expanded')).toBe('false');
      expect(navigation.getAttribute('style') ?? '').toBe('');
    } finally {
      if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  });
  it('stops the open phone menu short of the screen\'s bottom and makes what it covers inert until it closes', async () => {
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.tagName === 'HEADER' ? 57 : 0; } });
    const link = document.createElement('a'), footer = document.createElement('footer'), already = document.createElement('div');
    for (const element of [link, footer, already]) { element.setAttribute('data-menu-covers', ''); document.body.append(element); }
    link.inert = false; footer.inert = false; already.inert = true;
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      const view = render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      const menu = await screen.findByRole('button', { name: 'Menu' }), main = screen.getByRole('main');
      const covered = (inert: boolean) => {
        expect(main.hasAttribute('inert')).toBe(inert);
        expect([link.inert, footer.inert]).toEqual([inert, inert]);
        expect(already.inert).toBe(true);
      };
      covered(false);
      const navigation = screen.getByRole('navigation', { name: 'Gym navigation' });
      keepMaxHeight(navigation);
      await user.click(menu);
      await waitFor(() => expect(navigation.style.maxHeight).toBe('max(calc(100dvh - 57px - 3rem), calc(3.75rem + 1px))'));
      covered(true);
      await user.keyboard('{Escape}');
      expect(document.activeElement).toBe(menu);
      covered(false);
      // A shell that goes away with its menu open gives them back too.
      await user.click(menu); covered(true);
      view.unmount();
      expect([link.inert, footer.inert, already.inert]).toEqual([false, false, true]);
    } finally {
      for (const element of [link, footer, already]) element.remove();
      if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  });
  it('makes the update banner inert only while the phone menu is open', async () => {
    const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}
      banner={<a href="/admin/updates">Update available</a>}><p>Child content</p></AdminShell> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
    const user = userEvent.setup();
    const menu = await screen.findByRole('button', { name: 'Menu' }), link = screen.getByRole('link', { name: 'Update available' });
    expect(link.closest('[inert]')).toBeNull();
    await user.click(menu);
    expect(link.closest('[inert]')).not.toBeNull();
    // The menu's own button, Account and the backdrop stay usable.
    expect(menu.closest('[inert]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Account' }).closest('[inert]')).toBeNull();
    expect(document.querySelector('div[aria-hidden="true"].fixed')!.closest('[inert]')).toBeNull();
    await user.keyboard('{Escape}');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(link.closest('[inert]')).toBeNull();
  });
  it('moves the open phone menu when content above the shell resizes the page', async () => {
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    let contentTop = 57;
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return this.classList.contains('relative') ? contentTop : 0; } });
    const observers = new Set<{ callback: ResizeObserverCallback; observed: Set<Element> }>();
    vi.stubGlobal('ResizeObserver', class {
      private own: { callback: ResizeObserverCallback; observed: Set<Element> };
      constructor(callback: ResizeObserverCallback) { this.own = { callback, observed: new Set() }; observers.add(this.own); }
      observe(element: Element) { this.own.observed.add(element); }
      disconnect() { observers.delete(this.own); }
    });
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Menu' }));
      const navigation = screen.getByRole('navigation', { name: 'Gym navigation' });
      await waitFor(() => expect(navigation.style.top).toBe('57px'));
      const watching = [...observers].filter(observer => observer.observed.has(document.body));
      expect(watching).toHaveLength(1);
      contentTop = 97;
      act(() => { watching[0]!.callback([], {} as ResizeObserver); });
      expect(navigation.style.top).toBe('97px');
    } finally {
      if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop;
    }
  });
  it('covers the app\'s own skip link and source footer while the phone menu is open', async () => {
    const state = { ...anonymous, session: { userId: 'owner', displayName: 'Test Owner', roles: ['owner'] as const, member: false } };
    start(services(state), '/admin');
    const user = userEvent.setup(), menu = await screen.findByRole('button', { name: 'Menu' });
    const covered = [screen.getByRole('link', { name: 'Skip to content' }), screen.getByRole('contentinfo')];
    await user.click(menu);
    expect(covered.map(element => element.inert)).toEqual([true, true]);
    await user.keyboard('{Escape}');
    expect(covered.map(element => Boolean(element.inert))).toEqual([false, false]);
  });
  it('locks the page behind the phone menu without a scrollbar shift and releases it on Escape, outside press and navigation', async () => {
    const width = window.innerWidth;
    const clientWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 345 });
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      const menu = await screen.findByRole('button', { name: 'Menu' });
      const locked = () => {
        expect(document.documentElement.style.overflow).toBe('hidden');
        expect(document.body.style.overflow).toBe('clip');
        expect(document.documentElement.style.scrollbarGutter).toBe('stable');
        expect(document.body.style.paddingRight).toBe('');
      };
      const released = () => {
        expect(document.documentElement.style.overflow).toBe('');
        expect(document.documentElement.style.scrollbarGutter).toBe('');
        expect(document.body.style.overflow).toBe('');
        expect(document.body.style.paddingRight).toBe('');
      };
      await user.click(menu); locked();
      await user.keyboard('{Escape}'); released();
      await user.click(menu); locked();
      fireEvent.pointerDown(screen.getByText('Child content')); released();
      await user.click(menu); locked();
      await user.click(screen.getByRole('link', { name: 'Members' }));
      await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'));
      released();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      if (clientWidth) Object.defineProperty(document.documentElement, 'clientWidth', clientWidth);
      else delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
    }
  });
  it.each(['menu', 'dialog'] as const)('restores the page styles once when the phone menu and a dialog overlap (%s closes first)', async firstToClose => {
    const width = window.innerWidth;
    const clientWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 345 });
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('overflow', 'auto'); rootStyle.setProperty('scrollbar-gutter', 'auto'); document.body.style.overflow = 'visible';
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    try {
      const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
      function Content() {
        const [shown, setShown] = useState(false);
        return <><button onClick={() => setShown(true)}>Open dialog</button>
          {shown && <Dialog title="Overlap" closeLabel="Close dialog" onClose={() => setShown(false)}>Dialog body</Dialog>}</>;
      }
      const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><Content /></AdminShell> });
      render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
      const user = userEvent.setup();
      const menu = await screen.findByRole('button', { name: 'Menu' });
      const original = () => {
        expect(rootStyle.overflow).toBe('auto');
        expect(rootStyle.scrollbarGutter).toBe('auto');
        expect(document.body.style.overflow).toBe('visible');
      };
      const locked = () => {
        expect(rootStyle.overflow).toBe('hidden');
        expect(rootStyle.scrollbarGutter).toBe('stable');
      };
      await user.click(menu); locked();
      // A route change mounts the dialog without a pointer press, so the menu stays open.
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog', hidden: true })); locked();
      const closeMenu = async () => { await user.keyboard('{Escape}'); await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false')); };
      const closeDialog = async () => { fireEvent.click(screen.getByRole('button', { name: 'Close dialog', hidden: true })); await waitFor(() => expect(screen.queryByText('Dialog body')).toBeNull()); };
      if (firstToClose === 'menu') { await closeMenu(); locked(); await closeDialog(); } else { await closeDialog(); locked(); await closeMenu(); }
      original();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      if (clientWidth) Object.defineProperty(document.documentElement, 'clientWidth', clientWidth);
      else delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
      rootStyle.removeProperty('overflow'); rootStyle.removeProperty('scrollbar-gutter'); document.body.style.removeProperty('overflow');
    }
  });
  it('closes the phone menu and releases the page when the md media query changes', async () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const query = vi.fn((media: string) => ({
      get matches() { return matches; }, media,
      addEventListener: (type: string, listener: () => void) => { if (type === 'change') listeners.add(listener); },
      removeEventListener: (type: string, listener: () => void) => { if (type === 'change') listeners.delete(listener); },
    }));
    vi.stubGlobal('matchMedia', query);
    const state = { ...anonymous, session: { userId: 'coach', displayName: 'Test User', roles: ['coach'] as const, member: false } };
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createWebRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={vi.fn()}><p>Child content</p></AdminShell> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
    const user = userEvent.setup();
    const menu = await screen.findByRole('button', { name: 'Menu' });
    await user.click(menu);
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(query).toHaveBeenCalledWith('(min-width: 48rem)');
    matches = true;
    for (const listener of listeners) listener();
    await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'));
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(listeners.size).toBe(0);
  });
  it('redirects anonymous admin visits to login', async () => {
    const router = start(services(), '/admin/members');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    await screen.findByLabelText('Email address');
  });
  it('redirects member-only sessions away from admin', async () => {
    const router = start(services({ ...anonymous, session: { userId: 'member', displayName: 'Test User', roles: [], member: true } }), '/admin');
    await waitFor(() => expect(router.state.location.pathname).toBe('/portal'));
  });
  it('shows a staff-access denial for a principal without roles or membership', async () => {
    start(services({ ...anonymous, session: { userId: 'unlinked', displayName: 'Test User', roles: [], member: false } }), '/admin');
    expect((await screen.findByRole('alert')).textContent).toContain('does not have staff access');
  });
});

describe('root fallbacks', () => {
  it('keeps the source link in the error boundary', () => {
    const reset = vi.fn(); render(<RootError reset={reset} />);
    expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('/source');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' })); expect(reset).toHaveBeenCalledOnce();
  });
  it('supports a source override', () => {
    render(<SourceFooter sourceUrl="https://example.org/modified" version="" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.org/modified');
  });
  it('links a release build to its release page and a fork to its own releases', () => {
    const { unmount } = render(<SourceFooter version="0.5.0" repository="https://github.com/plaingym/plaingym" />);
    const releaseLink = screen.getByRole('link', { name: 'Version v0.5.0' });
    expect(releaseLink.getAttribute('href')).toBe('https://github.com/plaingym/plaingym/releases/tag/v0.5.0');
    expect(releaseLink.classList).toContain('min-w-11');
    expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('/source');
    unmount();
    render(<SourceFooter version="0.5.0" repository="https://git.example.org/acme/gym" />);
    expect(screen.getByRole('link', { name: 'Version v0.5.0' }).getAttribute('href')).toBe('https://git.example.org/acme/gym/releases/tag/v0.5.0');
  });
  it('shows a development build as plain text', () => {
    render(<SourceFooter version="0.4.0+0.g6e55ffe" repository="https://github.com/plaingym/plaingym" />);
    expect(screen.getByText('0.4.0+0.g6e55ffe')).toBeDefined();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
  it('links a release after one request per footer mount for the running repository', async () => {
    const reply = Promise.withResolvers<Response>();
    const request = vi.fn(() => reply.promise);
    vi.stubGlobal('fetch', request);
    render(<SourceFooter version="0.5.0" />, { reactStrictMode: true });
    expect(screen.getByText('v0.5.0')).toBeDefined();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    reply.resolve(Response.json({ data: { url: 'https://git.example.org/acme/gym' } }));
    expect((await screen.findByRole('link', { name: 'Version v0.5.0' })).getAttribute('href'))
      .toBe('https://git.example.org/acme/gym/releases/tag/v0.5.0');
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/source', { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  });
  it('keeps the release as plain text when the source request fails', async () => {
    const reply = Promise.resolve(new Response(null, { status: 500 }));
    const request = vi.fn(() => reply);
    vi.stubGlobal('fetch', request);
    render(<SourceFooter version="0.5.0" />);
    await reply;
    expect(screen.getByText('v0.5.0')).toBeDefined();
    expect(screen.getAllByRole('link')).toEqual([screen.getByRole('link', { name: 'Source code' })]);
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not request the source repository for a development build', () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    render(<SourceFooter version="0.4.0+0.g6e55ffe" />);
    expect(request).not.toHaveBeenCalled();
  });
  it('renders not-found routes inside the root footer', async () => {
    start(services(), '/missing');
    await screen.findByRole('heading', { name: 'Page not found' });
    expect(screen.getByRole('link', { name: 'Source code' })).toBeDefined();
  });
});
