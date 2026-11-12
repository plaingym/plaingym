// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountSummary } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { AccountRequestError, type AccountClient } from './client.js';
import { AccountPage } from './page.js';

const userId = '019ab4f0-0000-7000-8000-000000000001';
const base: AccountSummary = { email: 'owner@example.test', password: true, googleLinked: true, roles: ['owner'], households: [],
  pendingEmail: null, emailChange: 'available' };
function start(account: Partial<AccountSummary> = {}, login: ShellBootstrap['login'] = { password: false, magicLink: true, google: true }, request?: AccountClient['requestEmailChange']) {
  let current: AccountSummary = { ...base, ...account };
  const client: AccountClient = {
    summary: vi.fn(async () => current),
    requestEmailChange: vi.fn(request ?? (async (newEmail: string) => {
      current = { ...current, pendingEmail: { email: newEmail, expiresAt: '2026-11-12T11:00:00.000Z' } };
      return { email: newEmail, expiresAt: '2026-11-12T11:00:00.000Z' };
    })),
  };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AccountPage login={login} userId={userId} client={client} /></QueryClientProvider>);
  return client;
}
afterEach(() => cleanup());

describe('your account page', () => {
  it('shows the sign-in email, methods and access', async () => {
    start({ households: [{ name: 'Rivera family', scope: 'payer' }] });
    expect(await screen.findByText('owner@example.test')).toBeTruthy();
    expect(screen.getByText('On: a link is sent to your sign-in email')).toBeTruthy();
    // The login has a password, but password sign-in is off for this gym.
    expect(screen.getByText('Password sign-in is off for this gym')).toBeTruthy();
    expect(screen.getByText('Linked')).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText('Rivera family (payer)')).toBeTruthy();
    // A linked Google account is unlinked by a change; the page says so before it is asked for.
    expect(screen.getByText(/Your linked Google account is unlinked/)).toBeTruthy();
  });

  it('sends the link to the new address and shows the pending change', async () => {
    const client = start();
    const input = await screen.findByLabelText('New email');
    await userEvent.type(input, 'moved@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    await waitFor(() => expect(client.requestEmailChange).toHaveBeenCalledWith('moved@example.test'));
    expect(await screen.findByText(/A link was sent to moved@example.test/)).toBeTruthy();
    // The address shown as the sign-in email is still the old one until the link is opened.
    expect(screen.getByText('owner@example.test')).toBeTruthy();
  });

  it('says when another login uses the address', async () => {
    start({}, undefined, async () => { throw new AccountRequestError(409, 'conflict', { newEmail: ['email_in_use'] }); });
    await userEvent.type(await screen.findByLabelText('New email'), 'taken@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Another login uses this address.');
  });

  it('explains why the change is unavailable, without a form', async () => {
    start({ emailChange: 'several_gyms', googleLinked: false }, { password: false, magicLink: true, google: false });
    expect(await screen.findByText(/shared by every gym you belong to/)).toBeTruthy();
    expect(screen.queryByLabelText('New email')).toBeNull();
    // Google isn't offered here and isn't linked, so it isn't listed.
    expect(screen.queryByText('Google')).toBeNull();
    cleanup();
    start({ emailChange: 'no_email', password: false }, { password: true, magicLink: false });
    expect(await screen.findByText(/can't send email yet/)).toBeTruthy();
    expect(screen.getByText('Not set')).toBeTruthy();
    expect(screen.getByText('Off: this gym can\'t send email')).toBeTruthy();
  });
});
