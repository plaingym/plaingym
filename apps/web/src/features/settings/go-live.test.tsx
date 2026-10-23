// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { goLiveChecklistItemSchema } from '@plaingym/shared/contracts';
import { GoLiveSettings } from './go-live.js';
import { registration } from './go-live.registrations.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: client }));
const ids = goLiveChecklistItemSchema.shape.id.options;
const checklist = (revision = 3, billingEnabled = false, memberEmailsEnabled = false) => ({ data: { revision, billingEnabled, memberEmailsEnabled,
  items: ids.map((id) => ({ id, status: id === 'smtp_ready' ? 'needs_attention' : id.startsWith('cards') ? 'not_applicable' : 'ready', message: 'Message for ' + id })) } });
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
beforeEach(() => { client.GET.mockReset(); client.PATCH.mockReset(); client.GET.mockResolvedValue(reply(200, checklist())); });
afterEach(cleanup);
describe('go-live settings', () => {
  it('registers an enabled section for go-live managers', () => {
    expect(registration.settingsSections?.[0]).toMatchObject({ enabled: true,
      permission: { kind: 'staff', capability: 'go_live.manage' }, component: GoLiveSettings });
  });
  it('renders both switches off and every checklist item from the contract', async () => {
    render(<GoLiveSettings/>);
    expect(await screen.findByText('Message for smtp_ready')).toBeDefined();
    expect(client.GET).toHaveBeenCalledWith('/api/settings/go-live');
    for (const id of ids) expect(screen.getByText('Message for ' + id)).toBeDefined();
    expect(screen.getByText('Email delivery').closest('li')!.textContent).toContain('Needs attention');
    expect(screen.getByText('Saved cards').closest('li')!.textContent).toContain('Not checked yet');
    const billing = screen.getByRole('button', { name: 'Turn on: Billing' });
    expect(billing.getAttribute('aria-pressed')).toBe('false');
    expect(within(billing.closest('li')!).getByText('Off')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn on: Member emails' })).toBeDefined();
  });
  it('sends the revision with one switch and shows the saved state', async () => {
    client.PATCH.mockResolvedValue(reply(200, checklist(4, false, true)));
    const user = userEvent.setup(); render(<GoLiveSettings/>);
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member emails' }));
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/go-live', { body: { revision: 3, memberEmailsEnabled: true } });
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn on: Billing' })).toBeDefined();
  });
  it('reloads after a conflict and shows safe errors without server details', async () => {
    client.PATCH.mockResolvedValueOnce(reply(409, { error: { message: 'private SQL detail' } }));
    client.GET.mockResolvedValueOnce(reply(200, checklist())).mockResolvedValueOnce(reply(200, checklist(5, true)));
    const user = userEvent.setup(); render(<GoLiveSettings/>);
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere');
    expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
    expect(client.GET).toHaveBeenCalledTimes(2);
    client.PATCH.mockRejectedValueOnce(new Error('Secret network failure'));
    await user.click(screen.getByRole('button', { name: 'Turn off: Billing' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The request failed');
    expect(document.body.textContent).not.toMatch(/private SQL|Secret network/);
  });
  it('offers a retry when loading fails', async () => {
    client.GET.mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(200, checklist()));
    const user = userEvent.setup(); render(<GoLiveSettings/>);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Message for gym_details')).toBeDefined();
  });
});
