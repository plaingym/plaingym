// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Integrations } from '@plaingym/shared/contracts';
import { integrations, settings, renderSection, reply, serve } from './fixtures.test-helper.js';
import { useGymSettings } from '../gym-settings.js';

const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() }));
vi.mock('../../../lib/api.js', async original => ({ ...await original<typeof import('../../../lib/api.js')>(), api: client, createApiClient: () => client }));
const accountSid = 'AC' + '1'.repeat(32), apiKey = 'SK' + '2'.repeat(32), messagingServiceSid = 'MG' + '3'.repeat(32);
const configured: Integrations = { ...integrations, revision: 4, sms: { ...integrations.sms, configured: true, accountSid,
  authKind: 'token', from: '+14155552671' } };
const authenticationFailure = 'Twilio denied access. Check the Account SID and copy the live auth token or API key credentials from the Twilio Console. If you use an API key, check that it can list and send messages. A new or upgraded Twilio account is also refused until its Primary Customer Profile is approved in Twilio’s Trust Hub. Nothing was saved.';
const trialAccountFailure = 'A Twilio trial account can send only Twilio templates to verified numbers. Upgrade a trial account to send this test text. If your account is already upgraded, verify the test number or get its Primary Customer Profile approved in Twilio’s Trust Hub. The account also needs its own SMS-capable number as the sender. Nothing was saved.';
const invalidPhone = 'Enter a valid phone number. Start it with + and its country code (for example +1 604 555 0123), or set the gym\'s country code in Settings → Gym details.';
const noCountryHint = 'Your gym has no country code set in Settings → Gym details, so a test number without + uses the From number\'s country code.';
const setupHint = 'Use your gym’s own upgraded Twilio account and an SMS-capable number it owns. Register your sender with the provider before sending. Each text, including this test, costs your gym.';
const removalBody = 'Member texts stop: booking and billing notices, announcements and texted links aren\'t sent until you connect a provider again.';
const removalSecret = 'The stored credentials are deleted and can\'t be shown again. To undo this, enter them again.';
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
function OtherSettingsSave() {
  const gym = useGymSettings();
  return <button onClick={() => void gym.save(async () => reply(200, { data: { ...settings, revision: 4, websiteEnabled: true } }))}>Save website</button>;
}
describe('SMS integration form', () => {
  it('keeps a typed cap after another section saves, then saves it with the latest revision', async () => {
    const user = userEvent.setup(); renderSection(<OtherSettingsSave/>);
    const field = await screen.findByRole('spinbutton', { name: 'Daily text cap' });
    await user.clear(field); await user.type(field, '25');
    await user.click(screen.getByRole('button', { name: 'Save website' }));
    expect(screen.getByRole('spinbutton', { name: 'Daily text cap' })).toBe(field);
    expect((field as HTMLInputElement).value).toBe('25');
    client.PATCH.mockResolvedValue(reply(200, { data: { ...settings, revision: 5, smsDailyCap: 25 } }));
    await user.click(screen.getByRole('button', { name: 'Save daily text cap' }));
    await screen.findByRole('status');
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/integrations/sms/cap', { signal: expect.any(AbortSignal), body: { revision: 4, smsDailyCap: 25 } });
  });
  it('shows a cap saved elsewhere once the settings are read again', async () => {
    const user = userEvent.setup(); renderSection();
    const field = await screen.findByRole('spinbutton', { name: 'Daily text cap' });
    await user.clear(field); await user.type(field, '25');
    const base = client.GET.getMockImplementation()!;
    client.GET.mockImplementation(async (path: string) => path === '/api/settings'
      ? reply(200, { data: { ...settings, revision: 6, smsDailyCap: 500 } }) : base(path));
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByDisplayValue('500')).toBeDefined();
  });
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
  it.each(['token', 'apiKey'] as const)('trims a pasted credential: %s', async authKind => {
    const user = userEvent.setup(); renderSection(); const form = await fill(user);
    if (authKind === 'token') {
      const token = within(form).getByLabelText('Auth token');
      await user.clear(token); await user.type(token, ' tok ');
    } else {
      await user.selectOptions(within(form).getByLabelText('Authentication method'), 'apiKey');
      await user.type(within(form).getByLabelText('API key SID'), apiKey);
      await user.type(within(form).getByLabelText('API key secret'), ' sec ');
    }
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'failed', integrations: current } }));
    await user.click(within(form).getByRole('button', { name: 'Send test text and save' }));
    expect(client.PUT.mock.calls[0]?.[1].body).toMatchObject({ auth: authKind === 'token' ? { token: 'tok' } : { apiKey, secret: 'sec' } });
  });
  it.each([
    ['unreachable', /No response arrived.*text may have been sent/],
    [undefined, /The account check or test text failed\. Check your credentials/],
  ] as const)('names the cause of a failed test: %s', async (failure, shown) => {
    const user = userEvent.setup(); renderSection(); const form = await fill(user);
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'failed', ...(failure ? { failure } : {}), integrations: current } }));
    await user.click(within(form).getByRole('button', { name: 'Send test text and save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(shown);
  });
  it.each([
    ['authentication', authenticationFailure],
    ['trial_account', trialAccountFailure],
  ] as const)('shows the whole %s failure message', async (failure, shown) => {
    const user = userEvent.setup(); renderSection(); const form = await fill(user);
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'failed', failure, integrations: current } }));
    await user.click(within(form).getByRole('button', { name: 'Send test text and save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(shown);
  });
  it('shows the whole setup hint when the section is editable', async () => {
    renderSection();
    expect(await screen.findByText(setupHint)).toBeDefined();
  });
  it('names both ways to fix a refused phone number', async () => {
    const user = userEvent.setup(); renderSection(); const form = await fill(user);
    client.PUT.mockResolvedValue(reply(400, { error: { code: 'invalid_request', message: 'x', details: { phone: ['invalid_phone'] } } }));
    await user.click(within(form).getByRole('button', { name: 'Send test text and save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(invalidPhone);
  });
  it('explains the calling code it assumes while the gym has no country', async () => {
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Connect SMS provider' }));
    expect(await screen.findByText(noCountryHint)).toBeDefined();
    await user.selectOptions(screen.getByLabelText('Send using'), 'service');
    expect(screen.queryByText(noCountryHint)).toBeNull();
  });
  it('shows no calling code hint when the gym country is set', async () => {
    const base = client.GET.getMockImplementation()!;
    client.GET.mockImplementation(async (path: string) => path === '/api/settings'
      ? reply(200, { data: { ...settings, address: { country: 'CA' } } }) : base(path));
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Connect SMS provider' }));
    expect(screen.queryByText(noCountryHint)).toBeNull();
  });
  it('directs owners to the submitted custom provider for authentication failures', async () => {
    const user = userEvent.setup(); renderSection(); const form = await fill(user);
    const url = within(form).getByLabelText('Provider base URL (HTTPS)');
    await user.clear(url); await user.type(url, 'https://provider.invalid');
    client.PUT.mockResolvedValue(reply(200, { data: { test: 'failed', failure: 'authentication', integrations: current } }));
    await user.click(within(form).getByRole('button', { name: 'Send test text and save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('credentials issued by the provider at the configured URL');
    expect(alert.textContent).not.toContain('Twilio');
  });
  it('removes stored credentials through the shared revision queue', async () => {
    current = configured; const user = userEvent.setup(); renderSection();
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5 } }));
    await user.click(await screen.findByRole('button', { name: 'Remove SMS provider' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove SMS provider' }));
    expect(client.DELETE).toHaveBeenCalledWith('/api/settings/integrations/sms', { signal: expect.any(AbortSignal), body: { revision: 3 } });
    expect((await screen.findByRole('status')).textContent).toContain('SMS credentials are removed');
  });
  it('asks before removing a configured provider and sends nothing until confirmed', async () => {
    current = configured; const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Remove SMS provider' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove the SMS provider?' })).toBeDefined();
    expect(within(dialog).getByText(removalBody)).toBeDefined();
    expect(within(dialog).getByText(removalSecret)).toBeDefined();
    expect(client.DELETE).not.toHaveBeenCalled();
  });
  it('sends nothing when the removal dialog is cancelled or dismissed', async () => {
    current = configured; const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Remove SMS provider' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.DELETE).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove SMS provider' }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.DELETE).not.toHaveBeenCalled();
  });
  it('sends one removal after confirmation, even on a double click', async () => {
    current = configured; const user = userEvent.setup(); renderSection();
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5 } }));
    await user.click(await screen.findByRole('button', { name: 'Remove SMS provider' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove SMS provider' });
    await user.dblClick(confirm);
    expect(client.DELETE).toHaveBeenCalledExactlyOnceWith('/api/settings/integrations/sms', { signal: expect.any(AbortSignal), body: { revision: 3 } });
    expect((await screen.findByRole('status')).textContent).toBe('SMS credentials are removed.');
  });
  it('asks before removing unreadable settings too', async () => {
    current = { ...integrations, sms: { ...integrations.sms, unreadable: true } }; const user = userEvent.setup(); renderSection();
    expect((await screen.findByRole('alert')).textContent).toContain('stored SMS settings could not be read');
    await user.click(screen.getByRole('button', { name: 'Remove SMS provider' }));
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Remove the SMS provider?' })).toBeDefined();
    client.DELETE.mockResolvedValue(reply(200, { data: { ...integrations, revision: 5 } }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove SMS provider' }));
    expect(client.DELETE).toHaveBeenCalledExactlyOnceWith('/api/settings/integrations/sms', { signal: expect.any(AbortSignal), body: { revision: 3 } });
  });
  it('keeps both removal-row buttons content width on a phone', async () => {
    current = configured; renderSection();
    const remove = await screen.findByRole('button', { name: 'Remove SMS provider' });
    const change = screen.getByRole('button', { name: 'Change SMS settings' });
    const row = remove.parentElement!;
    expect(change.parentElement).toBe(row);
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('items-start');
    expect(row.className).toContain('sm:flex-row');
    expect(remove.className).not.toContain('w-full');
    expect(change.className).not.toContain('w-full');
  });
  it.each(['operator', 'sandbox'])('offers no credential form for %s settings', async mode => {
    current = { ...configured, integrationsEditable: mode !== 'operator', sandbox: mode === 'sandbox' };
    const user = userEvent.setup(); renderSection();
    await screen.findByRole('heading', { name: 'Integrations' });
    expect(screen.queryByRole('button', { name: 'Change SMS settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove SMS provider' })).toBeNull();
    // A sandbox texts through the demo outbox, so it names no provider.
    expect(screen.queryByText(/^Twilio account /) === null).toBe(mode === 'sandbox');
    const field = await screen.findByRole('spinbutton', { name: 'Daily text cap' });
    await user.clear(field); await user.type(field, '12');
    client.PATCH.mockResolvedValue(reply(200, { data: { ...settings, revision: 4, smsDailyCap: 12 } }));
    await user.click(screen.getByRole('button', { name: 'Save daily text cap' }));
    expect((await screen.findByRole('status')).textContent).toContain('daily text cap is saved');
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/integrations/sms/cap', { signal: expect.any(AbortSignal), body: { revision: 3, smsDailyCap: 12 } });
  });
});
