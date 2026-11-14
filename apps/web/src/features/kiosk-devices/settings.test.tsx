// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShellServicesContext } from '../../app/context.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react';
import { renderSVG } from 'uqr';
import userEvent from '@testing-library/user-event';
import { KioskDevicesSettings } from './settings.js';
import { registration } from './registrations.js';
function render(content: React.ReactNode) {
  const services = ({ signInWithPassword: async () => {}, requestMagicLink: async () => {}, signOut: async () => {}, loadBootstrap: async () => ({ gym: { id: 'gym', name: 'Gym', timezone: 'America/Los_Angeles', currency: 'USD', enabledModules: [] },
    session: null, login: { password: true, magicLink: false } }) });
  return baseRender(<QueryClientProvider client={new QueryClient()}><ShellServicesContext.Provider value={services}>{content}</ShellServicesContext.Provider></QueryClientProvider>);
}
const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: client }));
vi.mock('uqr', async (original) => {
  const actual = await original<typeof import('uqr')>();
  return { ...actual, renderSVG: vi.fn(actual.renderSVG) };
});
const device = { id: '019aa4a0-0000-7000-8000-000000000001', name: 'Front desk', createdAt: '2026-10-22T12:00:00Z',
  lastSeenAt: null, revokedAt: null };
const token = 'private-once-only-token-for-testing';
const ok = (data: unknown) => ({ response: { ok: true }, data });
const page = (data = [device], offset = 0, total = data.length) => ok({ data, pagination: { limit: 20, offset, total } });
beforeEach(() => {
  client.GET.mockReset(); client.POST.mockReset();
  client.GET.mockResolvedValue(page()); localStorage.clear(); sessionStorage.clear();
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/');
});
describe('kiosk device settings', () => {
  it('shows device instants on the gym day near midnight UTC', async () => {
    client.GET.mockResolvedValue(page([{ ...device, createdAt: '2026-11-02T00:30:00Z' }]));
    render(<KioskDevicesSettings/>);
    expect(await screen.findByText('Nov 1, 2026, 4:30 PM')).toBeDefined();
  });
  it('clears the copied note three seconds after the latest copy', async () => {
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    await screen.findByRole('button', { name: 'Copy link' });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); });
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Link copied' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeDefined();
  });
  it('explains a QR rendering failure and keeps the setup link available', async () => {
    vi.mocked(renderSVG).mockImplementationOnce(() => { throw new Error('private rendering details'); });
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'The QR code could not be drawn. Open the setup link on the check-in device instead.');
    expect(screen.getByText(window.location.origin + '/kiosk#token=' + token)).toBeDefined();
    expect(screen.queryByAltText('QR code of the kiosk setup link')).toBeNull();
    expect(document.body.textContent).not.toContain('private rendering details');
  });
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
    const link = window.location.origin + '/kiosk#token=' + token;
    expect(await screen.findByText(link)).toBeDefined();
    const qr = screen.getByAltText('QR code of the kiosk setup link') as HTMLImageElement;
    expect(qr.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(screen.queryByText(token)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show token' }));
    expect(screen.getByText(token)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Hide token' }));
    expect(screen.queryByText(token)).toBeNull();
    expect(screen.getByRole('button', { name: 'Show token' }).getAttribute('aria-expanded')).toBe('false');
    expect(client.POST).toHaveBeenCalledWith('/api/kiosk/devices', { body: { name: 'Tablet' } });
    expect((screen.getByRole('button', { name: 'Register device' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(link)).toBeNull(); expect(screen.queryByAltText('QR code of the kiosk setup link')).toBeNull();
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
    await screen.findByText(window.location.origin + '/kiosk#token=' + token);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Revoke access for Front desk' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Revoke access for Front desk' }));
    await screen.findByText('Revoked'); expect(screen.queryByText(token)).toBeNull();
    expect(screen.queryByAltText('QR code of the kiosk setup link')).toBeNull();
  });
  it('copies the setup link, and opening it replaces a token already stored in that browser', async () => {
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    const link = window.location.origin + '/kiosk#token=' + token;
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(link);
    const { readToken } = await import('../kiosk/api.js');
    window.localStorage.setItem('plaingym.kioskToken', 'older-token');
    window.history.replaceState(null, '', '/kiosk#' + link.split('#')[1]);
    expect(readToken()).toBe(token);
    expect(window.location.hash).toBe('');
  });
  it('does not reveal the next token after a dismissed one was revealed', async () => {
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    for (const name of ['First', 'Second']) {
      await waitFor(() => expect((screen.getByLabelText('Device name') as HTMLInputElement).disabled).toBe(false));
      await user.type(screen.getByLabelText('Device name'), name);
      await user.click(screen.getByRole('button', { name: 'Register device' }));
      await screen.findByRole('button', { name: 'Show token' });
      expect(screen.queryByText(token)).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Show token' }));
      expect(screen.getByText(token)).toBeDefined();
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    }
  });
  it('tells the user to copy by hand when the clipboard is unavailable', async () => {
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    const button = await screen.findByRole('button', { name: 'Copy link' });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(button);
    expect(await screen.findByText(/could not be copied/)).toBeDefined();
  });
  it('keeps a load error when a copy succeeds', async () => {
    client.GET.mockResolvedValueOnce(page()).mockRejectedValue(new Error('down'));
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    expect(await screen.findByText(/request failed/)).toBeDefined();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeDefined();
    expect(screen.getByText(/request failed/)).toBeDefined();
  });
  it('clears a copy failure with the link it describes', async () => {
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText(/could not be copied/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/could not be copied/)).toBeNull();
  });
  it('never shows the copied note and the copy failure together', async () => {
    client.POST.mockResolvedValue(ok({ data: { device, token } }));
    const user = userEvent.setup(); render(<KioskDevicesSettings/>); await screen.findByText('Front desk');
    await user.type(screen.getByLabelText('Device name'), 'Tablet');
    await user.click(screen.getByRole('button', { name: 'Register device' }));
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await user.click(await screen.findByRole('button', { name: 'Link copied' }));
    expect(await screen.findByText(/could not be copied/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Link copied' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeDefined();
    expect(screen.queryByText(/could not be copied/)).toBeNull();
    expect(write).toHaveBeenCalledTimes(3);
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
    await screen.findByText('No kiosk devices registered');
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
