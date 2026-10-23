// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetToken, kioskApi, KioskAuthError, readToken, saveToken } from './api.js';

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); window.history.replaceState(null, '', '/kiosk'); });
describe('kiosk device transport', () => {
  it('takes a device token out of the fragment and never puts credentials or rosters in the URL', () => {
    window.history.replaceState(null, '', '/kiosk#token=new-device');
    expect(readToken()).toBe('new-device');
    expect(window.location.hash).toBe('');
    expect(window.localStorage.length).toBe(1);
    saveToken(' replacement ');
    expect(readToken()).toBe('replacement');
    forgetToken(); expect(readToken()).toBeNull();
  });
  it('uses only the device bearer, disables caching and sends each request once', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { status: 'see_front_desk' } })));
    vi.stubGlobal('fetch', fetcher);
    expect(await kioskApi.lookup('device', 'Rivera', '0042')).toEqual({ status: 'see_front_desk' });
    expect(fetcher).toHaveBeenCalledWith('/api/kiosk/lookup', expect.objectContaining({
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer device' }),
      body: JSON.stringify({ name: 'Rivera', pin: '0042' }), signal: expect.any(AbortSignal),
    }));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('never retries a failed open-mat request or shows server error details', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('past due $123.45', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(kioskApi.checkin('device', { name: 'Rivera', pin: '0042', checkins: [{ memberId: 'member', sessionId: null }] })).rejects.toThrow('Request failed');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 404])('recognizes an invalid device (%s)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(kioskApi.lookup('device', 'Rivera', '0042')).rejects.toBeInstanceOf(KioskAuthError);
  });
  it('rejects lookup responses carrying extra private data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { status: 'see_front_desk', amount: 12345 } }))));
    await expect(kioskApi.lookup('device', 'Rivera', '0042')).rejects.toThrow();
  });
});
