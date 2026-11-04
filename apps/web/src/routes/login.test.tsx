// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
