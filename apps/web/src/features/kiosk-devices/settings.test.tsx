// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KioskDevicesSettings } from './settings.js';
import { registration } from './registrations.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: client }));
const device = { id: '019aa4a0-0000-7000-8000-000000000001', name: 'Front desk', createdAt: '2026-10-22T12:00:00Z',
  lastSeenAt: null, revokedAt: null };
const token = 'private-once-only-token-for-testing';
const ok = (data: unknown) => ({ response: { ok: true }, data });
const page = (data = [device], offset = 0, total = data.length) => ok({ data, pagination: { limit: 20, offset, total } });
beforeEach(() => {
  client.GET.mockReset(); client.POST.mockReset();
  client.GET.mockResolvedValue(page()); localStorage.clear(); sessionStorage.clear();
});
afterEach(cleanup);
describe('kiosk device settings', () => {
  it('enables the registered section for device managers and renders safe device metadata', async () => {
    expect(registration.settingsSections?.[0]).toMatchObject({ enabled: true,
      permission: { kind: 'staff', capability: 'kiosk_devices.manage' }, component: KioskDevicesSettings });
    render(<KioskDevicesSettings/>);
    expect(await screen.findByText('Front desk')).toBeDefined();
    expect(screen.getByText('Never')).toBeDefined(); expect(screen.getByText('Active')).toBeDefined();
    expect(client.GET).toHaveBeenCalledWith('/api/kiosk/devices', { params: { query: { limit: 20, offset: 0 } } });
  });
  it('shows the token once, blocks overwriting it, never persists it, and forgets it when dismissed', async () => {
    client.POST.mockResolvedValue(ok({ data: { device: { ...device, name: 'Tablet' }, token } }));
    const user = userEvent.setup(), view = render(<KioskDevicesSettings/>);
    await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    expect(await screen.findByText(token)).toBeDefined();
    expect(client.POST).toHaveBeenCalledWith('/api/kiosk/devices', { body: { name: 'Tablet' } });
    expect((screen.getByRole('button', { name: 'Register device' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'I saved the token' }));
    expect(screen.queryByText(token)).toBeNull();
    view.unmount(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    expect(screen.queryByText(token)).toBeNull();
  });
  it('revokes the named device and disables its action without exposing any token', async () => {
    client.POST.mockResolvedValue(ok({ data: { ...device, revokedAt: '2026-10-22T13:00:00Z' } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>);
    await user.click(await screen.findByRole('button', { name: 'Revoke access for Front desk' }));
    expect(await screen.findByText('Revoked')).toBeDefined();
    expect(client.POST).toHaveBeenCalledWith('/api/kiosk/devices/{id}/revoke', { params: { path: { id: device.id } } });
    expect((screen.getByRole('button', { name: 'Revoke access for Front desk' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('clears a newly displayed token if that device is revoked', async () => {
    client.POST.mockResolvedValueOnce(ok({ data: { device, token } }))
      .mockResolvedValueOnce(ok({ data: { ...device, revokedAt: '2026-10-22T13:00:00Z' } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Front desk');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    await screen.findByText(token);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Revoke access for Front desk' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Revoke access for Front desk' }));
    await screen.findByText('Revoked'); expect(screen.queryByText(token)).toBeNull();
  });
  it('paginates using contract bounds and refreshes an empty list', async () => {
    client.GET.mockResolvedValueOnce(page([device], 0, 21))
      .mockResolvedValueOnce(page([{ ...device, id: '019aa4a0-0000-7000-8000-000000000002', name: 'Second page' }], 20, 21))
      .mockResolvedValue(page([]));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Second page');
    expect(client.GET).toHaveBeenLastCalledWith('/api/kiosk/devices', { params: { query: { limit: 20, offset: 20 } } });
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('No kiosk devices registered.');
    await user.click(screen.getByRole('button', { name: 'Refresh devices' }));
    await waitFor(() => expect(client.GET).toHaveBeenCalledTimes(4));
  });
  it('shows safe errors for load and mutation failures, permits retry, and blocks double submission', async () => {
    client.GET.mockRejectedValueOnce(new Error('SQL private internals'));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>);
    expect((await screen.findByRole('alert')).textContent).toContain('The request failed');
    expect(document.body.textContent).not.toContain('SQL private');
    await user.click(screen.getByRole('button', { name: 'Refresh devices' }));
    await screen.findByText('Front desk');
    let reject!: (error: Error) => void;
    client.POST.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    const button = screen.getByRole('button', { name: 'Register device' });
    await user.click(button); await user.click(button);
    expect(client.POST).toHaveBeenCalledTimes(1);
    reject(new Error('Secret network failure'));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('Secret network');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
