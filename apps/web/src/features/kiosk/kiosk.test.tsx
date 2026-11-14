// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { KioskCheckinResult } from '@plaingym/shared/contracts';
import { forgetToken, kioskApi, KioskAuthError, readToken, saveToken } from './api.js';
import { playTone } from './feedback.js';
import { qrCheckin } from './qr.api.js';
import { scanQrCamera } from './qr.scanner.js';
import { KioskApp } from './kiosk.js';
import { breaksAnywhere } from '../../components/ui/wrap.test-helper.js';

vi.mock('./api.js', async (original) => ({ ...await original<typeof import('./api.js')>(),
  kioskApi: { lookup: vi.fn(), checkin: vi.fn() }, readToken: vi.fn(), saveToken: vi.fn(), forgetToken: vi.fn() }));
vi.mock('./qr.api.js', () => ({ qrCheckin: vi.fn() }));
vi.mock('./qr.scanner.js', () => ({ scanQrCamera: vi.fn() }));
vi.mock('./feedback.js', () => ({ playTone: vi.fn() }));
const parent = { id: '00000000-0000-7000-8000-000000000001', firstName: 'Dana', lastInitial: 'R', photoUrl: null };
const child = { ...parent, id: '00000000-0000-7000-8000-000000000002', firstName: 'Kai' };
const session = { id: '00000000-0000-7000-8000-000000000003', name: 'Fundamentals', startsAt: '2026-10-22T18:00:00Z', endsAt: '2026-10-22T19:00:00Z' };
const credentials = { name: 'Rivera', pin: '0042' };
const setCamera = (value: unknown) => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value });
beforeEach(() => {
  setCamera({ getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]) });
  vi.mocked(readToken).mockReturnValue('device-token');
  vi.mocked(saveToken).mockReturnValue(true);
  vi.mocked(kioskApi.lookup).mockResolvedValue({ status: 'select_member', members: [parent, child] });
  vi.mocked(kioskApi.checkin).mockResolvedValue([
    { status: 'select_session', member: parent, sessions: [session] },
    { status: 'select_session', member: child, sessions: [session] },
  ]);
});
afterEach(() => { cleanup(); setCamera(undefined); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, '', '/'); });
function choosePin() { const choice = screen.queryByRole('button', { name: 'Name and PIN' }); if (choice) fireEvent.click(choice); }
function fill() {
  choosePin();
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
  it('preserves the new tab token when a revoked old tab fails before its storage event arrives', async () => {
    const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
    vi.mocked(readToken).mockImplementation(actual.readToken);
    vi.mocked(forgetToken).mockImplementation(actual.forgetToken);
    actual.saveToken('old-device');
    const oldTab = render(<KioskApp/>);
    let revoked!: (reason: Error) => void;
    vi.mocked(kioskApi.lookup).mockReturnValueOnce(new Promise((_resolve, reject) => { revoked = reject; }));
    fill(); fireEvent.click(screen.getByRole('button', { name: 'Find me' }));
    // The setup link opens in another tab; storage is shared but its event may arrive later.
    window.history.replaceState(null, '', '/kiosk#token=new-device');
    const newTab = render(<KioskApp/>);
    await act(async () => { revoked(new KioskAuthError('revoked')); });
    expect(localStorage.getItem('plaingym.kioskToken')).toBe('new-device');
    expect(within(newTab.container).getByRole('button', { name: 'Scan a QR code' })).toBeDefined();
    // The old tab follows storage rather than asking for setup while a working token is saved.
    expect(within(oldTab.container).queryByLabelText('Device token')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'plaingym.kioskToken', storageArea: localStorage, newValue: 'new-device' }));
    });
    expect(within(oldTab.container).queryByLabelText('Device token')).toBeNull();
    oldTab.unmount(); newTab.unmount();
    render(<KioskApp/>); await search();
    expect(kioskApi.lookup).toHaveBeenLastCalledWith('new-device', credentials.name, credentials.pin);
  });
  it('resets the open flow on shared token changes and storage clear, ignoring other storage', async () => {
    const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
    vi.mocked(readToken).mockImplementation(actual.readToken);
    actual.saveToken('old-device'); render(<KioskApp/>); fill();
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', storageArea: localStorage }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'plaingym.kioskToken', storageArea: sessionStorage }));
    });
    expect(screen.getByLabelText('Your name')).toBeDefined();
    actual.saveToken('new-device');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'plaingym.kioskToken', storageArea: localStorage, newValue: 'outdated-event-value' }));
    });
    expect(screen.queryByLabelText('Your name')).toBeNull();
    await search();
    expect(kioskApi.lookup).toHaveBeenLastCalledWith('new-device', credentials.name, credentials.pin);
    localStorage.clear();
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })); });
    expect(screen.getByLabelText('Device token')).toBeDefined();
  });
  it.each([false, true])('reports a failed fragment save on an already mounted kiosk: %s', async (mounted) => {
    const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
    vi.mocked(readToken).mockImplementation(actual.readToken);
    actual.saveToken('old-device');
    if (mounted) render(<KioskApp/>, { reactStrictMode: true });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    await act(async () => {
      window.history.replaceState(null, '', '/kiosk#token=new-device');
      if (mounted) window.dispatchEvent(new HashChangeEvent('hashchange'));
      else render(<KioskApp/>, { reactStrictMode: true });
    });
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('alert').textContent).toContain("We couldn't save this device's setup");
    expect(screen.getByLabelText('Device token')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Scan a QR code' })).toBeNull();
  });
  it('keeps setup open and explains a failed manual save, then allows retry', () => {
    vi.mocked(readToken).mockReturnValue(null);
    vi.mocked(saveToken).mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<KioskApp/>);
    fireEvent.change(screen.getByLabelText('Device token'), { target: { value: 'new-device' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and start check-in' }));
    expect(screen.getByRole('alert').textContent).toContain("We couldn't save this device's setup");
    fireEvent.click(screen.getByRole('button', { name: 'Save and start check-in' }));
    expect(screen.getByRole('button', { name: 'Scan a QR code' })).toBeDefined();
  });
  it.each([null, 'old-device'])('takes a setup fragment on a mounted kiosk with token %s and clears the old flow', async (previous) => {
    const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
    if (previous) localStorage.setItem('plaingym.kioskToken', previous);
    vi.mocked(readToken).mockImplementation(actual.readToken);
    render(<KioskApp/>);
    if (previous) { fill(); expect(screen.getByLabelText('Your name')).toBeDefined(); }
    await act(async () => {
      window.location.hash = 'token=new-device';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(window.location.hash).toBe('');
    expect(localStorage.getItem('plaingym.kioskToken')).toBe('new-device');
    expect(screen.getByRole('button', { name: 'Scan a QR code' })).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    await search();
    expect(kioskApi.lookup).toHaveBeenLastCalledWith('new-device', credentials.name, credentials.pin);
  });
  it('ignores unrelated fragments while a check-in is open', async () => {
    render(<KioskApp/>); fill();
    await act(async () => {
      window.location.hash = 'help'; window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(vi.mocked(readToken)).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Your name')).toBeDefined();
  });
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
    vi.mocked(forgetToken).mockImplementation(() => { vi.mocked(readToken).mockReturnValue(null); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    expect(forgetToken).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText('Device token')).toBeDefined();
  });
  it('starts on two choices and shows neither flow', () => {
    render(<KioskApp/>);
    expect(screen.getByRole('button', { name: 'Scan a QR code' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(screen.queryByLabelText('QR check-in camera')).toBeNull();
  });
  it('shows only the QR flow after choosing it, and Start over returns to the choice', async () => {
    vi.mocked(scanQrCamera).mockResolvedValue({ stop: vi.fn() });
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    expect(screen.getByLabelText('QR check-in camera')).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(screen.queryByLabelText('Household PIN')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
    expect(screen.queryByLabelText('QR check-in camera')).toBeNull();
  });
  it('shows only name and PIN after choosing it, and Start over returns to the choice', () => {
    render(<KioskApp/>);
    choosePin();
    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Scan a QR code' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('button', { name: 'Scan a QR code' })).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
  });
  it.each(['checked_in', 'see_front_desk'] as const)('keeps a late QR %s result visible for eight full seconds', async (status) => {
    vi.useFakeTimers();
    let scan!: (code: string) => void;
    vi.mocked(scanQrCamera).mockImplementation(async (_video, found) => { scan = found; return { stop: vi.fn() }; });
    vi.mocked(qrCheckin).mockResolvedValue(status === 'checked_in' ? { status, member: parent } : { status });
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(55_000); scan('pgci1_' + 'a'.repeat(43)); });
    const message = status === 'checked_in' ? 'Checked in' : 'Please see the front desk';
    expect(screen.getByText(message)).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(7_999); });
    expect(screen.getByText(message)).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
    expect(screen.queryByText(message)).toBeNull();
  });
  it('restarts idle on a late scan, retains an in-flight request, and gives its class picker a full minute', async () => {
    vi.useFakeTimers();
    let scan!: (code: string) => void, complete!: (result: KioskCheckinResult) => void;
    vi.mocked(scanQrCamera).mockImplementation(async (_video, found) => { scan = found; return { stop: vi.fn() }; });
    vi.mocked(qrCheckin).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(55_000); scan('pgci1_' + 'a'.repeat(43)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByRole('button', { name: 'Name and PIN' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Checking');
    await act(async () => { complete({ status: 'select_session', member: parent, sessions: [session] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(screen.getByRole('button', { name: /Fundamentals/ })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
    expect(screen.queryByText('Dana R.')).toBeNull();
  });
  it.each(['pointerDown', 'keyDown'] as const)('restarts QR selection idle on %s inside and outside the QR section', async (event) => {
    vi.useFakeTimers();
    const stop = vi.fn();
    vi.mocked(scanQrCamera).mockImplementation(async (_video, found) => { found('pgci1_' + 'a'.repeat(43)); return { stop }; });
    vi.mocked(qrCheckin).mockResolvedValue({ status: 'select_session', member: parent, sessions: [session] });
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    for (const target of [screen.getByRole('button', { name: 'Open mat' }), screen.getByRole('button', { name: 'Full screen' }), screen.getByRole('heading', { name: 'Check in' }), screen.getByRole('main')]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      fireEvent[event](target);
      expect(screen.getByRole('button', { name: /Fundamentals/ })).toBeDefined();
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(screen.getByText('Dana R.')).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
    expect(screen.queryByText('Dana R.')).toBeNull();
    expect(stop).toHaveBeenCalled();
  });
  it('closes an idle QR camera after a minute and stops scanning', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    vi.mocked(scanQrCamera).mockResolvedValue({ stop });
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
    expect(screen.queryByLabelText('QR check-in camera')).toBeNull();
    expect(stop).toHaveBeenCalled();
  });
  it('offers name and PIN when the camera is denied', async () => {
    vi.mocked(scanQrCamera).mockRejectedValue(new Error('denied'));
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Use name and PIN' }));
    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(screen.queryByLabelText('QR check-in camera')).toBeNull();
  });
  it('accepts masked PINs from the touch keypad, including leading zeros', async () => {
    render(<KioskApp/>);
    choosePin();
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
  it('wraps a class name with no break opportunity inside its button and keeps the other labels whole', async () => {
    const long = 'Fundamentals'.padEnd(56, 'x');
    vi.mocked(kioskApi.checkin).mockResolvedValue([{ status: 'select_session', member: parent, sessions: [{ ...session, name: long }] }]);
    render(<KioskApp/>);
    await submit();
    expect(breaksAnywhere(screen.getByRole('button', { name: new RegExp(long) }))).toBe(true);
    expect(breaksAnywhere(screen.getByRole('button', { name: 'Open mat' }))).toBe(false);
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
    expect(screen.queryByLabelText('Household PIN')).toBeNull();
    choosePin();
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
    expect(screen.getByRole('alert').textContent).toContain('Please see the front desk before trying again');
    expect(screen.getByRole('alert').dataset.variant).toBe('error');
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
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
    expect(screen.queryByText('Dana R.')).toBeNull();
  });
  it('clears PINs and family results automatically, including unfinished searches', async () => {
    vi.useFakeTimers();
    render(<KioskApp/>);
    fill();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByLabelText('Your name')).toBeNull();
    choosePin();
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Household PIN') as HTMLInputElement).value).toBe('');
    vi.mocked(kioskApi.checkin).mockResolvedValueOnce([{ status: 'checked_in', member: parent }, { status: 'checked_in', member: child }]);
    await submit();
    expect(screen.getAllByText('Checked in')).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(screen.queryByText('Dana R.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Scan a QR code' })).toBeDefined();
    choosePin();
    expect((screen.getByLabelText('Household PIN') as HTMLInputElement).value).toBe('');
  });
  it('clears a rejected device token and opens device setup', async () => {
    vi.mocked(kioskApi.lookup).mockRejectedValueOnce(new KioskAuthError('revoked'));
    vi.mocked(forgetToken).mockImplementation(() => { vi.mocked(readToken).mockReturnValue(null); });
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
    choosePin();
    await waitFor(() => expect(fullscreen).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '1' }).className).toContain('min-h-16');
  });
});
