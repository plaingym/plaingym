// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory } from '@tanstack/react-router';
import { App } from '../app.js';
import { createAppRouter } from '../app/router.js';
import type { ShellBootstrap, ShellServices } from '../app/services.js';

const discovery = vi.hoisted(() => ({ mode: 'disabled' as 'disabled' | 'sandbox', link: (_body: unknown) => Response.json({}, { status: 404 }) }));
const fetcher = vi.hoisted(() => vi.fn(async (path: string, init?: RequestInit) => {
  if (path === '/api/demo') return discovery.mode === 'sandbox'
    ? Response.json({ data: { mode: 'sandbox', expiresAt: new Date(Date.now() + 3600_000).toISOString(), join: true } })
    : Response.json({ data: { mode: 'disabled' } });
  if (path === '/api/demo/sign-in-link') return discovery.link(JSON.parse(String(init?.body)));
  return Response.json({}, { status: 404 });
}));
vi.hoisted(() => vi.stubGlobal('fetch', fetcher));
const anonymous: ShellBootstrap = {
  gym: { id: 'gym-a', name: 'Training Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: null,
  login: { password: false, magicLink: true },
};
function services(): ShellServices {
  return { loadBootstrap: vi.fn().mockResolvedValue(anonymous), signInWithPassword: vi.fn().mockResolvedValue(undefined),
    requestMagicLink: vi.fn().mockResolvedValue(undefined), signOut: vi.fn().mockResolvedValue(undefined) };
}
const start = (path = '/login') => render(<App services={services()} router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))} />);
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('__SOURCE_URL__', 'https://example.org/source/v1'); vi.stubGlobal('scrollTo', vi.fn());
  assign = vi.fn(); vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.stubGlobal('fetch', fetcher); fetcher.mockClear(); discovery.mode = 'disabled';
  discovery.link = () => Response.json({}, { status: 404 }); });

