// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, onApiError } from '../../lib/api.js';
import { bookingClient, type BookingCancelNotice } from './client.js';

afterEach(() => vi.unstubAllGlobals());
it('offers only eligible members to the staff booking picker, and keeps the full staff roster request', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [], pagination: { limit: 50, offset: 0, total: 0 } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await bookingClient.members('River')).toEqual([]);
  const lookup = new URL(String((fetcher.mock.calls[0] as unknown[])[0]), 'https://gym.test');
  expect(lookup.pathname).toBe('/api/members');
  expect(Object.fromEntries(lookup.searchParams)).toEqual({ search: 'River', checkInEligible: 'true', limit: '50', offset: '0' });
  fetcher.mockImplementationOnce(async () => Response.json({ data: [], pagination: { limit: 50, offset: 0, total: 0 }, counts: { booked: 0, waitlisted: 0, checkedIn: 0 } }));
  await bookingClient.roster('0194a000-0000-7000-8000-000000000002', 0);
  const roster = new URL(String((fetcher.mock.calls[1] as unknown[])[0]), 'https://gym.test');
  expect(Object.fromEntries(roster.searchParams)).toEqual({ limit: '50', offset: '0' });
});
it('preserves structured booking conflicts for callers without exposing server messages', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'conflict', message: 'Private server detail', details: { reason: ['full'] } } }, { status: 409 })));
  await expect(bookingClient.book({ memberId: '0194a000-0000-7000-8000-000000000001',
    sessionId: '0194a000-0000-7000-8000-000000000002', allowWaitlist: false })).rejects.toMatchObject({ status: 409, reason: ['full'], message: 'Request failed' });
});
it('notifies once for a 403 refusal and stays silent for a 409 conflict', async () => {
  const observe = vi.fn(), stop = onApiError(observe);
  try {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { details: { reason: ['demo_showcase_read_only'] } } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: { details: { reason: ['full'] } } }, { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const forbidden = await bookingClient.members('').catch((value: unknown) => value);
    expect(forbidden).toBeInstanceOf(ApiError);
    expect(forbidden).toMatchObject({ status: 403, code: 'booking_request_failed', reason: ['demo_showcase_read_only'] });
    expect(observe).toHaveBeenCalledOnce();
    await expect(bookingClient.members('')).rejects.toMatchObject({ status: 409, code: 'booking_request_failed', reason: ['full'] });
    expect(observe).toHaveBeenCalledOnce();
  } finally { stop(); }
});
it('sends notice fields only for a chosen channel, and the note only with email', async () => {
  const id = '0194a000-0000-7000-8000-000000000003';
  const cancelled = { id, memberId: id, sessionId: id, createdAt: '2026-11-02T16:00:00Z', bookedBy: id, bookedByKind: 'staff',
    status: 'cancelled', waitlistPosition: null, queueRank: null, cancelledAt: '2026-11-02T16:00:00Z' };
  const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ data: cancelled }));
  vi.stubGlobal('fetch', fetch);
  const notices: (BookingCancelNotice | undefined)[] = [undefined, { channels: [] }, { channels: ['email'], note: 'Moved to Monday' },
    { channels: ['sms'], note: 'Email only' }, { channels: ['email', 'sms'], note: '  ' }];
  for (const notice of notices) await bookingClient.cancel(id, notice);
  expect(fetch.mock.calls.map(([path, init]) => [path, init.method, JSON.parse(String(init.body))])).toEqual([
    [`/api/bookings/${id}/cancel`, 'POST', {}], [`/api/bookings/${id}/cancel`, 'POST', {}],
    [`/api/bookings/${id}/cancel`, 'POST', { notify: true, channels: ['email'], note: 'Moved to Monday' }],
    [`/api/bookings/${id}/cancel`, 'POST', { notify: true, channels: ['sms'] }],
    [`/api/bookings/${id}/cancel`, 'POST', { notify: true, channels: ['email', 'sms'] }],
  ]);
});
