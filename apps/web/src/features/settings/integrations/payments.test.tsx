// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Integrations } from '@plaingym/shared/contracts';
import { health, integrations, refusal, renderSection, reply, serve } from './fixtures.test-helper.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../../lib/api.js', () => ({ api: client, createApiClient: () => client }));

const connected: Integrations = { ...integrations, revision: 4, payments: { configured: true, mode: 'test', webhookRegistered: true, accountLocked: true,
  testData: { customers: 3, cards: 2, checkouts: 1, payments: 4, importedCustomers: 5, importedCards: 6 }, importedCustomersOnly: false } };
const live: Integrations = { ...connected, revision: 5, payments: { ...connected.payments, mode: 'live', accountLocked: false, testData: null } };
let current: Integrations;
beforeEach(() => { for (const fn of Object.values(client)) fn.mockReset(); current = integrations; serve(client.GET, () => current, health('2026-11-02T11:00:00Z', null)); });
afterEach(cleanup);
const form = async () => screen.findByRole('form', { name: 'Payments' });
async function submit(user: ReturnType<typeof userEvent.setup>, key: string) {
  const payments = await form();
  await user.type(within(payments).getByLabelText('Restricted Stripe key'), key);
  await user.click(within(payments).getByRole('button', { name: 'Check and save key' }));
  return payments;
}

