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
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../../lib/api.js', async original => ({ ...await original<typeof import('../../../lib/api.js')>(), api: client, createApiClient: () => client }));

const gymEmail: Integrations = { ...integrations, revision: 4, email: { source: 'gym', host: 'smtp.gym.test', port: 465, security: 'tls', from: 'desk@gym.test',
  signIn: { password: false, magicLink: true }, signInAfterSave: { password: false, magicLink: true },
  signInAfterRemove: { password: true, magicLink: false }, removeBlocked: false } };
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

describe('Settings → Email', () => {
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
    expect((await screen.findByRole('alert')).textContent).toMatch(/Whoever runs this install manages email and payments/);
    expect(screen.queryByRole('form', { name: 'Use your own SMTP service' })).toBeNull();
  });
  it('removes the gym’s settings after saying how sign-in changes', async () => {
    current = gymEmail;
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5, email: { ...integrations.email, source: 'none' } } }));
    const user = userEvent.setup(); renderSection();
    expect(await screen.findByText('Removing changes sign-in to: passwords.')).toBeDefined();
    expect(screen.getByText(/It does not check whether your account can use it/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Remove (the gym will have no email)' }));
    expect(client.DELETE).toHaveBeenCalledWith('/api/settings/integrations/email', { signal: expect.any(AbortSignal), body: { revision: 3 } });
    expect((await screen.findByRole('status')).textContent).toContain('removed');
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
    await user.click(screen.getByRole('button', { name: 'Remove (the gym will have no email)' }));
    expect((await screen.findByRole('status')).textContent).toContain('removed');
    const replace = screen.getByRole('form', { name: 'Use your own SMTP service' });
    expect((within(replace).getByLabelText('SMTP host') as HTMLInputElement).value).toBe('');
  });
  it('won’t remove email while it is the owner’s only way to sign in', async () => {
    current = { ...gymEmail, email: { ...gymEmail.email, removeBlocked: true } };
    renderSection();
    const button = await screen.findByRole('button', { name: 'Remove (the gym will have no email)' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/only way to sign in/)).toBeDefined();
  });
  it('shows the server’s refusal reason, never its message', async () => {
    current = gymEmail;
    client.DELETE.mockResolvedValue(refusal(409, 'email', 'only_sign_in'));
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Remove (the gym will have no email)' }));
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
    await user.click(await screen.findByRole('button', { name: 'Remove (the gym will have no email)' }));
    // The gym revision didn't move: what the section shows stays.
    expect((await screen.findByRole('alert')).textContent).toContain('so this change wasn’t saved');
    // Another tab saved: the reload brings the latest settings.
    const read = client.GET.getMockImplementation()!;
    client.GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(200, { data: { ...settings, revision: 4 } }) : read(path));
    await user.click(screen.getByRole('button', { name: 'Remove (the gym will have no email)' }));
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The latest saved settings are shown'));
  });
});
