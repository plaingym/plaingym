// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { checkServerVersion, isVersionReloadPending } from '../../app/version.js';
import { KioskReloadError, kioskApi } from './api.js';
import { qrCheckin } from './qr.api.js';

vi.mock('../../app/version.js', () => ({ checkServerVersion: vi.fn(), isVersionReloadPending: vi.fn(() => false) }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
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
  // The family response uses an array; strict parsing can reject this fixture after the guard.
  await call().catch(() => undefined);
  expect(checkServerVersion).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each(calls)('does not send credentials when the release guard stops the old bundle', async (call) => {
  vi.stubEnv('DEV', false);
  vi.mocked(isVersionReloadPending).mockReturnValue(false);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  vi.mocked(checkServerVersion).mockRejectedValue(new KioskReloadError('Loading the current kiosk'));
  await expect(call()).rejects.toThrow('Loading the current kiosk');
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
