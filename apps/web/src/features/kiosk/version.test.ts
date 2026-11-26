// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { checkServerVersion, isVersionReloadPending } from '../../app/version.js';
import { KioskReloadError, kioskApi } from './api.js';
import { qrCheckin } from './qr.api.js';

vi.mock('../../app/version.js', () => ({ checkServerVersion: vi.fn(), isVersionReloadPending: vi.fn(() => false) }));
afterEach(() => {
  vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  // A test that drives the real version module gets a fresh copy of its throttle and stale state.
  vi.resetModules();
  sessionStorage.removeItem('plaingym-version-reload');
});
const calls = [
  () => kioskApi.lookup('device', 'Name', '1234'),
  () => kioskApi.checkin('device', { name: 'Name', pin: '1234', checkins: [] }),
  () => qrCheckin('device', 'code'),
  () => qrCheckin('device', 'code', null),
];
it.each(calls)('holds credentials while a navigation check has already scheduled a reload', async (call) => {
  vi.stubEnv('DEV', false);
  vi.mocked(isVersionReloadPending).mockReturnValue(true);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(call()).rejects.toBeInstanceOf(KioskReloadError);
  expect(fetcher).not.toHaveBeenCalled();
  expect(checkServerVersion).not.toHaveBeenCalled();
});
it.each(calls)('checks the release before each kiosk request', async (call) => {
  vi.stubEnv('DEV', false);
  vi.mocked(isVersionReloadPending).mockReturnValue(false);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { status: 'see_front_desk' } }));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(checkServerVersion).mockImplementation(async () => { expect(fetcher).not.toHaveBeenCalled(); });
  // The family response uses an array, so its schema can reject this fixture after the guard.
  await call().catch(() => undefined);
  expect(checkServerVersion).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each(calls)('holds credentials when the shared check schedules a fresh reload', async (call) => {
  vi.stubEnv('DEV', false);
  vi.mocked(isVersionReloadPending).mockReturnValue(false);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const probe = Promise.withResolvers<void>();
  vi.mocked(checkServerVersion).mockReturnValue(probe.promise);
  const pending = call();
  expect(fetcher).not.toHaveBeenCalled();
  vi.mocked(isVersionReloadPending).mockReturnValue(true);
  probe.resolve();
  await expect(pending).rejects.toBeInstanceOf(KioskReloadError);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(calls)('still sends the request when the release guard itself fails', async (call) => {
  vi.stubEnv('DEV', false);
  vi.mocked(isVersionReloadPending).mockReturnValue(false);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { status: 'see_front_desk' } }));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(checkServerVersion).mockRejectedValue(new Error('The page could not load the server version'));
  await call().catch(() => undefined);
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([
  { direction: 'backward', jump: -3_600_000 },
  { direction: 'forward', jump: 3_600_000 },
])('rechecks at the reload deadline after a $direction clock jump and drops fields a newer server adds to stale lookup replies', async ({ jump }) => {
  vi.stubEnv('DEV', false);
  vi.useFakeTimers({ toFake: ['Date'] });
  const wallStart = 10_000_000;
  vi.setSystemTime(wallStart);
  const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
  const version = await vi.importActual<typeof import('../../app/version.js')>('../../app/version.js');
  const built = { version: '1.3.0', commit: '3'.repeat(40) };
  const remote = { ...built, version: '1.4.0' };
  const reload = vi.fn();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(remote))
    .mockResolvedValueOnce(Response.json(remote))
    .mockResolvedValueOnce(Response.json({ data: { status: 'see_front_desk' } }))
    .mockResolvedValueOnce(Response.json({ data: { status: 'see_front_desk', amount: 42 } }));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(checkServerVersion).mockImplementation(options => version.checkServerVersion({ ...options, built }));
  vi.mocked(isVersionReloadPending).mockImplementation(version.isVersionReloadPending);

  await version.checkOnNavigation({ preload: false, location: { href: '/kiosk' } }, { built, reload, development: false });
  elapsed.mockReturnValue(9_999);
  vi.setSystemTime(wallStart + 9_999 + jump);
  await expect(kioskApi.lookup('device', 'Name', '1234')).rejects.toBeInstanceOf(KioskReloadError);
  expect(fetcher).toHaveBeenCalledOnce();

  elapsed.mockReturnValue(10_000);
  vi.setSystemTime(wallStart + 10_000 + jump);
  await expect(kioskApi.lookup('device', 'Name', '1234')).resolves.toEqual({ status: 'see_front_desk' });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/healthz', '/healthz', '/api/kiosk/lookup']);
  expect(version.isStaleVersion()).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
  // A stale bundle drops a field the newer server adds instead of refusing the answer.
  await expect(kioskApi.lookup('device', 'Name', '1234')).resolves.toStrictEqual({ status: 'see_front_desk' });
  expect(fetcher).toHaveBeenCalledTimes(4);
});
