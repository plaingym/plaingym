// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory } from '@tanstack/react-router';
import { App } from '../../app.js';
import { createAppRouter } from '../../app/router.js';
import { createShellServices, type ShellBootstrap, type ShellServices } from '../../app/services.js';

// The root shell asks the server whether this is a demo install; these are ordinary gyms.
vi.hoisted(() => {
  const fetcher = globalThis.fetch;
  vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) => args[0] === '/api/demo'
    ? Promise.resolve(Response.json({ data: { mode: 'disabled' } })) : fetcher(...args));
});
const gym = { id: '01900000-0000-7000-8000-000000000001', name: 'Training Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const anonymous = (login: ShellBootstrap['login']): ShellBootstrap => ({ gym, session: null, login });
const googleUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=client&state=s';
function services(state: ShellBootstrap): ShellServices {
  return { loadBootstrap: vi.fn().mockResolvedValue(state), signInWithPassword: vi.fn().mockResolvedValue(undefined),
    requestMagicLink: vi.fn().mockResolvedValue(undefined), signInWithGoogle: vi.fn().mockResolvedValue(googleUrl), signOut: vi.fn().mockResolvedValue(undefined) };
}
function login(service: ShellServices, path = '/login') {
  render(<App services={service} router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))} />);
}
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('__SOURCE_URL__', 'https://example.org/source/v1'); vi.stubGlobal('scrollTo', vi.fn());
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, origin: 'https://gym.example.org', assign });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Google on the login page', () => {
  it('is hidden without Google credentials', async () => {
    login(services(anonymous({ password: false, magicLink: true })));
    await screen.findByRole('button', { name: 'Email me a sign-in link' });
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).toBeNull();
    // An older server that doesn't report Google is the same as Google off.
    cleanup(); login(services(anonymous({ password: true, magicLink: false, google: false })));
    await screen.findByLabelText('Password');
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).toBeNull();
  });
  it('sends staff and members to Google, beside the email sign-in', async () => {
    const service = services(anonymous({ password: false, magicLink: true, google: true }));
    login(service);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(googleUrl));
    expect(service.signInWithGoogle).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined();
    expect(screen.getByText('or')).toBeDefined();
  });
  it('is the whole sign-in when it is the only method', async () => {
    login(services(anonymous({ password: false, magicLink: false, google: true })));
    await screen.findByRole('button', { name: 'Sign in with Google' });
    expect(screen.queryByText(/Sign-in is currently unavailable/)).toBeNull();
    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
  });
  it('says why a Google sign-in came back refused', async () => {
    for (const [code, text] of [['account_not_linked', /must match your login's verified email/], ['signup_disabled', /No login at this gym uses that Google address/],
      ['access_denied', /cancelled/], ['state_mismatch', /That sign-in didn't work/]] as const) {
      login(services(anonymous({ password: false, magicLink: true, google: true })), '/login?error=' + code);
      expect(await screen.findByText(text)).toBeDefined();
      cleanup();
    }
  });
  it('reports a sign-in that could not start', async () => {
    const service = services(anonymous({ password: false, magicLink: true, google: true }));
    vi.mocked(service.signInWithGoogle!).mockRejectedValue(new Error('offline'));
    login(service);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText('Unable to open Google sign-in. Please try again.')).toBeDefined();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('Google sign-in service', () => {
  it('asks for a plain Google sign-in and follows only Google\'s authorization page', async () => {
    const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ url: googleUrl, redirect: true }));
    expect(await createShellServices(vi.fn(), fetcher as unknown as typeof fetch).signInWithGoogle!()).toBe(googleUrl);
    expect(fetcher).toHaveBeenCalledWith('/api/auth/sign-in/social', expect.objectContaining({ method: 'POST', body: JSON.stringify({ provider: 'google' }) }));
    fetcher.mockResolvedValue(Response.json({ url: 'https://attacker.example/o/oauth2/v2/auth', redirect: true }));
    await expect(createShellServices(vi.fn(), fetcher as unknown as typeof fetch).signInWithGoogle!()).rejects.toThrow();
  });
});

// Settings → Google sign-in: auth.section.test.tsx.
