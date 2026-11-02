// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Integrations } from '@plaingym/shared/contracts';
import { health, integrations, refusal, renderSection, reply, serve } from './fixtures.test-helper.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../../lib/api.js', () => ({ api: client, createApiClient: () => client }));

const connected: Integrations = { ...integrations, revision: 4, payments: { configured: true, mode: 'test', webhookRegistered: true, accountLocked: true } };
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
    expect(screen.getByText(/same Stripe account and mode/)).toBeDefined();
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
  it.each([['account_locked', 'another Stripe account'], ['mode_locked', 'between test and live'], ['missing_permission', 'permissions']])(
    'explains a %s refusal', async (code, words) => {
      current = connected;
      client.PUT.mockResolvedValue(refusal(code === 'missing_permission' ? 400 : 409, 'restrictedKey', code));
      const user = userEvent.setup(); renderSection();
      await submit(user, 'rk_live_other');
      expect((await screen.findByRole('alert')).textContent).toContain(words);
      expect(document.body.textContent).not.toContain('private server text');
    });
  it('says Stripe couldn’t check the key when it is unreachable', async () => {
    client.PUT.mockResolvedValue(reply(503, { error: { code: 'unavailable', message: 'private server text' }, requestId: 'r' }));
    const user = userEvent.setup(); renderSection();
    await submit(user, 'rk_test_abc');
    expect((await screen.findByRole('alert')).textContent).toContain('couldn’t check the key');
  });
});
