// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QrCheckin } from './qr.js';
import { qrCheckin } from './qr.api.js';
import { KioskAuthError } from './api.js';
import { scanQrCamera } from './qr.scanner.js';
import { breaksAnywhere } from '../../components/ui/wrap.test-helper.js';

vi.mock('./qr.api.js', () => ({ qrCheckin: vi.fn() }));
vi.mock('./qr.scanner.js', () => ({ scanQrCamera: vi.fn() }));
vi.mock('./feedback.js', () => ({ playTone: vi.fn() }));
const code = 'pgci1_' + 'a'.repeat(43), member = { id: '00000000-0000-7000-8000-000000000001', firstName: 'Dana', lastInitial: 'P', photoUrl: null };
let found: (code: string) => void, stop: ReturnType<typeof vi.fn<() => void>>;
const flow = () => ({ token: 'device', onUnauthorized: vi.fn(), onClose: vi.fn(), onNamePin: vi.fn() });
const setCamera = (value: unknown) => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value });
beforeEach(() => {
  stop = vi.fn();
  setCamera({ getUserMedia: vi.fn() });
  vi.mocked(scanQrCamera).mockImplementation(async (_video, onCode) => { found = onCode; return { stop }; });
  vi.mocked(qrCheckin).mockResolvedValue({ status: 'select_session', member, sessions: [] });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); setCamera(undefined); });
/** The page mounts the flow already open, so the camera starts without a tap. */
async function start() { await act(async () => { await Promise.resolve(); }); }
async function scan() { await act(async () => { found(code); }); }
it('scans, prompts for a class or open mat, then clears the person and code', async () => {
  const props = flow();
  render(<QrCheckin {...props}/>);
  await start(); await scan();
  expect(qrCheckin).toHaveBeenCalledWith('device', code, undefined);
  expect(screen.getByText('Dana P.')).toBeDefined();
  vi.mocked(qrCheckin).mockResolvedValue({ status: 'checked_in', member });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open mat' })); });
  expect(qrCheckin).toHaveBeenLastCalledWith('device', code, null);
  expect(screen.getByText('Checked in')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.queryByText('Dana P.')).toBeNull(); expect(stop).toHaveBeenCalled();
  expect(props.onClose).toHaveBeenCalledOnce();
});
it('wraps a class name with no break opportunity inside its button and keeps the other labels whole', async () => {
  const long = 'Fundamentals'.padEnd(56, 'x');
  vi.mocked(qrCheckin).mockResolvedValue({ status: 'select_session', member,
    sessions: [{ id: '00000000-0000-7000-8000-000000000003', name: long, startsAt: '2026-10-22T18:00:00Z', endsAt: '2026-10-22T19:00:00Z' }] });
  render(<QrCheckin {...flow()}/>); await start(); await scan();
  expect(breaksAnywhere(screen.getByRole('button', { name: new RegExp(long) }))).toBe(true);
  expect(breaksAnywhere(screen.getByRole('button', { name: 'Open mat' }))).toBe(false);
});
it('shows only the neutral message for a revoked code or standing failure', async () => {
  vi.mocked(qrCheckin).mockResolvedValue({ status: 'see_front_desk' });
  render(<QrCheckin {...flow()}/>); await start(); await scan();
  expect(screen.getByText('Please see the front desk')).toBeDefined();
  expect(document.body.textContent).not.toMatch(/balance|amount|waiver|billing|Dana/);
});
it('returns to the choice eight seconds after a result and sixty seconds when idle', async () => {
  vi.useFakeTimers(); vi.mocked(qrCheckin).mockResolvedValue({ status: 'checked_in', member });
  const done = flow();
  render(<QrCheckin {...done}/>); await start(); await scan();
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
  expect(done.onClose).toHaveBeenCalledOnce(); expect(screen.queryByText('Dana P.')).toBeNull();
  cleanup();
  const idle = flow();
  render(<QrCheckin {...idle}/>); await start();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(idle.onClose).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalled();
});
it('offers name and PIN after camera denial and returns to setup for a revoked device', async () => {
  vi.mocked(scanQrCamera).mockRejectedValueOnce(new Error('permission denied'));
  const props = flow(); render(<QrCheckin {...props}/>); await start();
  expect(screen.getByText(/Allow camera access/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Use name and PIN' }));
  expect(props.onNamePin).toHaveBeenCalledOnce();
  cleanup();
  const revoked = flow(); render(<QrCheckin {...revoked}/>); await start();
  vi.mocked(qrCheckin).mockRejectedValueOnce(new KioskAuthError()); await scan();
  expect(revoked.onUnauthorized).toHaveBeenCalledTimes(1);
});
it('says so and offers name and PIN where the device has no camera', async () => {
  setCamera(undefined);
  const props = flow(); render(<QrCheckin {...props}/>); await start();
  expect(scanQrCamera).not.toHaveBeenCalled();
  expect(screen.getByText(/can't scan a QR code/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Use name and PIN' }));
  expect(props.onNamePin).toHaveBeenCalledOnce();
});
it('ignores a request that finishes after Start over and stops a late camera grant after unmount', async () => {
  let finish!: (value: { status: 'checked_in'; member: typeof member }) => void;
  vi.mocked(qrCheckin).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<QrCheckin {...flow()}/>); await start(); await scan();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  await act(async () => { finish({ status: 'checked_in', member }); });
  expect(screen.queryByText('Dana P.')).toBeNull();
  view.unmount();
  let grant!: (value: { stop: typeof stop }) => void;
  vi.mocked(scanQrCamera).mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
  const late = render(<QrCheckin {...flow()}/>); await start(); late.unmount(); await act(async () => { grant({ stop }); }); expect(stop).toHaveBeenCalled();
});
