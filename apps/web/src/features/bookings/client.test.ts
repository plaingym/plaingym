// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { bookingClient } from './client.js';

afterEach(() => vi.unstubAllGlobals());
it('preserves structured booking conflicts for callers without exposing server messages', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'conflict', message: 'Private server detail', details: { reason: ['full'] } } }, { status: 409 })));
  await expect(bookingClient.book({ memberId: '0194a000-0000-7000-8000-000000000001',
    sessionId: '0194a000-0000-7000-8000-000000000002', allowWaitlist: false })).rejects.toMatchObject({ status: 409, reason: ['full'], message: 'Request failed' });
});
