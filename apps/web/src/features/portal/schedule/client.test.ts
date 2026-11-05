// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortalScheduleSession } from '@plaingym/shared/contracts';
import { portalClient } from './client.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const home = id(1), other = id(2);
const session = (n: number): PortalScheduleSession => ({ id: id(100 + n), name: 'Fundamentals', startsAt: '2026-10-30T18:00:00.000Z',
  endsAt: '2026-10-30T19:00:00.000Z', coachId: null, capacity: 10, status: 'scheduled', revision: 1,
  bookingOpensAt: '2026-10-23T00:00:00.000Z', cancelBefore: '2026-10-30T17:00:00.000Z', placesLeft: 4, bookings: [] });
const page = (householdId: string, offset: number, count: number, total: number) => Response.json({ householdId,
  data: Array.from({ length: count }, (_, i) => session(offset + i)), pagination: { limit: 100, offset, total } });
const from = '2026-10-29T00:00:00.000Z', to = '2026-11-05T00:00:00.000Z';
afterEach(() => vi.unstubAllGlobals());

describe('portal schedule client', () => {
  it('follows the pages and names the household they were all read for', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(page(home, 0, 100, 101)).mockResolvedValueOnce(page(home, 100, 1, 101)));
    const answer = await portalClient.schedule(from, to);
    expect(answer.householdId).toBe(home);
    expect(answer.data).toHaveLength(101);
  });
  it.each([[home, other], [other, home]])('names no household when the pages disagree (%s, then %s), so the answer never passes as either', async (first, second) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(page(first, 0, 100, 101)).mockResolvedValueOnce(page(second, 100, 1, 101)));
    const answer = await portalClient.schedule(from, to);
    expect(answer).toEqual({ householdId: '', data: [] });
    expect([home, other]).not.toContain(answer.householdId);
  });
});
