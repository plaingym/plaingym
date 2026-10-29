// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KioskCheckinResult } from '@plaingym/shared/contracts';
import { forgetToken, kioskApi, KioskAuthError, readToken, saveToken } from './api.js';
import { playTone } from './feedback.js';
import { qrCheckin } from './qr.api.js';
import { scanQrCamera } from './qr.scanner.js';
import { KioskApp } from './kiosk.js';

vi.mock('./api.js', async (original) => ({ ...await original<typeof import('./api.js')>(),
  kioskApi: { lookup: vi.fn(), checkin: vi.fn() }, readToken: vi.fn(), saveToken: vi.fn(), forgetToken: vi.fn() }));
vi.mock('./qr.api.js', () => ({ qrCheckin: vi.fn() }));
vi.mock('./qr.scanner.js', () => ({ scanQrCamera: vi.fn() }));
vi.mock('./feedback.js', () => ({ playTone: vi.fn() }));
const parent = { id: '00000000-0000-7000-8000-000000000001', firstName: 'Dana', lastInitial: 'R', photoUrl: null };
const child = { ...parent, id: '00000000-0000-7000-8000-000000000002', firstName: 'Kai' };
const session = { id: '00000000-0000-7000-8000-000000000003', name: 'Fundamentals', startsAt: '2026-10-22T18:00:00Z', endsAt: '2026-10-22T19:00:00Z' };
const credentials = { name: 'Rivera', pin: '0042' };
beforeEach(() => {
  vi.mocked(readToken).mockReturnValue('device-token');
  vi.mocked(kioskApi.lookup).mockResolvedValue({ status: 'select_member', members: [parent, child] });
  vi.mocked(kioskApi.checkin).mockResolvedValue([
    { status: 'select_session', member: parent, sessions: [session] },
    { status: 'select_session', member: child, sessions: [session] },
  ]);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fill() {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: credentials.name } });
  fireEvent.change(screen.getByLabelText('Household PIN'), { target: { value: credentials.pin } });
}
async function search() {
  fill();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Find me' })); });
}
async function submit() {
  await search();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check in' })); });
}
describe('kiosk check-in screen', () => {
  it('sets up a device without a staff login', () => {
    vi.mocked(readToken).mockReturnValue(null);
    render(<KioskApp/>);
    expect(screen.getByLabelText('Device token').getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(screen.getByLabelText('Device token'), { target: { value: ' new-token ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and start check-in' }));
    expect(saveToken).toHaveBeenCalledWith('new-token');
    expect(screen.getByRole('heading', { name: 'Check in' })).toBeDefined();
  });
  it('mounts QR scanning on search, uses the device token and clears unauthorized devices', async () => {
    const code = 'pgci1_' + 'a'.repeat(43);
    vi.mocked(scanQrCamera).mockImplementation(async (_video, found) => { found(code); return { stop: vi.fn() }; });
    vi.mocked(qrCheckin).mockResolvedValueOnce({ status: 'checked_in', member: parent });
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    expect(qrCheckin).toHaveBeenCalledWith('device-token', code, undefined);
    expect(await screen.findByText('Checked in')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    vi.mocked(qrCheckin).mockRejectedValueOnce(new KioskAuthError('revoked'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    expect(forgetToken).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText('Device token')).toBeDefined();
  });
  it('accepts masked PINs from the touch keypad, including leading zeros', async () => {
    render(<KioskApp/>);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: credentials.name } });
    for (const digit of credentials.pin) fireEvent.click(screen.getByRole('button', { name: digit }));
    expect(screen.getByLabelText('Household PIN').getAttribute('type')).toBe('password');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Find me' })); });
    expect(kioskApi.lookup).toHaveBeenCalledWith('device-token', credentials.name, credentials.pin);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('Dana R.')).toBeDefined();
    expect(screen.queryByText('Rivera')).toBeNull();
  });
  it('selects individual family members and offers concurrent classes and open mat', async () => {
    render(<KioskApp/>);
    await search();
    fireEvent.click(screen.getByRole('checkbox', { name: /Kai/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check in' })); });
    expect(kioskApi.checkin).toHaveBeenCalledWith('device-token', { ...credentials, checkins: [{ memberId: parent.id }] });
    expect(screen.getByRole('button', { name: /Fundamentals/ })).toBeDefined();
    vi.mocked(kioskApi.checkin).mockResolvedValueOnce([{ status: 'checked_in', member: parent }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open mat' })); });
    expect(kioskApi.checkin).toHaveBeenLastCalledWith('device-token', { ...credentials, checkins: [{ memberId: parent.id, sessionId: null }] });
    expect(screen.getByText('Checked in')).toBeDefined();
    expect(playTone).toHaveBeenCalledWith('success');
  });
  it('keeps the current household roster only in memory and clears it on Done', async () => {
    vi.mocked(kioskApi.checkin).mockResolvedValueOnce([{ status: 'checked_in', member: parent }, { status: 'checked_in', member: child }]);
    render(<KioskApp/>);
    await submit();
    fireEvent.click(screen.getByRole('button', { name: 'Change family selection' }));
    expect(kioskApi.lookup).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('checkbox').every((node) => node.getAttribute('aria-checked') === 'false')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryByText('Dana R.')).toBeNull();
    expect((screen.getByLabelText('Household PIN') as HTMLInputElement).value).toBe('');
  });
  it('shows a neutral front-desk result with attention audio', async () => {
    vi.mocked(kioskApi.checkin).mockResolvedValue([{ status: 'see_front_desk' }, { status: 'see_front_desk' }]);
    render(<KioskApp/>);
    await submit();
    expect(screen.getAllByText('Please see the front desk')).toHaveLength(2);
    expect(playTone).toHaveBeenCalledWith('attention');
    expect(document.body.textContent).not.toMatch(/past due|amount|billing|waiver/i);
  });
  it('never retries an uncertain open-mat write or invites an automatic retry', async () => {
    render(<KioskApp/>);
    await submit();
    vi.mocked(kioskApi.checkin).mockRejectedValueOnce(new Error('connection lost after commit'));
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Open mat' })[0]!); });
    expect(kioskApi.checkin).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toContain('Please see the front desk before trying again');
    expect(screen.queryByText('Dana R.')).toBeNull();
  });
  it('blocks double taps and ignores responses that arrive after Start over', async () => {
    let complete!: (results: KioskCheckinResult[]) => void;
    vi.mocked(kioskApi.checkin).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    render(<KioskApp/>);
    await search();
    const button = screen.getByRole('button', { name: 'Check in' });
    fireEvent.click(button); fireEvent.click(button);
    expect(kioskApi.checkin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await act(async () => { complete([{ status: 'checked_in', member: parent }]); });
    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(screen.queryByText('Dana R.')).toBeNull();
  });
  it('clears PINs and family results automatically, including unfinished searches', async () => {
    vi.useFakeTimers();
    render(<KioskApp/>);
    fill();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Household PIN') as HTMLInputElement).value).toBe('');
    vi.mocked(kioskApi.checkin).mockResolvedValueOnce([{ status: 'checked_in', member: parent }, { status: 'checked_in', member: child }]);
    await submit();
    expect(screen.getAllByText('Checked in')).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(screen.queryByText('Dana R.')).toBeNull();
    expect((screen.getByLabelText('Household PIN') as HTMLInputElement).value).toBe('');
  });
  it('clears a rejected device token and opens device setup', async () => {
    vi.mocked(kioskApi.lookup).mockRejectedValueOnce(new KioskAuthError('revoked'));
    render(<KioskApp/>);
    await search();
    expect(forgetToken).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'Set up this check-in device' })).toBeDefined();
  });
  it('requests fullscreen from the tablet screen', async () => {
    const fullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: fullscreen });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1024 });
    render(<KioskApp/>);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await waitFor(() => expect(fullscreen).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '1' }).className).toContain('min-h-16');
  });
});
