// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Integrations } from '@plaingym/shared/contracts';
import { createRegistries } from '../../../lib/registries.js';
import { IntegrationsSettings } from './section.js';
import { integrations, refusal, renderSection, reply, serve, settings } from './fixtures.test-helper.js';
import { holdTimeouts, stalledRequests } from '../save-timeout.test-helper.js';
import { instantLabel } from '../../../lib/instant.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../../lib/api.js', async original => ({ ...await original<typeof import('../../../lib/api.js')>(), api: client, createApiClient: () => client }));

const gymEmail: Integrations = { ...integrations, revision: 4, email: { source: 'gym', unreadable: false, googleConfigured: false, host: 'smtp.gym.test', port: 465, security: 'tls', from: 'desk@gym.test',
  signIn: { password: false, magicLink: true }, signInAfterSave: { password: false, magicLink: true },
  signInAfterRemove: { password: true, magicLink: false }, removeBlocked: false } };
const removalInstall = 'Emails will be sent with this install\'s settings instead.';
const removalNone = 'Your gym will send no email until you enter email settings again.';
const removalSecret = 'The stored password is deleted and can\'t be shown again. To undo this, enter the settings again.';
const installRemoval = 'Remove and use the install’s settings', noEmailRemoval = 'Remove (the gym will have no email)';
let current: Integrations;
beforeEach(() => { for (const fn of Object.values(client)) fn.mockReset(); current = integrations; serve(client.GET, () => current); });
afterEach(cleanup);
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Use your own SMTP service' }));
  const form = screen.getByRole('form', { name: 'Use your own SMTP service' });
  await user.selectOptions(within(form).getByLabelText('Provider preset'), 'Postmark');
  await user.type(within(form).getByLabelText('SMTP username'), 'user');
  await user.type(within(form).getByLabelText('SMTP password'), 'smtp-secret');
  await user.type(within(form).getByLabelText('Sender address'), 'desk@gym.test');
  await user.type(within(form).getByLabelText('Send the test email to'), 'owner@gym.test');
  return form;
}

async function confirmRemoval(user: ReturnType<typeof userEvent.setup>, name = noEmailRemoval) {
  await user.click(await screen.findByRole('button', { name }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name }));
}

describe('Settings → Email: the last send failure', () => {
  const at = '2026-11-21T09:30:00.000Z';
  it('names the failure and when it happened, in the gym\'s timezone', async () => {
    current = { ...gymEmail, email: { ...gymEmail.email, lastSendFailure: { failure: 'authentication', at } } };
    renderSection();
    const when = instantLabel(at, 'America/Los_Angeles');
    const alert = await screen.findByText(`The last email, at ${when}, failed: the service rejected the login. Test and save the current password below.`);
    expect(alert.getAttribute('role')).toBe('alert');
  });
  it.each([null, undefined])('shows nothing when there is none (%s)', async (lastSendFailure) => {
    // The fixture has no such field, as an older server's answer.
    expect(gymEmail.email).not.toHaveProperty('lastSendFailure');
    current = lastSendFailure === null ? { ...gymEmail, email: { ...gymEmail.email, lastSendFailure } } : gymEmail;
    renderSection();
    expect(await screen.findByText(/Sends through your own SMTP/)).toBeDefined();
    expect(screen.queryByText(/The last email/)).toBeNull();
  });
  const installEmail: Integrations = { ...integrations, revision: 4, email: { ...integrations.email, source: 'install' } };
  it.each([
    ['a single-gym install names the server\'s settings', installEmail,
      'failed: the service rejected the login. Check the server\'s SMTP_USER and SMTP_PASS settings and restart the app, or save this gym\'s own settings below.'],
    ['a multi-gym install names whoever runs it', { ...installEmail, backups: null },
      'failed: the service rejected the login. Whoever runs this install manages that login.'],
  ] as const)('words a refused login through the install\'s settings: %s', async (_name, base, ending) => {
    current = { ...base, email: { ...base.email, lastSendFailure: { failure: 'authentication', at } } };
    renderSection();
    const when = instantLabel(at, 'America/Los_Angeles');
    expect((await screen.findByText(`The last email, at ${when}, ${ending}`)).getAttribute('role')).toBe('alert');
    expect(screen.queryByText(/Test and save the current password below/)).toBeNull();
  });
  it.each([
    ['the gym\'s', gymEmail], ['a single-gym install\'s', installEmail], ['a multi-gym install\'s', { ...installEmail, backups: null }],
  ] as const)('keeps the connection failure\'s text for %s settings', async (_name, base) => {
    current = { ...base, email: { ...base.email, lastSendFailure: { failure: 'connection', at } } };
    renderSection();
    const when = instantLabel(at, 'America/Los_Angeles');
    expect(await screen.findByText(`The last email, at ${when}, failed: the app couldn't connect to the sending service.`)).toBeDefined();
  });
});

