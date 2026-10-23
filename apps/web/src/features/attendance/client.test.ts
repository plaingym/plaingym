// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attendanceClient } from './client.js';
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const entry = (n: number) => ({ id: id(n), memberId: id(1), sessionId: id(2), programId: null,
  source: 'coach', kind: 'class', occurredAt: '2026-10-22T12:00:00Z', createdAt: '2026-10-22T12:00:00Z' });
afterEach(() => vi.unstubAllGlobals());
describe('attendance HTTP client', () => {
  it('loads every roster attendance page with the session filter and validates responses', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: Array.from({ length: 100 }, (_, i) => entry(i + 10)),
      pagination: { limit: 100, offset: 0, total: 101 } }))
      .mockResolvedValueOnce(Response.json({ data: [entry(110)], pagination: { limit: 100, offset: 100, total: 101 } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await attendanceClient.checkedIn(id(2))).toHaveLength(101);
    const calls = fetcher.mock.calls.map((call) => new URL(String(call[0]), 'https://gym.test'));
    expect(calls.map((url) => url.searchParams.get('offset'))).toEqual(['0', '100']);
    for (const url of calls) expect(url.searchParams.get('sessionId')).toBe(id(2));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
  });
  it('validates coach input and cannot submit an arbitrary source or import key', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: entry(10) }));
    vi.stubGlobal('fetch', fetcher);
    await attendanceClient.record({ memberId: id(1), sessionId: id(2), programId: null });
    expect(fetcher).toHaveBeenCalledWith('/api/attendance', expect.objectContaining({ method: 'POST', credentials: 'same-origin',
      body: JSON.stringify({ memberId: id(1), sessionId: id(2), programId: null }) }));
    await expect(attendanceClient.record({ memberId: 'invalid', sessionId: null, programId: null })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects failed responses without displaying backend errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'private detail' }, { status: 500 })));
    await expect(attendanceClient.checkedIn(id(2))).rejects.toThrow('Attendance request failed');
    await expect(attendanceClient.record({ memberId: id(1), sessionId: null, programId: null })).rejects.toThrow('Attendance request failed');
  });
});
