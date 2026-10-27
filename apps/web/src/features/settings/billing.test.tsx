// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GymSettings } from '@plaingym/shared/contracts';
import { BillingSettings } from './billing.js';
import { createRegistries } from '../../lib/registries.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: client, createApiClient: () => client }));
const settings: GymSettings = { id: '01900000-0000-7000-8000-000000000001', name: 'Gym', slug: 'gym',
  timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null,
  bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false,
  memberEmailsEnabled: false, retryDays: [3, 7], revision: 3, createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
beforeEach(() => { client.GET.mockReset(); client.PATCH.mockReset(); client.GET.mockResolvedValue(reply(200, { data: settings })); });
afterEach(cleanup);

describe('billing retry settings', () => {
  it('registers a section for settings managers through the web composition extension point', () => {
    const section = createRegistries().settingsSections.all().find(section => section.id === 'settingsSections.settings.billing');
    expect(section).toMatchObject({ enabled: true, permission: { kind: 'staff', capability: 'settings.manage' }, component: BillingSettings });
  });
  it('loads the schedule and explains its anchor, preserved invoices and email limit', async () => {
    render(<BillingSettings/>);
    const field = await screen.findByRole('textbox', { name: 'Retry days' });
    expect((field as HTMLInputElement).value).toBe('3, 7');
    expect(screen.getByText(/09:00/).textContent).toMatch(/first failed payment.*next first failure.*original schedule/);
    expect(screen.getByText(/up to 5 emails/)).toBeDefined();
    expect(screen.getByText(/Maximum dunning emails.*3\./)).toBeDefined();
  });
  it.each(['7, 3', '3, 3', '0', '29', '1.5', '1, 2, 3, 4, 5', '3,', 'word'])('shows an accessible field error for %s without saving', async days => {
    const user = userEvent.setup(); render(<BillingSettings/>);
    const field = await screen.findByRole('textbox', { name: 'Retry days' });
    await user.clear(field); await user.type(field, days); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    const error = screen.getByRole('alert');
    expect(error.textContent).toContain('whole days');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain(error.id);
    expect(client.PATCH).not.toHaveBeenCalled();
  });
  it.each([{ value: '', days: [] }, { value: '1, 7, 14, 28', days: [1, 7, 14, 28] }])('saves $value with its revision and the shared contract', async ({ value, days }) => {
    client.PATCH.mockResolvedValue(reply(200, { data: { ...settings, revision: 4, retryDays: days } }));
    const user = userEvent.setup(); render(<BillingSettings/>);
    const field = await screen.findByRole('textbox', { name: 'Retry days' });
    await user.clear(field); if (value) await user.type(field, value);
    expect(screen.getByText(new RegExp('Maximum dunning emails.*' + (days.length + 1) + '\\.'))).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/billing', { body: { revision: 3, retryDays: days } });
    expect((await screen.findByRole('status')).textContent).toBe('Retry schedule saved.');
  });
  it('keeps unsaved input on a conflict until the user reloads the current revision', async () => {
    client.PATCH.mockResolvedValueOnce(reply(409)).mockResolvedValueOnce(reply(200, { data: { ...settings, revision: 6, retryDays: [2, 9] } }));
    const user = userEvent.setup(); render(<BillingSettings/>);
    const field = await screen.findByRole('textbox', { name: 'Retry days' });
    await user.clear(field); await user.type(field, '2, 9'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere');
    expect((field as HTMLInputElement).value).toBe('2, 9');
    client.GET.mockResolvedValueOnce(reply(200, { data: { ...settings, revision: 5, retryDays: [4, 10] } }));
    await user.click(screen.getByRole('button', { name: 'Reload saved schedule' }));
    expect((field as HTMLInputElement).value).toBe('4, 10');
    await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(client.PATCH).toHaveBeenLastCalledWith('/api/settings/billing', { body: { revision: 5, retryDays: [4, 10] } });
  });
  it('shows a server validation error at the field and hides private error details', async () => {
    client.PATCH.mockResolvedValue(reply(400, { error: { message: 'private SQL error' } }));
    const user = userEvent.setup(); render(<BillingSettings/>);
    await user.click(await screen.findByRole('button', { name: 'Save retry schedule' }));
    expect((await screen.findByRole('alert')).textContent).toContain('whole days');
    expect(document.body.textContent).not.toContain('private SQL');
  });
  it('offers a retry on a failed load and a safe message on a failed save', async () => {
    client.GET.mockRejectedValueOnce(new Error('private network detail'));
    client.PATCH.mockRejectedValueOnce(new Error('private network detail'));
    const user = userEvent.setup(); render(<BillingSettings/>);
    await user.click(await screen.findByRole('button', { name: 'Reload saved schedule' }));
    await user.click(await screen.findByRole('button', { name: 'Save retry schedule' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The request failed');
    expect(document.body.textContent).not.toContain('private network');
  });
});