describe('Settings → Email', () => {
  it('names unreadable stored settings while showing the actual fallback', async () => {
    current = { ...integrations, email: { ...integrations.email, unreadable: true, source: 'install' } };
    renderSection();
    expect((await screen.findByRole('alert')).textContent).toContain('stored SMTP settings could not be read');
    expect(screen.getByText(/Uses this install’s email settings/)).toBeDefined();
    expect(screen.queryByText(/Sends through your own SMTP/)).toBeNull();
  });
  it.each([false, true])('shows the Google removal guidance only with a client: %s', async googleConfigured => {
    current = { ...gymEmail, email: { ...gymEmail.email, googleConfigured } };
    renderSection();
    await screen.findByText(/Sends through your own SMTP/);
    expect(screen.queryByText(/The removal check counts Google/) !== null).toBe(googleConfigured);
  });
  it('registers one owner-only section for email, payments and backups', () => {
    const section = createRegistries().settingsSections.all().find((entry) => entry.id === 'settingsSections.settings.integrations');
    expect(section).toMatchObject({ enabled: true, permission: { kind: 'staff', capability: 'integrations.manage' }, component: IntegrationsSettings });
  });
  it('shows where email goes without its password, and warns before a save changes sign-in', async () => {
    const user = userEvent.setup(); renderSection();
    expect(await screen.findByText(/No email service is set up/)).toBeDefined();
    expect(screen.getByText('Sign-in: passwords.')).toBeDefined();
    const form = await fill(user);
    expect(within(form).getByText('Saving changes sign-in to: email links.')).toBeDefined();
    expect((within(form).getByLabelText('SMTP host') as HTMLInputElement).value).toBe('smtp.postmarkapp.com');
    // The warning must be acknowledged before anything is sent.
    await user.click(within(form).getByRole('button', { name: 'Send test email and save' }));
    expect(client.PUT).not.toHaveBeenCalled();
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'sent', integrations: gymEmail } }));
    await user.click(within(form).getByRole('checkbox', { name: /I understand/ }));
    await user.click(within(form).getByRole('button', { name: 'Send test email and save' }));
    expect(client.PUT).toHaveBeenCalledWith('/api/settings/integrations/email', { signal: expect.any(AbortSignal), body: { revision: 3, host: 'smtp.postmarkapp.com', port: 587, secure: false,
      username: 'user', password: 'smtp-secret', from: 'desk@gym.test', testTo: 'owner@gym.test' } });
    expect((await screen.findByRole('status')).textContent).toContain('Test email sent');
    expect(screen.getByText('Sends through your own SMTP service: smtp.gym.test, port 465 (TLS), from desk@gym.test.')).toBeDefined();
    expect(document.body.textContent).not.toContain('smtp-secret');
  });
  it('says nothing was saved when the test email fails', async () => {
    const user = userEvent.setup(); renderSection();
    const form = await fill(user);
    await user.click(within(form).getByRole('checkbox', { name: /I understand/ }));
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'failed', integrations } }));
    await user.click(within(form).getByRole('button', { name: 'Send test email and save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('nothing was saved');
    expect(screen.getByRole('form', { name: 'Use your own SMTP service' })).toBeDefined();
  });
  it.each([
    [2525, true, /Implicit TLS is on, but the port isn't 465/],
    [465, false, /Port 465 usually needs implicit TLS/],
    [587, false, null],
  ] as const)('shows advice for port %i with implicit TLS %s and still sends the test', async (port, secure, hint) => {
    const user = userEvent.setup(); renderSection();
    const form = within(await fill(user));
    for (const [name, text] of [['SMTP host', /Your sending service's SMTP server/], ['Sender address', /The From address, on a domain your sending service has verified/]] as const) {
      const id = form.getByLabelText(name).getAttribute('aria-describedby');
      expect(document.getElementById(id ?? '')?.textContent).toMatch(text);
    }
    const portInput = form.getByLabelText('Port');
    const checkbox = form.getByRole('checkbox', { name: /Use TLS from the start/ });
    await user.clear(portInput);
    await user.type(portInput, String(port));
    if (secure) await user.click(checkbox);
    if (hint) expect(form.getByText(hint).getAttribute('aria-live')).toBe('polite');
    else expect(form.queryByText(/Implicit TLS is on|Port 465 usually needs implicit TLS/)).toBeNull();
    if (secure && hint) {
      await user.click(checkbox);
      expect(form.queryByText(hint)).toBeNull();
      await user.click(checkbox);
    }
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'failed', failure: 'authentication', integrations } }));
    await user.click(form.getByRole('checkbox', { name: /I understand/ }));
    await user.click(form.getByRole('button', { name: 'Send test email and save' }));
    expect(client.PUT).toHaveBeenCalledWith('/api/settings/integrations/email', expect.objectContaining({ body: expect.objectContaining({ port, secure }) }));
    expect((await screen.findByRole('alert')).textContent).toBe("The test email failed: the SMTP server refused the username or password, or it won't send mail without a login. Check the username, the password and the SMTP hostname. Nothing was saved.");
  });
  it('names the SMTP ports a multi-gym install accepts', async () => {
    const user = userEvent.setup(); renderSection();
    const form = await fill(user);
    await user.click(within(form).getByRole('checkbox', { name: /I understand/ }));
    client.PUT.mockResolvedValue(refusal(400, 'port', 'port_not_allowed'));
    await user.click(within(form).getByRole('button', { name: 'Send test email and save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Use an SMTP port: 25, 465, 587 or 2525.');
  });
  it('reloads a refusal after the operator takes over email and hides the form', async () => {
    const user = userEvent.setup(); renderSection();
    const form = await fill(user);
    await user.click(within(form).getByRole('checkbox', { name: /I understand/ }));
    client.PUT.mockImplementation(async () => { current = { ...integrations, integrationsEditable: false };
      return refusal(403, 'integrations', 'operator_managed'); });
    await user.click(within(form).getByRole('button', { name: 'Send test email and save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Whoever runs this install manages email, SMS and payments/);
    expect(screen.queryByRole('form', { name: 'Use your own SMTP service' })).toBeNull();
  });
  it('removes the gym’s settings after saying how sign-in changes', async () => {
    current = { ...gymEmail, email: { ...gymEmail.email, googleConfigured: true } };
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5, email: { ...integrations.email, source: 'none' } } }));
    const user = userEvent.setup(); renderSection();
    expect(await screen.findByText('Removing changes sign-in to: passwords.')).toBeDefined();
    expect(screen.getByText(/It does not check whether your account can use it/)).toBeDefined();
    await confirmRemoval(user);
    expect(client.DELETE).toHaveBeenCalledWith('/api/settings/integrations/email', { signal: expect.any(AbortSignal), body: { revision: 3 } });
    expect((await screen.findByRole('status')).textContent).toContain('removed');
  });
  it('asks before removing the gym’s email settings, and cancel sends nothing', async () => {
    current = { ...gymEmail, email: { ...gymEmail.email, signInAfterRemove: { password: false, magicLink: true } } };
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: installRemoval }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove your gym\'s email settings?' })).toBeDefined();
    expect(within(dialog).getByText(removalInstall)).toBeDefined();
    expect(within(dialog).getByText(removalSecret)).toBeDefined();
    expect(client.DELETE).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.DELETE).not.toHaveBeenCalled();
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5 } }));
    await confirmRemoval(user, installRemoval);
    expect(client.DELETE).toHaveBeenCalledExactlyOnceWith('/api/settings/integrations/email', { signal: expect.any(AbortSignal), body: { revision: 3 } });
  });
  it('names the methods left and the destructive button when no email remains', async () => {
    current = { ...gymEmail, email: { ...gymEmail.email, signIn: { magicLink: true, password: false },
      signInAfterRemove: { magicLink: false, password: true } } };
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: noEmailRemoval }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(removalNone)).toBeDefined();
    expect(within(dialog).getByText('Removing changes sign-in to: passwords.')).toBeDefined();
    expect(within(dialog).getByText(removalSecret)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: noEmailRemoval })).toBeDefined();
    expect(within(dialog).queryByText(removalInstall)).toBeNull();
  });
  it('names only the action in progress, and forgets a removed host', async () => {
    current = gymEmail;
    let sent: (value: unknown) => void = () => {};
    client.PUT.mockReturnValue(new Promise((resolve) => { sent = resolve; }));
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Change SMTP settings' }));
    const form = screen.getByRole('form', { name: 'Change SMTP settings' });
    expect((within(form).getByLabelText('SMTP host') as HTMLInputElement).value).toBe('smtp.gym.test');
    await user.type(within(form).getByLabelText('SMTP username'), 'user');
    await user.type(within(form).getByLabelText('SMTP password'), 'smtp-secret');
    await user.type(within(form).getByLabelText('Send the test email to'), 'owner@gym.test');
    await user.click(within(form).getByRole('button', { name: 'Send test email and save' }));
    expect(await within(form).findByRole('button', { name: 'Sending test email…' })).toBeDefined();
    // The test email is being sent, not the settings removed.
    const remove = screen.getByRole('button', { name: 'Remove (the gym will have no email)' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    sent(reply(200, { data: { test: 'failed', integrations: gymEmail } }));
    expect((await screen.findByRole('alert')).textContent).toContain('nothing was saved');
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5 } }));
    await confirmRemoval(user);
    expect((await screen.findByRole('status')).textContent).toContain('removed');
    const replace = screen.getByRole('form', { name: 'Use your own SMTP service' });
    expect((within(replace).getByLabelText('SMTP host') as HTMLInputElement).value).toBe('');
  });
  it('won’t remove email while it is the owner’s only way to sign in', async () => {
    current = { ...gymEmail, email: { ...gymEmail.email, removeBlocked: true } };
    const user = userEvent.setup(); renderSection();
    const button = await screen.findByRole('button', { name: 'Remove (the gym will have no email)' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/only way to sign in/)).toBeDefined();
    await user.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows the server’s refusal reason, never its message', async () => {
    current = gymEmail;
    client.DELETE.mockResolvedValue(refusal(409, 'email', 'only_sign_in'));
    const user = userEvent.setup(); renderSection();
    await confirmRemoval(user);
    expect((await screen.findByRole('alert')).textContent).toContain('only way to sign in');
    expect(document.body.textContent).not.toContain('private server text');
  });
  it('aborts a change that times out, reloads, and says it may still have gone through', async () => {
    current = gymEmail;
    const user = userEvent.setup(); renderSection();
    const remove = await screen.findByRole('button', { name: 'Remove (the gym will have no email)' });
    const stalled = stalledRequests(), timers = holdTimeouts();
    try {
      client.DELETE.mockImplementation(stalled.answer);
      await user.click(remove);
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: noEmailRemoval }));
      await vi.waitFor(() => expect(stalled.signals).toHaveLength(1));
      timers.expire();
      expect(stalled.signals[0]!.aborted).toBe(true);
      expect((await screen.findByRole('alert')).textContent).toContain('may still have gone through');
      expect(screen.queryByText(/The request failed/)).toBeNull();
    } finally { timers.restore(); }
  });
  it('words a conflict by whether the latest settings are shown', async () => {
    current = gymEmail;
    const user = userEvent.setup(); renderSection();
    client.DELETE.mockResolvedValue(reply(409));
    await confirmRemoval(user);
    // The gym revision didn't move: what the section shows stays.
    expect((await screen.findByRole('alert')).textContent).toContain('so this change wasn’t saved');
    // Another tab saved: the reload brings the latest settings.
    const read = client.GET.getMockImplementation()!;
    client.GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(200, { data: { ...settings, revision: 4 } }) : read(path));
    await confirmRemoval(user);
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The latest saved settings are shown'));
  });
});
