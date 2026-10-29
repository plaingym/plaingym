// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QrCheckin } from './qr.js';
import { qrCheckin } from './qr.api.js';
import { KioskAuthError } from './api.js';
import { scanQrCamera } from './qr.scanner.js';

vi.mock('./qr.api.js', () => ({ qrCheckin: vi.fn() }));
vi.mock('./qr.scanner.js', () => ({ scanQrCamera: vi.fn() }));
vi.mock('./feedback.js', () => ({ playTone: vi.fn() }));
const code = 'pgci1_' + 'a'.repeat(43), member = { id: '00000000-0000-7000-8000-000000000001', firstName: 'Dana', lastInitial: 'P', photoUrl: null };
let found: (code: string) => void, stop: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  stop = vi.fn();
  vi.mocked(scanQrCamera).mockImplementation(async (_video, onCode) => { found = onCode; return { stop }; });
  vi.mocked(qrCheckin).mockResolvedValue({ status: 'select_session', member, sessions: [] });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
async function start() { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); }); }
async function scan() { await act(async () => { found(code); }); }
it('scans, prompts for a class or open mat, then clears the person and code', async () => {
  render(<QrCheckin token="device" onUnauthorized={vi.fn()}/>);
  await start(); await scan();
  expect(qrCheckin).toHaveBeenCalledWith('device', code, undefined);
  expect(screen.getByText('Dana P.')).toBeDefined();
  vi.mocked(qrCheckin).mockResolvedValue({ status: 'checked_in', member });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open mat' })); });
  expect(qrCheckin).toHaveBeenLastCalledWith('device', code, null);
  expect(screen.getByText('Checked in')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.queryByText('Dana P.')).toBeNull(); expect(stop).toHaveBeenCalled();
});
it('shows only the neutral message for a revoked code or standing failure', async () => {
  vi.mocked(qrCheckin).mockResolvedValue({ status: 'see_front_desk' });
  render(<QrCheckin token="device" onUnauthorized={vi.fn()}/>); await start(); await scan();
  expect(screen.getByText('Please see the front desk')).toBeDefined();
  expect(document.body.textContent).not.toMatch(/balance|amount|waiver|billing|Dana/);
});
it('expires completed results in eight seconds and an idle camera in sixty seconds', async () => {
  vi.useFakeTimers(); vi.mocked(qrCheckin).mockResolvedValue({ status: 'checked_in', member });
  render(<QrCheckin token="device" onUnauthorized={vi.fn()}/>); await start(); await scan();
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
  expect(screen.queryByText('Dana P.')).toBeNull();
  await start(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.queryByLabelText('QR check-in camera')).toBeNull(); expect(stop).toHaveBeenCalled();
});
it('offers the name/PIN fallback after camera denial and returns to setup for a revoked device', async () => {
  vi.mocked(scanQrCamera).mockRejectedValueOnce(new Error('permission denied'));
  const unauthorized = vi.fn(); render(<QrCheckin token="device" onUnauthorized={unauthorized}/>); await start();
  expect(screen.getByText(/Allow camera access/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' })); await start();
  vi.mocked(qrCheckin).mockRejectedValueOnce(new KioskAuthError()); await scan();
  expect(unauthorized).toHaveBeenCalledTimes(1);
});
it('ignores a request that finishes after Start over and stops a late camera grant after unmount', async () => {
  let finish!: (value: { status: 'checked_in'; member: typeof member }) => void;
  vi.mocked(qrCheckin).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<QrCheckin token="device" onUnauthorized={vi.fn()}/>); await start(); await scan();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  await act(async () => { finish({ status: 'checked_in', member }); });
  expect(screen.queryByText('Dana P.')).toBeNull();
  let grant!: (value: { stop: typeof stop }) => void;
  vi.mocked(scanQrCamera).mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
  await start(); view.unmount(); await act(async () => { grant({ stop }); }); expect(stop).toHaveBeenCalled();
});
