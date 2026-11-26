// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountSummary } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { breaksAnywhere } from '../../components/ui/wrap.test-helper.js';
import { onApiError } from '../../lib/api.js';
import { AccountRequestError, createAccountClient, type AccountClient } from './client.js';
import { instantLabel } from '../../lib/instant.js';
import { AccountPage } from './page.js';

const userId = '019ab4f0-0000-7000-8000-000000000001';
const base: AccountSummary = { email: 'owner@example.test', password: true, googleLinked: true, roles: ['owner'], households: [],
  pendingEmail: null, emailChange: 'available' };
function start(account: Partial<AccountSummary> = {}, login: ShellBootstrap['login'] = { password: false, magicLink: true, google: true }, request?: AccountClient['requestEmailChange'],
  changePassword: AccountClient['changePassword'] = async () => undefined) {
  let current: AccountSummary = { ...base, ...account };
  const client: AccountClient = {
    summary: vi.fn(async () => current),
    requestEmailChange: vi.fn(request ?? (async (newEmail: string) => {
      current = { ...current, pendingEmail: { email: newEmail, expiresAt: '2026-11-12T11:00:00.000Z' } };
      return { email: newEmail, expiresAt: '2026-11-12T11:00:00.000Z' };
    })),
    changePassword: vi.fn(changePassword),
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

  it('wraps unbroken names in the details, the pending notice and the messages through the page rule', async () => {
    const wraps = (element: Element) => {
      expect(breaksAnywhere(element)).toBe(true);
      // Inherited from the page, not repeated on the element.
      expect(element.className).not.toContain('wrap-anywhere');
    };
    const household = 'H'.repeat(60), pending = 'p'.repeat(47) + '@example.test', typed = 'x'.repeat(60);
    start({ households: [{ name: household, scope: 'payer' }], pendingEmail: { email: pending, expiresAt: '2026-11-12T11:00:00.000Z' } });
    wraps((await screen.findByText(content => content.includes(household))).closest('dd')!);
    wraps(screen.getByText(content => content.includes(pending)));
    await userEvent.type(screen.getByLabelText('New email'), typed);
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    wraps(await screen.findByRole('alert'));
    await userEvent.clear(screen.getByLabelText('New email'));
    const moved = 'm'.repeat(47) + '@example.test';
    await userEvent.type(screen.getByLabelText('New email'), moved);
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));
    const sent = await screen.findByText(content => content.includes(moved));
    expect(sent.getAttribute('role')).toBe('status');
    wraps(sent);
  });

  describe('password change', () => {
    const passwordOn: ShellBootstrap['login'] = { password: true, magicLink: false, google: false };
    const fields = () => ['Current password', 'New password', 'New password again'].map(label => screen.getByLabelText(label) as HTMLInputElement);
    async function fill(current: string, next: string, confirm: string) {
      await screen.findByText('owner@example.test');
      const [currentField, nextField, confirmField] = fields();
      await userEvent.type(currentField!, current); await userEvent.type(nextField!, next); await userEvent.type(confirmField!, confirm);
      await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    }

    it('shows the form only for a login with a password on a gym with password sign-in', async () => {
      start({}, passwordOn);
      await screen.findByText('owner@example.test');
      expect(screen.getByRole('heading', { name: 'Change password' })).toBeTruthy();
      expect(fields().map(field => field.autocomplete)).toEqual(['current-password', 'new-password', 'new-password']);
      expect(fields().map(field => field.type)).toEqual(['password', 'password', 'password']);
      expect((screen.getByRole('button', { name: 'Change password' }) as HTMLButtonElement).disabled).toBe(true);
      for (const [account, login] of [[{ password: false }, passwordOn], [{}, { ...passwordOn, password: false }], [{ password: false }, { ...passwordOn, password: false }]] as const) {
        cleanup();
        start(account, login);
        await screen.findByText('owner@example.test');
        expect(screen.queryByLabelText('Current password')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull();
      }
    });

    it('checks the length and the confirmation before sending anything', async () => {
      const client = start({}, passwordOn);
      await fill('current-password-1', 'new-password-1', 'new-password-2');
      expect((await screen.findByRole('alert')).textContent).toContain('The new passwords don\'t match.');
      cleanup();
      const short = start({}, passwordOn);
      await fill('current-password-1', 'x'.repeat(11), 'x'.repeat(11));
      expect((await screen.findByRole('alert')).textContent).toContain('Use 12 to 128 characters.');
      expect(client.changePassword).not.toHaveBeenCalled();
      expect(short.changePassword).not.toHaveBeenCalled();
    });

    it('changes the password, then empties the fields and says so', async () => {
      const client = start({}, passwordOn);
      await fill('current-password-1', 'new-password-12', 'new-password-12');
      await waitFor(() => expect(client.changePassword).toHaveBeenCalledWith('current-password-1', 'new-password-12'));
      expect((await screen.findByRole('status')).textContent).toContain('Password changed. Your other sessions have ended.');
      expect(fields().map(field => field.value)).toEqual(['', '', '']);
    });

    it.each([
      [new AccountRequestError(400, 'invalid_request', { currentPassword: ['wrong_password'] }), 'The current password is wrong.'],
      [new AccountRequestError(429, 'rate_limited'), 'Too many attempts. Try again in a few minutes.'],
      [new AccountRequestError(403, 'forbidden'), 'Password sign-in is off for this gym'],
      [new AccountRequestError(500, 'internal'), 'The password could not be changed. Try again.'],
    ])('explains a refusal (%s)', async (error, message) => {
      start({}, passwordOn, undefined, async () => { throw error; });
      await fill('current-password-1', 'new-password-12', 'new-password-12');
      expect((await screen.findByRole('alert')).textContent).toContain(message);
    });
  });

  it('reads account refusal bodies once, preserving validation details and notifying once on 403', async () => {
    const observe = vi.fn(), stop = onApiError(observe);
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ error: { code: 'invalid_request', details: { email: ['taken'] } } }, { status: 400 }))
        .mockResolvedValueOnce(Response.json({ error: { code: 'forbidden', details: { reason: ['demo_showcase_read_only'] } } }, { status: 403 }));
      const client = createAccountClient(fetcher);
      const invalid = await client.requestEmailChange('taken@example.test').catch((value: unknown) => value);
      expect(invalid).toBeInstanceOf(AccountRequestError);
      expect(invalid).toMatchObject({ status: 400, code: 'invalid_request', details: { email: ['taken'] } });
      expect(observe).not.toHaveBeenCalled();

      const forbidden = await client.summary().catch((value: unknown) => value);
      expect(forbidden).toBeInstanceOf(AccountRequestError);
      expect(forbidden).toMatchObject({ status: 403, code: 'forbidden', details: { reason: ['demo_showcase_read_only'] } });
      expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 403, reason: ['demo_showcase_read_only'] }));
    } finally { stop(); }
  });
});
