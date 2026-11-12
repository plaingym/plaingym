// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Integrations } from '@plaingym/shared/contracts';
import { health, integrations, refusal, renderSection, reply, serve } from './fixtures.test-helper.js';
import { destinationCheckTimeoutMs } from './backups.js';
import { saveTimeoutMs } from '../gym-settings.js';
import { holdTimeouts, stalledRequests } from '../save-timeout.test-helper.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../../lib/api.js', () => ({ api: client, createApiClient: () => client }));

const privateKey = 'AGE-SECRET-KEY-1PRIVATEEXAMPLE', publicKey = 'age1newpublickey';
const destination = { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'gym-backups' };
const configured: Integrations = { ...integrations, revision: 4, backups: { configured: true, destination, publicKey: 'age1currentkey', pending: null, retentionBudgetBytes: 8_000_000_000 } };
const pending: Integrations = { ...configured, revision: 5, backups: { ...configured.backups!, pending: { destination: { ...destination, bucket: 'new-bucket' }, publicKey } } };
let current: Integrations;
beforeEach(() => { for (const fn of Object.values(client)) fn.mockReset(); current = integrations; serve(client.GET, () => current, health(null, '2026-11-02T11:00:00Z')); });
afterEach(cleanup);

describe('Settings → Backups', () => {
  it('refreshes health after confirming a new key and drops the old-key snapshot', async () => {
    current = pending;
    let changed = false;
    const after = health(null, null);
    Object.assign(after.data.tiles[0]!.details!, { noneUnderCurrentKey: true });
    const originalGet = client.GET.getMockImplementation()!;
    client.GET.mockImplementation((path: string) => path === '/api/health' && changed ? reply(200, after) : originalGet(path));
    client.POST.mockImplementation(async () => {
      changed = true;
      current = { ...configured, revision: 6, backups: { ...configured.backups!, publicKey } };
      return reply(200, { data: current });
    });
    const user = userEvent.setup(); renderSection();
    expect(await screen.findByText(/Last restorable snapshot/)).toBeDefined();
    const confirm = screen.getByRole('form', { name: 'Confirm and start using it' });
    await user.type(within(confirm).getByLabelText('Paste your saved private key'), privateKey);
    await user.click(within(confirm).getByRole('checkbox', { name: /I saved my private key/ }));
    await user.click(within(confirm).getByRole('button', { name: 'Check the saved key' }));
    expect(await screen.findByText('No restorable snapshot under this key at the current destination yet.')).toBeDefined();
    expect(screen.queryByText(/Last restorable snapshot/)).toBeNull();
  });
  it('waits longer than other saves while the destination is checked', async () => {
    expect(destinationCheckTimeoutMs).toBeGreaterThan(saveTimeoutMs);
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Set up backups' }));
    const setup = screen.getByRole('form', { name: 'Set up backups' });
    await user.type(within(setup).getByLabelText('Storage endpoint URL'), 'https://s3.example.test');
    await user.type(within(setup).getByLabelText('Bucket'), 'new-bucket');
    await user.type(within(setup).getByLabelText('Storage access key ID'), 'access-id');
    await user.type(within(setup).getByLabelText('Storage secret access key'), 'access-secret');
    const stalled = stalledRequests(), timers = holdTimeouts(saveTimeoutMs, destinationCheckTimeoutMs);
    try {
      client.POST.mockImplementation(stalled.answer);
      await user.click(within(setup).getByRole('button', { name: 'Generate backup key' }));
      await vi.waitFor(() => expect(stalled.signals).toHaveLength(1));
      expect(timers.held(saveTimeoutMs)).toBe(0);
      expect(timers.held(destinationCheckTimeoutMs)).toBe(1);
    } finally { timers.restore(); }
  });
  it('sets up backups through the same two steps as setup: the private key is shown once, then confirmed', async () => {
    client.POST.mockResolvedValueOnce(reply(200, { data: { privateKey, publicKey, integrations: { ...pending, backups: { ...pending.backups!, configured: false, destination: null, publicKey: null } } } }))
      .mockResolvedValueOnce(reply(200, { data: { ...configured, revision: 6, backups: { ...configured.backups!, publicKey } } }));
    const user = userEvent.setup(); renderSection();
    expect(await screen.findByText(/Updates refuse to run until they are/)).toBeDefined();
    expect(screen.getByText(/Retention budget: 8 GB/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Set up backups' }));
    const setup = screen.getByRole('form', { name: 'Set up backups' });
    await user.type(within(setup).getByLabelText('Storage endpoint URL'), 'https://s3.example.test');
    await user.type(within(setup).getByLabelText('Bucket'), 'new-bucket');
    await user.type(within(setup).getByLabelText('Storage access key ID'), 'access-id');
    await user.type(within(setup).getByLabelText('Storage secret access key'), 'access-secret');
    await user.click(within(setup).getByRole('button', { name: 'Generate backup key' }));
    expect(client.POST).toHaveBeenCalledWith('/api/settings/integrations/backups', { signal: expect.any(AbortSignal), body: { revision: 3, destination: { endpoint: 'https://s3.example.test',
      region: 'auto', bucket: 'new-bucket', accessKeyId: 'access-id', secretAccessKey: 'access-secret' } } });
    expect(await screen.findByText(privateKey)).toBeDefined();
    expect(screen.getByText(/It is shown only once/)).toBeDefined();
    // The parts are labelled, the key wraps, and the confirmation is its own section.
    expect(screen.getByRole('group', { name: 'Backup private key: keep it secret' }).textContent).toContain(privateKey);
    expect(screen.getByText(privateKey).className).toMatch(/break-all/);
    expect(screen.getByRole('group', { name: 'Public key: snapshots are encrypted to it; safe to share' }).textContent).toContain(publicKey);
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeDefined();
    expect(within(screen.getByRole('region', { name: 'Confirm you saved the key' })).getByText(/Paste the private key from where you stored it/)).toBeDefined();
    expect(screen.queryByText(/this key is replaced/)).toBeNull();
    expect(screen.getByText(/wait for you to confirm the private key/)).toBeDefined();
    const confirm = screen.getByRole('form', { name: 'Confirm and start using it' });
    await user.type(within(confirm).getByLabelText('Paste your saved private key'), privateKey);
    // Nothing is sent until the owner says they saved the key.
    await user.click(within(confirm).getByRole('button', { name: 'Check the saved key' }));
    expect(client.POST).toHaveBeenCalledTimes(1);
    await user.click(within(confirm).getByRole('checkbox', { name: /I saved my private key/ }));
    await user.click(within(confirm).getByRole('button', { name: 'Check the saved key' }));
    expect(client.POST).toHaveBeenLastCalledWith('/api/settings/integrations/backups/confirm', { signal: expect.any(AbortSignal), body: { revision: 5, privateKey } });
    expect((await screen.findByRole('status')).textContent).toContain('now use the new destination');
    expect(document.body.textContent).not.toContain(privateKey);
    expect(document.body.textContent).not.toContain('access-secret');
  });
  it('shows the current destination, last snapshot and what happens to old snapshots after a change', async () => {
    current = configured; renderSection();
    expect(await screen.findByText('Snapshots go to bucket gym-backups at https://s3.example.test.')).toBeDefined();
    expect(await screen.findByText(/Last restorable snapshot/)).toBeDefined();
    expect(screen.getByText(/readable only with that key until retention removes them.*no longer manages the old one/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Change destination or key' })).toBeDefined();
  });
  it('says a destination that refused its credentials changed nothing', async () => {
    client.POST.mockResolvedValue(refusal(400, 'destination', 'unreachable'));
    const user = userEvent.setup(); renderSection();
    await user.click(await screen.findByRole('button', { name: 'Set up backups' }));
    const setup = screen.getByRole('form', { name: 'Set up backups' });
    for (const [field, value] of [['Storage endpoint URL', 'https://typo.example.test'], ['Bucket', 'b'], ['Storage access key ID', 'id'], ['Storage secret access key', 's']])
      await user.type(within(setup).getByLabelText(field!), value!);
    await user.click(within(setup).getByRole('button', { name: 'Generate backup key' }));
    expect((await screen.findByRole('alert')).textContent).toContain('nothing was changed');
    expect(screen.queryByText(/It is shown only once/)).toBeNull();
  });
  it('explains a key that doesn’t match the pending one', async () => {
    current = pending;
    client.POST.mockResolvedValue(refusal(400, 'privateKey', 'mismatch'));
    const user = userEvent.setup(); renderSection();
    const confirm = await screen.findByRole('form', { name: 'Confirm and start using it' });
    await user.type(within(confirm).getByLabelText('Paste your saved private key'), 'AGE-SECRET-KEY-1WRONG');
    await user.click(within(confirm).getByRole('checkbox', { name: /I saved my private key/ }));
    await user.click(within(confirm).getByRole('button', { name: 'Check the saved key' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("This key doesn't match the one shown. Paste the whole key, starting with AGE-SECRET-KEY-.");
    // The error variant, focused so an owner scrolled down sees it.
    expect(alert.dataset.variant).toBe('error');
    await vi.waitFor(() => expect(document.activeElement).toBe(alert));
  });
  it('has no backups part in multi-gym mode, and nothing to change in a sandbox', async () => {
    current = { ...integrations, backups: null }; renderSection();
    expect(await screen.findByRole('heading', { name: 'Email' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Backups' })).toBeNull();
    cleanup();
    current = { ...integrations, backups: null, sandbox: true }; renderSection();
    expect(await screen.findByText(/This sandbox sends email to the demo outbox/)).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Email' })).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });
});
