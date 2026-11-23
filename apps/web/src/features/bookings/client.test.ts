// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { bookingClient, type BookingCancelNotice } from './client.js';

afterEach(() => vi.unstubAllGlobals());
it('preserves structured booking conflicts for callers without exposing server messages', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'conflict', message: 'Private server detail', details: { reason: ['full'] } } }, { status: 409 })));
  await expect(bookingClient.book({ memberId: '0194a000-0000-7000-8000-000000000001',
    sessionId: '0194a000-0000-7000-8000-000000000002', allowWaitlist: false })).rejects.toMatchObject({ status: 409, reason: ['full'], message: 'Request failed' });
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
