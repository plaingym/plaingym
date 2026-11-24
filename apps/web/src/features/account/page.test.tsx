// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountSummary } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { AccountRequestError, type AccountClient } from './client.js';
import { instantLabel } from '../../lib/instant.js';
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
    expect(await screen.findByText(/An email was sent to moved@example.test/)).toBeTruthy();
    expect(screen.getAllByText(/An email was sent/)).toHaveLength(1);
    // The address shown as the sign-in email is still the old one until the link is opened.
    expect(screen.getByText('owner@example.test')).toBeTruthy();
  });

  it('uses the same neutral success message for an address already in use', async () => {
    start();
    await userEvent.type(await screen.findByLabelText('New email'), 'taken@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect(await screen.findByText(/An email was sent to taken@example.test/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the pending link expiry through the shared instant label', async () => {
    const installed = Intl.DateTimeFormat;
    function GermanDefaultDateTimeFormat(locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return new installed(locale ?? 'de-DE', options);
    }
    Object.setPrototypeOf(GermanDefaultDateTimeFormat, installed);
    GermanDefaultDateTimeFormat.prototype = installed.prototype;
    Object.defineProperty(Intl, 'DateTimeFormat', { value: GermanDefaultDateTimeFormat, configurable: true, writable: true });
    try {
      start({ pendingEmail: { email: 'pending@example.test', expiresAt: '2026-11-15T18:30:00Z' } });
      const label = instantLabel('2026-11-15T18:30:00Z');
      expect(await screen.findByText(content => content.includes('pending@example.test') && content.includes(label))).toBeTruthy();
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', { value: installed, configurable: true, writable: true });
    }
  });

  it.each([400, 429])('keeps a pending notice beside a failed second request (%s)', async (status) => {
    start({ pendingEmail: { email: 'pending@example.test', expiresAt: '2026-11-12T11:00:00.000Z' } }, undefined,
      async () => { throw new AccountRequestError(status, 'failed'); });
    await userEvent.type(await screen.findByLabelText('New email'), 'another@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/An email was sent to pending@example.test/)).toBeTruthy();
  });

  it('drops a pending notice whose link a failed send withdrew (503)', async () => {
    let withdrawn = false;
    const client = start({ pendingEmail: { email: 'pending@example.test', expiresAt: '2026-11-12T11:00:00.000Z' } }, undefined,
      async () => { withdrawn = true; throw new AccountRequestError(503, 'unavailable'); });
    const summary = client.summary as ReturnType<typeof vi.fn>;
    summary.mockImplementation(async () => ({ ...base, pendingEmail: withdrawn ? null
      : { email: 'pending@example.test', expiresAt: '2026-11-12T11:00:00.000Z' } }));
    await userEvent.type(await screen.findByLabelText('New email'), 'another@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/An email was sent to pending@example.test/)).toBeNull());
  });

  it('explains an invalid typed address locally and preserves the pending notice', async () => {
    const client = start({ pendingEmail: { email: 'pending@example.test', expiresAt: '2026-11-12T11:00:00.000Z' } });
    await userEvent.type(await screen.findByLabelText('New email'), 'invalid');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a valid email address.');
    expect(screen.getByText(/An email was sent to pending@example.test/)).toBeTruthy();
    expect(client.requestEmailChange).not.toHaveBeenCalled();
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
