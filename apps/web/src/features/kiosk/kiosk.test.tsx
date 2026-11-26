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
import { isStaleVersion } from '../../app/version.js';

vi.mock('../../app/version.js', async original => ({ ...await original<typeof import('../../app/version.js')>(), isStaleVersion: vi.fn(() => false) }));
const bootstrap = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../app/context.js', () => ({ useBootstrap: () => { bootstrap.calls += 1; return { data: { gym: { timezone: 'America/Los_Angeles' } } }; } }));
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
  vi.mocked(isStaleVersion).mockReturnValue(false);
  setCamera({ getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]) });
  vi.mocked(readToken).mockReturnValue('device-token');
  vi.mocked(saveToken).mockReturnValue(true);
  vi.mocked(kioskApi.lookup).mockResolvedValue({ status: 'select_member', members: [parent, child] });
  vi.mocked(kioskApi.checkin).mockResolvedValue([
    { status: 'select_session', member: parent, sessions: [session] },
    { status: 'select_session', member: child, sessions: [session] },
  ]);
});
afterEach(() => { cleanup(); setCamera(undefined); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); window.history.replaceState(null, '', '/'); });
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
  it('asks staff to reload an older bundle while leaving check-in available', () => {
    vi.mocked(isStaleVersion).mockReturnValue(true);
    render(<KioskApp/>);
    expect(screen.getByRole('status').textContent).toContain('Reload this tablet');
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
  });
  it('starts loading the gym timezone before any class list is shown', () => {
    bootstrap.calls = 0;
    render(<KioskApp/>);
    expect(bootstrap.calls).toBeGreaterThan(0);
  });
  it('shows gym session times when the device is on the following calendar day', async () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    const startsAt = '2026-11-02T00:30:00Z';
    expect(new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(startsAt))).toBe('Nov 2, 2026');
    vi.mocked(kioskApi.checkin).mockResolvedValue([{ status: 'select_session', member: parent,
      sessions: [{ ...session, startsAt }] }]);
    render(<KioskApp/>); await submit();
    expect(screen.getByRole('button', { name: /Fundamentals.*4:30 PM/ })).toBeDefined();
    vi.unstubAllEnvs();
  });
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
  it('asks for no on-screen keyboard on the PIN field, leaving the name field to the device', () => {
    render(<KioskApp/>);
    choosePin();
    const pin = screen.getByLabelText('Household PIN');
    expect(pin.getAttribute('inputmode')).toBe('none');
    expect(pin.getAttribute('type')).toBe('password');
    expect(pin.getAttribute('autocomplete')).toBe('off');
    expect(pin.getAttribute('maxlength')).toBe('8');
    expect(screen.getByLabelText('Your name').hasAttribute('inputmode')).toBe(false);
  });
  it('fills the PIN from the keypad or typed digits and enables Find me at four digits', () => {
    render(<KioskApp/>);
    choosePin();
    const pin = screen.getByLabelText('Household PIN') as HTMLInputElement;
    const find = screen.getByRole('button', { name: 'Find me' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: credentials.name } });
    for (const digit of ['1', '2', '3']) fireEvent.click(screen.getByRole('button', { name: digit }));
    expect(find.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(pin.value).toBe('1234');
    expect(find.disabled).toBe(false);
    fireEvent.change(pin, { target: { value: '' } });
    fireEvent.change(pin, { target: { value: '12a34' } });
    expect(pin.value).toBe('1234');
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '' } });
    expect(find.disabled).toBe(true);
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
  it('leaves focus on the body after a tap or key once the focused field is blurred', () => {
    render(<KioskApp/>);
    choosePin();
    const pin = screen.getByLabelText('Household PIN');
    pin.focus(); pin.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.pointerDown(screen.getByRole('button', { name: '1' }));
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(screen.getByRole('main'), { key: 'a' });
    expect(document.activeElement).toBe(document.body);
  });
  it('restarts the name and PIN idle timer on a keypad tap', async () => {
    vi.useFakeTimers();
    render(<KioskApp/>);
    choosePin();
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    fireEvent.pointerDown(screen.getByRole('button', { name: '1' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(screen.getByLabelText('Your name')).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole('button', { name: 'Name and PIN' })).toBeDefined();
  });
  it('moves focus to each new step', () => {
    render(<KioskApp/>);
    const choice = screen.getByRole('button', { name: 'Name and PIN' });
    choice.focus(); fireEvent.click(choice);
    expect(document.activeElement).toBe(screen.getByLabelText('Your name'));
    const startOver = screen.getByRole('button', { name: 'Start over' });
    startOver.focus(); fireEvent.click(startOver);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'How would you like to check in?' }));
  });
  it('leaves focus on the body when a tap that focuses nothing chooses a member', async () => {
    render(<KioskApp/>);
    await search();
    const member = screen.getByRole('checkbox', { name: /Dana/ });
    member.focus(); member.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(member);
    expect(member.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(document.body);
  });
  it('moves focus to the who is here step again after changing the family selection', async () => {
    vi.mocked(kioskApi.checkin).mockResolvedValueOnce([{ status: 'checked_in', member: parent }, { status: 'checked_in', member: child }]);
    render(<KioskApp/>);
    await submit();
    const change = screen.getByRole('button', { name: 'Change family selection' });
    change.focus(); fireEvent.click(change);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Who/ }));
  });
  it('returns focus to the QR step when progress removes the focused session choice', async () => {
    vi.mocked(scanQrCamera).mockImplementation(async (_video, found) => { found('pgci1_' + 'a'.repeat(43)); return { stop: vi.fn() }; });
    vi.mocked(qrCheckin).mockResolvedValueOnce({ status: 'select_session', member: parent, sessions: [session] })
      .mockResolvedValueOnce({ status: 'checked_in', member: parent });
    render(<KioskApp/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan a QR code' })); });
    const openMat = screen.getByRole('button', { name: 'Open mat' });
    openMat.focus();
    await act(async () => { fireEvent.click(openMat); });
    expect(screen.queryByRole('button', { name: 'Open mat' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('region').querySelector('[data-kiosk-focus]'));
  });
  it('uses a compact title and name field on a short screen', () => {
    render(<KioskApp/>);
    choosePin();
    expect(screen.getByRole('heading', { name: 'Check in' }).classList).toContain('[@media(max-height:500px)]:text-xl');
    const name = screen.getByLabelText('Your name');
    expect(name.classList).toContain('[@media(max-height:500px)]:h-12');
    expect(name.classList).toContain('sm:h-16');
  });
  describe('keeping the name field visible', () => {
    const scroll = vi.fn();
    let original: PropertyDescriptor | undefined;
    beforeEach(() => {
      original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    });
    afterEach(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    });
    const rect = (element: Element, top: number) =>
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ y: top, height: 48 }));
    /** Opens name and PIN with the name field blurred at the given position, so a test controls its next focus. */
    function open(height: number, top: number, scale = 1) {
      const viewport = Object.assign(new EventTarget(), { height, offsetTop: 0, scale });
      vi.stubGlobal('visualViewport', viewport);
      render(<KioskApp/>);
      choosePin();
      const name = screen.getByLabelText('Your name');
      rect(name, top);
      act(() => name.blur());
      scroll.mockClear();
      return { viewport, name, resize: () => viewport.dispatchEvent(new Event('resize')) };
    }
    it('centres a hidden name field on focus on a short screen', () => {
      const { name } = open(400, 450);
      act(() => name.focus());
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
      expect(scroll.mock.contexts[0]).toBe(name);
    });
    it('leaves a tall screen where it is', () => {
      const { name, resize } = open(800, 450);
      act(() => name.focus());
      resize();
      expect(scroll).not.toHaveBeenCalled();
    });
    it('leaves a fully visible name field where it is', () => {
      const { name } = open(400, 100);
      act(() => name.focus());
      expect(scroll).not.toHaveBeenCalled();
    });
    it('scrolls on a resize only for a keyboard at an unchanged zoom while the name field is focused', () => {
      const { viewport, name, resize } = open(800, 450);
      act(() => name.focus());
      expect(scroll).not.toHaveBeenCalled();
      const resizeTo = (height: number) => { viewport.height = height; resize(); };
      resizeTo(400);
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
      resizeTo(350);
      resizeTo(420);
      expect(scroll).toHaveBeenCalledOnce();
      resizeTo(280);
      expect(scroll).toHaveBeenCalledTimes(2);
      viewport.scale = 1.5;
      resizeTo(100);
      // The zoomed height is the new starting point, and a keyboard at the new zoom scrolls again.
      resizeTo(100);
      expect(scroll).toHaveBeenCalledTimes(2);
      resizeTo(300);
      resizeTo(150);
      expect(scroll).toHaveBeenCalledTimes(3);
      act(() => screen.getByLabelText('Household PIN').focus());
      scroll.mockClear();
      resizeTo(800);
      resizeTo(400);
      expect(scroll).not.toHaveBeenCalled();
      const removed = vi.spyOn(viewport, 'removeEventListener');
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
    });
    it('brings a hidden not found note to the top, even with the name field visible', async () => {
      vi.mocked(kioskApi.lookup).mockResolvedValueOnce({ status: 'see_front_desk' });
      const { name } = open(400, 100);
      await search();
      expect(screen.getByRole('status').textContent).not.toBe('');
      const form = name.closest('form')!;
      rect(form, -40);
      act(() => name.blur());
      scroll.mockClear();
      act(() => name.focus());
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
      expect(scroll.mock.contexts[0]).toBe(form);
    });
    it('centres the name field when a note above it and the field do not both fit', async () => {
      vi.mocked(kioskApi.lookup).mockResolvedValueOnce({ status: 'see_front_desk' });
      const { name } = open(400, 450);
      await search();
      expect(screen.getByRole('status').textContent).not.toBe('');
      rect(name.closest('form')!, -400);
      act(() => name.blur());
      scroll.mockClear();
      act(() => name.focus());
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
      expect(scroll.mock.contexts[0]).toBe(name);
    });
    it('counts a zoomed keyboard by its drop in screen pixels', () => {
      const { viewport, name, resize } = open(180, 450, 2);
      act(() => name.focus());
      scroll.mockClear();
      viewport.height = 80;
      resize();
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
      expect(scroll.mock.contexts[0]).toBe(name);
    });
    it('does not scroll for a drop of 100 at no zoom', () => {
      const { viewport, name, resize } = open(400, 450);
      act(() => name.focus());
      scroll.mockClear();
      viewport.height = 300;
      resize();
      expect(scroll).not.toHaveBeenCalled();
    });
    /** Shows the not found note, taller than the screen with the field, and focuses a name field at the given position. */
    async function focusUnderTallNote(top: number) {
      vi.mocked(kioskApi.lookup).mockResolvedValueOnce({ status: 'see_front_desk' });
      const { name } = open(300, top);
      await search();
      expect(screen.getByRole('status').textContent).not.toBe('');
      rect(name.closest('form')!, -300);
      act(() => name.blur());
      scroll.mockClear();
      act(() => name.focus());
      return name;
    }
    it('leaves a fully visible name field under a tall note where it is', async () => {
      await focusUnderTallNote(100);
      expect(scroll).not.toHaveBeenCalled();
    });
    it('centres only the name field when it is below the view under a tall note', async () => {
      const name = await focusUnderTallNote(280);
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
      expect(scroll.mock.contexts[0]).toBe(name);
    });
    it('does not count a zoomed tall screen as short', () => {
      const { name } = open(400, 450, 2);
      act(() => name.focus());
      expect(scroll).not.toHaveBeenCalled();
    });
    it('counts a screen as short by its height times its zoom', () => {
      const { name } = open(400, 450, 1.25);
      act(() => name.focus());
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
    });
    /** Types the name and PIN, focuses the name field, puts the form at the given position and sends the form as Enter does. */
    async function sendWithEnter(height: number, formTop: number) {
      const { name } = open(height, 100);
      fill();
      act(() => name.focus());
      const form = name.closest('form')!;
      rect(form, formTop);
      scroll.mockClear();
      // jsdom has no implicit submission, so request it from the form while the name field keeps the focus.
      await act(async () => { form.requestSubmit(); });
      expect(document.activeElement).toBe(name);
      return form;
    }
    it('brings the not found note into view after a search sent with Enter', async () => {
      vi.mocked(kioskApi.lookup).mockResolvedValueOnce({ status: 'see_front_desk' });
      const form = await sendWithEnter(400, -40);
      expect(screen.getByRole('status').textContent).not.toBe('');
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
      expect(scroll.mock.contexts[0]).toBe(form);
    });
    it('leaves a tall screen where it is after a search sent with Enter', async () => {
      vi.mocked(kioskApi.lookup).mockResolvedValueOnce({ status: 'see_front_desk' });
      await sendWithEnter(800, -40);
      expect(screen.getByRole('status').textContent).not.toBe('');
      expect(scroll).not.toHaveBeenCalled();
    });
    it('leaves a visible note and field where they are after a search sent with Enter', async () => {
      vi.mocked(kioskApi.lookup).mockResolvedValueOnce({ status: 'see_front_desk' });
      await sendWithEnter(400, 0);
      expect(screen.getByRole('status').textContent).not.toBe('');
      expect(scroll).not.toHaveBeenCalled();
    });
    it('does not scroll for a note when the search button sent the search', async () => {
      vi.mocked(kioskApi.lookup).mockResolvedValueOnce({ status: 'see_front_desk' });
      const { name } = open(400, 100);
      fill();
      rect(name.closest('form')!, -40);
      const find = screen.getByRole('button', { name: 'Find me' });
      act(() => find.focus());
      scroll.mockClear();
      await act(async () => { fireEvent.click(find); });
      expect(screen.getByRole('status').textContent).not.toBe('');
      expect(scroll).not.toHaveBeenCalled();
    });
    it('leaves an error note its own focus and scroll after a search sent with Enter', async () => {
      vi.mocked(kioskApi.lookup).mockRejectedValueOnce(new Error('offline'));
      const { name } = open(400, 100);
      fill();
      act(() => name.focus());
      rect(name.closest('form')!, -40);
      scroll.mockClear();
      await act(async () => { name.closest('form')!.requestSubmit(); });
      const alert = screen.getByRole('alert');
      expect(document.activeElement).toBe(alert);
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
      expect(scroll.mock.contexts[0]).toBe(alert);
    });
  });
  it('takes the name field focus without a visual viewport', () => {
    vi.stubGlobal('visualViewport', undefined);
    render(<KioskApp/>);
    choosePin();
    const name = screen.getByLabelText('Your name');
    act(() => name.blur());
    expect(() => act(() => name.focus())).not.toThrow();
    expect(document.activeElement).toBe(name);
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