describe('Settings → Payments', () => {
  it('connects a key with the shared revision and shows the mode and webhook status, never the key', async () => {
    client.PUT.mockResolvedValue(reply(200, { data: connected }));
    const user = userEvent.setup(); renderSection();
    expect(await screen.findByText(/Stripe isn’t connected/)).toBeDefined();
    const payments = await submit(user, 'rk_test_abc123');
    expect(client.PUT).toHaveBeenCalledWith('/api/settings/integrations/stripe', { body: { revision: 3, restrictedKey: 'rk_test_abc123' } });
    expect((await screen.findByRole('status')).textContent).toBe('The new Stripe key is saved.');
    expect(screen.getByText('Stripe is connected in test mode.')).toBeDefined();
    expect(screen.getByText(/Webhook endpoint registered/)).toBeDefined();
    expect(screen.getByText(/A new test key must be for the same Stripe account/)).toBeDefined();
    expect((within(payments).getByLabelText('Restricted Stripe key') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('rk_test_abc123');
  });
  it('shows the last Stripe event from the health checks', async () => {
    current = connected; renderSection();
    expect(await screen.findByText(/Last Stripe event received/)).toBeDefined();
    expect(client.GET).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }));
  });
  it('refuses a malformed key without sending it', async () => {
    const user = userEvent.setup(); renderSection();
    await submit(user, 'sk_test_secret');
    expect((await screen.findByRole('alert')).textContent).toContain('rk_test_');
    expect(client.PUT).not.toHaveBeenCalled();
  });
  it.each([['account_locked', 'rk_test_other', 'another account can’t charge or refund them'], ['missing_permission', 'rk_live_other', 'permissions'],
    ['payments_in_progress', 'rk_test_other', 'still being processed']])(
    'explains a %s refusal', async (code, key, words) => {
      current = connected;
      client.PUT.mockResolvedValue(refusal(code === 'missing_permission' ? 400 : 409, 'restrictedKey', code));
      const user = userEvent.setup(); renderSection();
      await submit(user, key);
      expect((await screen.findByRole('alert')).textContent).toContain(words);
      expect(document.body.textContent).not.toContain('private server text');
      expect(screen.queryByRole('form', { name: 'Switch to live mode' })).toBeNull();
    });
  it('lists what a switch from test to live clears and keeps, and sends the key again only once confirmed', async () => {
    current = connected;
    client.PUT.mockResolvedValueOnce(refusal(409, 'restrictedKey', 'mode_locked'));
    const user = userEvent.setup(); renderSection();
    expect(await screen.findByText(/A live key can replace it once you confirm/)).toBeDefined();
    await submit(user, 'rk_live_abc123');
    const confirm = await screen.findByRole('form', { name: 'Switch to live mode' });
    expect(screen.queryByRole('form', { name: 'Payments' })).toBeNull();
    for (const line of ['Households’ test Stripe customers: 3.', 'Saved test cards: 2.', 'Open Stripe payment and card pages: 1.', 'Test card payments: 4.'])
      expect(within(confirm).getByText(new RegExp(line.replace('.', '\\.')))).toBeDefined();
    expect(within(confirm).getByText(/marked “Stripe test mode”/)).toBeDefined();
    // Imported references are listed as kept: they may be the gym's live customers and cards.
    expect(within(confirm).getByText(/Imported Stripe customers: 5, and imported cards: 6\./)).toBeDefined();
    expect(document.body.textContent).not.toContain('rk_live_abc123');
    // Nothing is sent until the owner ticks the confirmation.
    await user.click(within(confirm).getByRole('button', { name: 'Clear test data and switch to live' }));
    expect(client.PUT).toHaveBeenCalledTimes(1);
    client.PUT.mockResolvedValueOnce(reply(200, { data: live }));
    await user.click(within(confirm).getByRole('checkbox', { name: /I understand the test data/ }));
    await user.click(within(confirm).getByRole('button', { name: 'Clear test data and switch to live' }));
    expect(client.PUT).toHaveBeenLastCalledWith('/api/settings/integrations/stripe', { body: { revision: 3, restrictedKey: 'rk_live_abc123', clearTestData: true } });
    expect((await screen.findByRole('status')).textContent).toContain('Stripe is now in live mode');
    expect(screen.getByText('Stripe is connected in live mode.')).toBeDefined();
    expect(screen.queryByRole('form', { name: 'Switch to live mode' })).toBeNull();
    expect(await screen.findByRole('form', { name: 'Payments' })).toBeDefined();
  });
  it('drops the waiting live key when the owner keeps test mode', async () => {
    current = connected;
    client.PUT.mockResolvedValueOnce(refusal(409, 'restrictedKey', 'mode_locked'));
    const user = userEvent.setup(); renderSection();
    await submit(user, 'rk_live_abc123');
    const confirm = await screen.findByRole('form', { name: 'Switch to live mode' });
    await user.click(within(confirm).getByRole('button', { name: 'Keep test mode' }));
    expect(await screen.findByRole('form', { name: 'Payments' })).toBeDefined();
    expect(client.PUT).toHaveBeenCalledTimes(1);
  });
  it('refuses a test key for a live gym without offering a switch', async () => {
    current = { ...live, payments: { ...live.payments, accountLocked: true } };
    client.PUT.mockResolvedValue(refusal(409, 'restrictedKey', 'mode_locked'));
    const user = userEvent.setup(); renderSection();
    await submit(user, 'rk_test_back');
    expect((await screen.findByRole('alert')).textContent).toContain('a test key can’t replace the live one');
    expect(screen.queryByRole('form', { name: 'Switch to live mode' })).toBeNull();
  });
  it('says a key from any account is accepted while only imported customer IDs exist', async () => {
    current = { ...integrations, payments: { ...integrations.payments, importedCustomersOnly: true } };
    renderSection();
    const note = await screen.findByText(/With a live key, customers the account can’t read get new ones the first time they pay or save a card/);
    expect(note.textContent).toContain('A test key can’t read live customers');
  });
  it('says Stripe couldn’t check the key when it is unreachable', async () => {
    client.PUT.mockResolvedValue(reply(503, { error: { code: 'unavailable', message: 'private server text' }, requestId: 'r' }));
    const user = userEvent.setup(); renderSection();
    await submit(user, 'rk_test_abc');
    expect((await screen.findByRole('alert')).textContent).toContain('couldn’t check the key');
  });
});
