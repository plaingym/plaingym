// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { googleCallbackPath, type GoogleLogin } from '@plaingym/shared/contracts';
import { GoogleLoginSettings } from './auth.js';
import { registration } from './auth.registrations.js';
import { refusal, reply, settings } from './integrations/fixtures.test-helper.js';
import { holdTimeouts, stalledRequests } from './save-timeout.test-helper.js';

const server = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../lib/api.js', async (original) => ({ ...await original<typeof import('../../lib/api.js')>(), api: server, createApiClient: () => server }));

const off: GoogleLogin = { source: 'none', editable: true, unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: 3 };
let google: GoogleLogin;
let cache: QueryClient;
function section() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={cache}><div data-testid="section"><GoogleLoginSettings/></div></QueryClientProvider>);
}
beforeEach(() => {
  google = off;
  server.GET.mockReset(); server.PUT.mockReset(); server.DELETE.mockReset();
  server.GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(200, { data: settings }) : reply(200, { data: google }));
});
afterEach(cleanup);

describe('Settings → Google sign-in', () => {
  it('is registered for owners and renders nothing where the gym can’t have Google sign-in', async () => {
    expect(registration.settingsSections?.[0]).toMatchObject({ enabled: true, permission: { kind: 'staff', capability: 'integrations.manage' }, component: GoogleLoginSettings });
    google = { ...off, editable: false };
    const view = section();
    await waitFor(() => expect(server.GET).toHaveBeenCalledWith('/api/settings/integrations/google'));
    await waitFor(() => expect(view.getByTestId('section').innerHTML).toBe(''));
  });
  it('says the install’s configuration sets Google, with nothing to enter', async () => {
    google = { ...off, source: 'install', editable: false };
    section();
    expect(await screen.findByRole('heading', { name: 'Google sign-in' })).toBeDefined();
    expect(screen.getByText(/operator set up the Google OAuth client in the server's configuration/)).toBeDefined();
    expect(screen.getByText(window.location.origin + googleCallbackPath)).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('stores the gym’s client, then shows its ID and the secret only as set', async () => {
    section();
    expect(await screen.findByText(/Google sign-in is off/)).toBeDefined();
    expect(screen.getByText(window.location.origin + googleCallbackPath)).toBeDefined();
    const secret = screen.getByLabelText('Client secret') as HTMLInputElement;
    expect(secret.type).toBe('password');
    const saved: GoogleLogin = { ...off, source: 'gym', clientId: 'gym-client.apps.googleusercontent.com', clientSecretSet: true, revision: 4 };
    server.PUT.mockImplementation(async () => { google = saved; return reply(200, { data: { ...saved, check: 'accepted' } }); });
    await userEvent.type(screen.getByLabelText('Client ID'), ' gym-client.apps.googleusercontent.com ');
    await userEvent.type(secret, 'gym-secret');
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/^Saved. Google accepted this client ID and secret. Google checks the redirect address only at sign-in/);
    expect(server.PUT).toHaveBeenCalledWith('/api/settings/integrations/google',
      { signal: expect.any(AbortSignal), body: { revision: 3, clientId: 'gym-client.apps.googleusercontent.com', clientSecret: 'gym-secret' } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['shell', 'bootstrap'] });
    expect(screen.getByText('Client ID: gym-client.apps.googleusercontent.com')).toBeDefined();
    expect(screen.getByText('Client secret: set')).toBeDefined();
    // The form closes: the secret is nowhere on the page.
    expect(screen.queryByLabelText('Client secret')).toBeNull();
    expect(document.body.innerHTML).not.toContain('gym-secret');
  });
  it('refuses a client Google rejected with a field error, and warns when Google could not check one', async () => {
    section();
    await screen.findByText(/Google sign-in is off/);
    server.PUT.mockResolvedValueOnce(refusal(400, 'reason', 'google_rejected'));
    await userEvent.type(screen.getByLabelText('Client ID'), 'wrong-client');
    await userEvent.type(screen.getByLabelText('Client secret'), 'wrong-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/doesn't recognise this client ID and secret/);
    expect(alert.dataset.variant).toBe('error');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    for (const name of ['Client ID', 'Client secret']) expect(screen.getByLabelText(name).getAttribute('aria-invalid')).toBe('true');
    const saved: GoogleLogin = { ...off, source: 'gym', clientId: 'unchecked-client', clientSecretSet: true, revision: 4 };
    server.PUT.mockImplementation(async () => { google = saved; return reply(200, { data: { ...saved, check: 'unknown' } }); });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/^Saved, but Google couldn't be asked to check this client/);
  });
  it('says which GOOGLE_* variable is malformed and why', async () => {
    google = { ...off, installProblem: { variable: 'GOOGLE_CLIENT_SECRET', reason: 'too_long' } };
    section();
    expect(await screen.findByText(/GOOGLE_CLIENT_SECRET in the server's .env file is longer than 512 characters/)).toBeDefined();
    // The gym's own client can still be entered.
    expect(screen.getByLabelText('Client ID')).toBeDefined();
    cleanup();
    google = { ...off, editable: false, installProblem: { variable: 'GOOGLE_CLIENT_ID', reason: 'whitespace' } };
    section();
    expect(await screen.findByText(/GOOGLE_CLIENT_ID in the server's .env file contains a space/)).toBeDefined();
  });
  it('replaces the client with both values, and turns it off unless Google is the owner’s only way in', async () => {
    google = { ...off, source: 'gym', clientId: 'gym-client', clientSecretSet: true, removeBlocked: true };
    section();
    expect(await screen.findByText(/Google is your only way to sign in/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Turn off Google sign-in' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Replace client' }));
    expect((screen.getByLabelText('Client ID') as HTMLInputElement).value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    cleanup();

    google = { ...google, removeBlocked: false };
    section();
    const removeButton = await screen.findByRole('button', { name: 'Turn off Google sign-in' });
    server.DELETE.mockResolvedValueOnce(refusal(409, 'google', 'only_sign_in'));
    await userEvent.click(removeButton);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Google is your only way to sign in. Set up email or a password before turning it off.');
    server.DELETE.mockImplementation(async () => { google = { ...off, revision: 4 }; return reply(200, { data: google }); });
    await userEvent.click(screen.getByRole('button', { name: 'Turn off Google sign-in' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Google sign-in is off.');
    expect(server.DELETE).toHaveBeenLastCalledWith('/api/settings/integrations/google', { signal: expect.any(AbortSignal), body: { revision: 3 } });
    expect(screen.getByLabelText('Client ID')).toBeDefined();
  });
  it('offers removal of an unreadable stored client while Google remains off', async () => {
    google = { ...off, unreadable: true };
    section();
    expect((await screen.findByRole('alert')).textContent).toContain("The stored Google client can't be read");
    const remove = screen.getByRole('button', { name: 'Turn off Google sign-in' });
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    server.DELETE.mockImplementation(async () => { google = { ...off, revision: 4 }; return reply(200, { data: google }); });
    await userEvent.click(remove);
    await screen.findByRole('status');
    expect(server.DELETE).toHaveBeenCalled();
    expect(screen.queryByText(/stored Google client can't be read/)).toBeNull();
  });
  it('says when the settings could not be loaded', async () => {
    server.GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(200, { data: settings }) : reply(500));
    section();
    expect(await screen.findByText('Google sign-in settings could not be loaded.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
  });
  it('aborts a save that times out', async () => {
    section();
    expect(await screen.findByText(/Google sign-in is off/)).toBeDefined();
    const stalled = stalledRequests(), timers = holdTimeouts();
    try {
      server.PUT.mockImplementation(stalled.answer);
      await userEvent.type(screen.getByLabelText('Client ID'), 'gym-client.apps.googleusercontent.com');
      await userEvent.type(screen.getByLabelText('Client secret'), 'gym-secret');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(stalled.signals).toHaveLength(1));
      timers.expire();
      expect(stalled.signals[0]!.aborted).toBe(true);
      expect(await screen.findByRole('alert')).toBeDefined();
    } finally { timers.restore(); }
  });
});
