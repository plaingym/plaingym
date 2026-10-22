// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { NavigationEntry } from '@plaingym/shared';
import { App } from '../app.js';
import { createAppRouter } from './router.js';
import type { ShellBootstrap, ShellServices } from './services.js';
import { createRegistries } from '../lib/registries.js';
import { AdminShell, visibleAdminNavigation } from './admin-shell.js';
import { RootError, SourceFooter } from '../routes/__root.js';

const anonymous: ShellBootstrap = {
  gym: { id: 'gym-a', name: 'Training Academy', enabledModules: [] }, session: null,
  login: { password: true, magicLink: true },
};
function services(state: ShellBootstrap = anonymous): ShellServices {
  return { loadBootstrap: vi.fn().mockResolvedValue(state), signInWithPassword: vi.fn().mockResolvedValue(undefined),
    requestMagicLink: vi.fn().mockResolvedValue(undefined), signOut: vi.fn().mockResolvedValue(undefined) };
}
function start(service: ShellServices, path = '/login') {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<App services={service} router={router} />);
  return router;
}
beforeEach(() => { vi.stubGlobal('__SOURCE_URL__', 'https://example.org/source/v1'); vi.stubGlobal('scrollTo', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('login', () => {
  it('renders the gym and always exposes the source footer', async () => {
    start(services());
    expect(await screen.findByRole('heading', { name: 'Sign in to your gym' })).toBeDefined();
    expect(screen.getByText('Training Academy')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('/source');
  });
  it('signs in with a password, reloads the principal and sends staff to admin', async () => {
    const service = services();
    const staff = { ...anonymous, session: { userId: 'owner', roles: ['owner'] as const, member: false } };
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
    expect((await screen.findByRole('alert')).textContent).toContain('Sign-in is currently unavailable');
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
    const router = start(services({ ...anonymous, session: { userId: 'member', roles: [], member: true } }));
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
  it('filters enabled items by module and all of the principal roles', () => {
    const coach = { userId: 'coach', roles: ['coach'] as const, member: false };
    expect(visibleAdminNavigation(nav, coach, []).map((x) => x.id)).toEqual(['members']);
    expect(visibleAdminNavigation(nav, coach, ['website']).map((x) => x.id)).toEqual(['members', 'website']);
    expect(visibleAdminNavigation(nav, { ...coach, roles: ['coach', 'admin'] }, []).map((x) => x.id)).toEqual(['members', 'settings']);
  });
  it('renders navigation links and toggles the mobile menu with accessible state', async () => {
    const state = { ...anonymous, session: { userId: 'coach', roles: ['coach'] as const, member: false } };
    const signOut = vi.fn();
    const root = createRootRoute({ component: () => <AdminShell state={state} entries={createRegistries([{ adminNav: nav }]).adminNav.all()} onSignOut={signOut}><p>Child content</p></AdminShell> });
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
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });
  it('redirects anonymous admin visits to login', async () => {
    const router = start(services(), '/admin/members');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    await screen.findByLabelText('Email address');
  });
  it('redirects member-only sessions away from admin', async () => {
    const router = start(services({ ...anonymous, session: { userId: 'member', roles: [], member: true } }), '/admin');
    await waitFor(() => expect(router.state.location.pathname).toBe('/portal'));
  });
  it('shows a staff-access denial for a principal without roles or membership', async () => {
    start(services({ ...anonymous, session: { userId: 'unlinked', roles: [], member: false } }), '/admin');
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
    render(<SourceFooter sourceUrl="https://example.org/modified" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.org/modified');
  });
  it('renders not-found routes inside the root footer', async () => {
    start(services(), '/missing');
    await screen.findByRole('heading', { name: 'Page not found' });
    expect(screen.getByRole('link', { name: 'Source code' })).toBeDefined();
  });
});
