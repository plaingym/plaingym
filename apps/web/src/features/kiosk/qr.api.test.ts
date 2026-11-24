// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { onApiError } from '../../lib/api.js';
import { qrCheckin, QrRequestError, staffCheckinCode } from './qr.api.js';
import { KioskAuthError } from './api.js';

afterEach(() => vi.unstubAllGlobals());
it('sends the QR only in the check-in body, omits cookies and rejects private fields in responses', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: { status: 'see_front_desk' } })); vi.stubGlobal('fetch', fetcher);
  await qrCheckin('device-token', 'code');
  expect(fetcher).toHaveBeenCalledWith('/api/kiosk/checkin/qr', expect.objectContaining({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    body: JSON.stringify({ code: 'code' }), headers: expect.objectContaining({ Authorization: 'Bearer device-token' }) }));
  fetcher.mockResolvedValueOnce(Response.json({ data: { status: 'see_front_desk', amount: 5000 } }));
  await expect(qrCheckin('device-token', 'code')).rejects.toThrow();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(qrCheckin('device-token', 'code')).rejects.toBeInstanceOf(KioskAuthError);
});
it('uses the staff session and expected revision to reset without a device token', async () => {
  const data = { memberId: '00000000-0000-7000-8000-000000000001', version: 2, revision: 3, code: 'code' };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data })); vi.stubGlobal('fetch', fetcher);
  expect(await staffCheckinCode(data.memberId, 'regenerate', 2)).toEqual(data);
  expect(fetcher).toHaveBeenCalledWith('/api/members/' + data.memberId + '/checkin-code', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ revision: 2 }) }));
  expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('headers.Authorization');
});
it('notifies once on a 403 refusal for QR check-in and staff check-in code requests', async () => {
  const observe = vi.fn(), stop = onApiError(observe);
  try {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { details: { reason: ['demo_showcase_read_only'] } } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: { details: { reason: ['demo_showcase_read_only'] } } }, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(qrCheckin('device-token', 'code')).rejects.toBeInstanceOf(KioskAuthError);
    expect(observe).toHaveBeenCalledTimes(1);
    const staffError = await staffCheckinCode('00000000-0000-7000-8000-000000000001').catch((value: unknown) => value);
    expect(staffError).toBeInstanceOf(QrRequestError);
    expect(staffError).toMatchObject({ status: 403 });
    expect(observe).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});
