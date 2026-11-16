// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Integrations } from '@plaingym/shared/contracts';
import { integrations, settings, renderSection, reply, serve } from './fixtures.test-helper.js';

const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() }));
vi.mock('../../../lib/api.js', async original => ({ ...await original<typeof import('../../../lib/api.js')>(), api: client, createApiClient: () => client }));
const accountSid = 'AC' + '1'.repeat(32), apiKey = 'SK' + '2'.repeat(32), messagingServiceSid = 'MG' + '3'.repeat(32);
const configured: Integrations = { ...integrations, revision: 4, sms: { ...integrations.sms, configured: true, accountSid,
  authKind: 'token', from: '+14155552671' } };
let current: Integrations;
beforeEach(() => { for (const fn of Object.values(client)) fn.mockReset(); current = integrations; serve(client.GET, () => current); });
afterEach(cleanup);
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Connect SMS provider' }));
  const form = screen.getByRole('form', { name: 'SMS provider settings' });
  await user.type(within(form).getByLabelText('Account SID'), accountSid);
  await user.type(within(form).getByLabelText('Auth token'), 'sms-token');
  await user.type(within(form).getByLabelText('From phone number'), '+14155552671');
  await user.type(within(form).getByLabelText('Send the test text to'), '+12025550123');
  return form;
}
describe('SMS integration form', () => {
  it('saves the cap through the shared settings revision, without sending a provider test', async () => {
    const user = userEvent.setup(); renderSection();
    const field = await screen.findByRole('spinbutton', { name: 'Daily text cap' });
    expect((field as HTMLInputElement).value).toBe('1000');
    expect(field.getAttribute('min')).toBe('1'); expect(field.getAttribute('max')).toBe('100000');
    await user.clear(field); await user.type(field, '12');
    client.PATCH.mockResolvedValue(reply(200, { data: { ...settings, revision: 4, smsDailyCap: 12 } }));
    await user.click(screen.getByRole('button', { name: 'Save daily text cap' }));
    expect(client.PATCH).toHaveBeenCalledExactlyOnceWith('/api/settings/integrations/sms/cap', { signal: expect.any(AbortSignal), body: { revision: 3, smsDailyCap: 12 } });
    expect((await screen.findByRole('status')).textContent).toContain('daily text cap is saved');
    expect(client.PUT).not.toHaveBeenCalled();
  });
  it('sends the typed recipient and clears the secret after saving', async () => {
    const user = userEvent.setup(); renderSection(); const form = await fill(user);
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'sent', integrations: configured } }));
    await user.click(within(form).getByRole('button', { name: 'Send test text and save' }));
    expect(client.PUT).toHaveBeenCalledExactlyOnceWith('/api/settings/integrations/sms', { signal: expect.any(AbortSignal), body: {
      revision: 3, provider: 'twilio', accountSid, auth: { token: 'sms-token' }, sender: { from: '+14155552671' },
      testTo: '+12025550123', baseUrl: 'https://api.twilio.com',
    } });
    expect((await screen.findByRole('status')).textContent).toContain('SMS settings are saved');
    expect(screen.getByText(/Credentials are stored securely/)).toBeDefined();
    expect(screen.queryByLabelText('Auth token')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Change SMS settings' }));
    expect((screen.getByLabelText('Auth token') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Send the test text to') as HTMLInputElement).value).toBe('');
  });
  it('supports API credentials and a Messaging Service sender with no custom URL in multi mode', async () => {
    const { baseUrl, ...sms } = integrations.sms; expect(baseUrl).toBeDefined(); current = { ...integrations, sms };
    const user = userEvent.setup(); renderSection(); const form = await fill(user);
    await user.selectOptions(within(form).getByLabelText('Authentication method'), 'apiKey');
    await user.type(within(form).getByLabelText('API key SID'), apiKey);
    await user.type(within(form).getByLabelText('API key secret'), 'sms-secret');
    await user.selectOptions(within(form).getByLabelText('Send using'), 'service');
    await user.type(within(form).getByLabelText('Messaging Service SID'), messagingServiceSid);
    expect(within(form).queryByLabelText('Provider base URL (HTTPS)')).toBeNull();
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'failed', integrations: current } }));
    await user.click(within(form).getByRole('button', { name: 'Send test text and save' }));
    expect(client.PUT.mock.calls[0]?.[1].body).toMatchObject({ auth: { apiKey, secret: 'sms-secret' }, sender: { messagingServiceSid }, testTo: '+12025550123' });
    expect(client.PUT.mock.calls[0]?.[1].body).not.toHaveProperty('baseUrl');
    expect((await screen.findByRole('alert')).textContent).toContain('nothing was saved');
  });
  it('removes stored credentials through the shared revision queue', async () => {
    current = configured; const user = userEvent.setup(); renderSection();
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5 } }));
    await user.click(await screen.findByRole('button', { name: 'Remove SMS provider' }));
    expect(client.DELETE).toHaveBeenCalledWith('/api/settings/integrations/sms', { signal: expect.any(AbortSignal), body: { revision: 3 } });
    expect((await screen.findByRole('status')).textContent).toContain('SMS credentials are removed');
  });
  it('shows unreadable status and offers removal', async () => {
    current = { ...integrations, sms: { ...integrations.sms, unreadable: true } }; renderSection();
    expect((await screen.findByRole('alert')).textContent).toContain('stored SMS settings could not be read');
    expect(screen.getByRole('button', { name: 'Remove SMS provider' })).toBeDefined();
  });
  it.each(['operator', 'sandbox'])('offers no credential form for %s settings', async mode => {
    current = { ...configured, integrationsEditable: mode !== 'operator', sandbox: mode === 'sandbox' }; renderSection();
    await screen.findByRole('heading', { name: 'Integrations' });
    expect(screen.queryByRole('button', { name: 'Change SMS settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove SMS provider' })).toBeNull();
  });
});