describe('a sign-in that came back with an error', () => {
  it.each([true, false])('shows forgotten-password help only when password login is available: %s', async password => {
    const custom = services(); custom.loadBootstrap = async () => ({ ...anonymous, login: { password, magicLink: true } });
    render(<App services={custom} router={createAppRouter(createMemoryHistory({ initialEntries: ['/login'] }))} />);
    await screen.findByLabelText('Email address');
    expect(screen.queryByText(/Forgot your password/) !== null).toBe(password);
    if (password) expect(screen.getByLabelText('Password').getAttribute('aria-describedby')).toBe('password-help');
  });
  it.each([
    ['INVALID_TOKEN', 'This sign-in link was already used or has expired. Request a new one below.'],
    ['EXPIRED_TOKEN', 'This sign-in link was already used or has expired. Request a new one below.'],
    ['ATTEMPTS_EXCEEDED', 'This sign-in link was already used or has expired. Request a new one below.'],
    ['new_user_signup_disabled', 'No login here uses that address. Check it, or ask your gym to invite you.'],
    ['failed_to_create_user', "That sign-in link didn't work. Request a new one below."],
    ['failed_to_create_session', "That sign-in link didn't work. Request a new one below."],
    ['user_not_found', "That sign-in link didn't work. Request a new one below."],
  ])('explains the email link code %s without mentioning Google', async (code, message) => {
    start('/login?error=' + code);
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(document.body.textContent).not.toMatch(/Google/);
  });
  it.each([
    ['account_not_linked', /must match your login's verified email/], ['signup_disabled', /No login at this gym uses that Google address/],
    ['access_denied', /Google sign-in was cancelled/], ['state_mismatch', /That sign-in didn't work/],
  ])('keeps the Google messages for the Google code %s', async (code, message) => {
    start('/login?error=' + code);
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
  });
});

describe('Google sign-in on the login page', () => {
  const withGoogle: ShellBootstrap = { ...anonymous, login: { password: true, magicLink: true, google: true } };
  function googleServices(signInWithGoogle: () => Promise<string>) {
    return { ...services(), loadBootstrap: vi.fn().mockResolvedValue(withGoogle), signInWithGoogle };
  }
  const open = (shell: ShellServices, path = '/login') => render(<App services={shell} router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))} />);
  it('keeps only Google pending through navigation and leaves the email form usable', async () => {
    const signInWithGoogle = vi.fn().mockResolvedValue('https://accounts.google.test/auth?state=one');
    const shell = googleServices(signInWithGoogle);
    open(shell);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.test/auth?state=one'));
    // The request has resolved, yet the browser hasn't left: only a second Google start is blocked.
    const button = screen.getByRole('button', { name: /Google/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).not.toBe('Sign in with Google');
    expect((screen.getByLabelText('Email address') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(false);
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@gym.test');
    await userEvent.type(screen.getByLabelText('Password'), 'password');
    for (const submit of screen.getAllByRole('button').filter((control) => (control as HTMLButtonElement).type === 'submit')) expect((submit as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(button);
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await waitFor(() => expect(shell.requestMagicLink).toHaveBeenCalledWith('owner@gym.test'));
  });
  it('starts afresh when the page comes back from the back-forward cache', async () => {
    const signInWithGoogle = vi.fn().mockResolvedValue('https://accounts.google.test/auth?state=one');
    open(googleServices(signInWithGoogle));
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    // A plain pageshow (not from the cache) changes nothing.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect((screen.getByRole('button', { name: /Google/ }) as HTMLButtonElement).disabled).toBe(true);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('Email address') as HTMLInputElement).disabled).toBe(false);
  });
  it('does not allow another start after the former fallback while Google is still loading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const signInWithGoogle = vi.fn().mockResolvedValue('https://accounts.google.test/auth?state=slow');
      open(googleServices(signInWithGoogle));
      await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect((screen.getByRole('button', { name: /Google/ }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      const button = screen.getByRole('button', { name: /Google/ }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect((screen.getByLabelText('Email address') as HTMLInputElement).disabled).toBe(false);
      await userEvent.click(button);
      expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('enables everything again when starting Google fails', async () => {
    open(googleServices(vi.fn().mockRejectedValue(new Error('down'))));
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Email address') as HTMLInputElement).disabled).toBe(false);
  });
  it('keeps the returned banner and URL when starting Google fails', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/login?error=access_denied'] }));
    render(<App services={googleServices(vi.fn().mockRejectedValue(new Error('down')))} router={router}/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await screen.findByText(/Unable to open Google sign-in/);
    expect(screen.getByText(/Google sign-in was cancelled/)).toBeDefined();
    expect(router.state.location.searchStr).toContain('error=access_denied');
  });
  it('replaces the error search parameter on success and shows a later identical error', async () => {
    const history = createMemoryHistory({ initialEntries: ['/login?error=access_denied&keep=yes'] });
    const router = createAppRouter(history);
    render(<App services={googleServices(vi.fn().mockResolvedValue('https://accounts.google.test/auth'))} router={router}/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(router.state.location.searchStr).toBe('?keep=yes');
    expect(history.length).toBe(1);
    expect(screen.queryByText(/Google sign-in was cancelled/)).toBeNull();
    await act(async () => { history.push('/login?error=access_denied'); });
    expect(await screen.findByText(/Google sign-in was cancelled/)).toBeDefined();
  });
  it('takes a returned link error down when a new attempt starts, whichever way', async () => {
    const message = 'This sign-in link was already used or has expired. Request a new one below.';
    const shell = googleServices(vi.fn().mockResolvedValue('https://accounts.google.test/auth?state=two'));
    open(shell, '/login?error=INVALID_TOKEN');
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@gym.test');
    await userEvent.click(screen.getByRole('button', { name: /link/i }));
    await waitFor(() => expect(shell.requestMagicLink).toHaveBeenCalledWith('owner@gym.test'));
    expect(screen.queryByText(message)).toBeNull();
  });
  it('takes a returned error down when Google starts', async () => {
    open(googleServices(vi.fn().mockResolvedValue('https://accounts.google.test/auth?state=three')), '/login?error=access_denied');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Google sign-in was cancelled/);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(screen.queryByText(/Google sign-in was cancelled/)).toBeNull();
  });
});

describe('the sign-in link in a demo sandbox', () => {
  async function sendLink(email: string) {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), email);
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await screen.findByText(/If this address can sign in/);
    return user;
  }
  it('says the link is in the outbox and opens it for the address just entered', async () => {
    discovery.mode = 'sandbox';
    const asked: unknown[] = [];
    discovery.link = (body) => { asked.push(body); return Response.json({ data: { href: '/api/auth/magic-link/verify?token=t' } }); };
    start();
    const user = await sendLink('riley@example.invalid');
    expect(screen.getByText(/the link went to the demo outbox/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Open my sign-in link' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/auth/magic-link/verify?token=t'));
    expect(asked).toEqual([{ email: 'riley@example.invalid' }]);
  });
  it('says when the outbox has no sign-in link for that address, and never follows another path', async () => {
    discovery.mode = 'sandbox';
    start();
    const user = await sendLink('nobody@example.invalid');
    await user.click(screen.getByRole('button', { name: 'Open my sign-in link' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No sign-in link for this address is in the demo outbox/);
    discovery.link = () => Response.json({ data: { href: 'https://elsewhere.example/api/auth/magic-link/verify?token=t' } });
    await user.click(screen.getByRole('button', { name: 'Open my sign-in link' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not open your sign-in link/);
    expect(assign).not.toHaveBeenCalled();
  });
  it('shows neither the hint nor the button outside a sandbox', async () => {
    start();
    await sendLink('member@example.invalid');
    expect(screen.queryByRole('button', { name: 'Open my sign-in link' })).toBeNull();
    expect(screen.queryByText(/demo outbox/)).toBeNull();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/demo']);
  });
});
