// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attendanceClient } from './client.js';
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const entry = (n: number) => ({ id: id(n), memberId: id(1), sessionId: id(2), programId: null,
  source: 'coach', kind: 'class', occurredAt: '2026-10-22T12:00:00Z', createdAt: '2026-10-22T12:00:00Z' });
afterEach(() => vi.unstubAllGlobals());
describe('attendance HTTP client', () => {
  it('validates the undo ID, posts with the session, and validates the deleted attendance', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: entry(10) }));
    vi.stubGlobal('fetch', fetcher);
    expect(await attendanceClient.undo(id(10))).toEqual(entry(10));
    expect(fetcher).toHaveBeenCalledWith(`/api/attendance/${id(10)}/undo`, expect.objectContaining({ method: 'POST', credentials: 'same-origin', redirect: 'error' }));
    await expect(attendanceClient.undo('invalid')).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(Response.json({ error: 'private detail' }, { status: 404 }));
    await expect(attendanceClient.undo(id(10))).rejects.toThrow('Attendance request failed');
    fetcher.mockResolvedValueOnce(Response.json({ data: { id: id(10) } }));
    await expect(attendanceClient.undo(id(10))).rejects.toThrow();
  });
  it('reads the eligible session roster page and validates the session ID and response', async () => {
    const counts = { booked: 0, waitlisted: 0, checkedIn: 1 };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [{ displayName: 'River Lee', booking: null, attendance: entry(10) }],
      pagination: { limit: 50, offset: 50, total: 51 }, counts }));
    vi.stubGlobal('fetch', fetcher);
    expect((await attendanceClient.roster(id(2), 50)).counts).toEqual(counts);
    const url = new URL(String(fetcher.mock.calls[0]![0]), 'https://gym.test');
    expect(url.pathname).toBe(`/api/bookings/sessions/${id(2)}/roster`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ checkInEligible: 'true', limit: '50', offset: '50' });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
    await expect(attendanceClient.roster('../members', 0)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(Response.json({ data: [], pagination: { limit: 50, offset: 0, total: 0 } }));
    await expect(attendanceClient.roster(id(2), 0)).rejects.toThrow();
  });
  it('looks up walk-ins among eligible members only and supports paging', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [], pagination: { limit: 50, offset: 0, total: 0 } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await attendanceClient.members('River')).toEqual([]);
    const url = new URL(String(fetcher.mock.calls[0]![0]), 'https://gym.test');
    expect(url.pathname).toBe('/api/members');
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: 'River', checkInEligible: 'true', limit: '50', offset: '0' });
    fetcher.mockResolvedValueOnce(Response.json({ data: [], pagination: { limit: 50, offset: 50, total: 0 } }));
    expect(await attendanceClient.members('River', 50)).toEqual([]);
    const pageTwo = new URL(String(fetcher.mock.calls[1]![0]), 'https://gym.test');
    expect(Object.fromEntries(pageTwo.searchParams)).toEqual({ search: 'River', checkInEligible: 'true', limit: '50', offset: '50' });
  });
  it('checks whether a specific visit still exists for the member and session', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [entry(10)], pagination: { limit: 1, offset: 0, total: 1 } }))
      .mockResolvedValueOnce(Response.json({ data: [entry(11)], pagination: { limit: 1, offset: 0, total: 1 } }))
      .mockResolvedValueOnce(Response.json({ data: [], pagination: { limit: 1, offset: 0, total: 0 } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await attendanceClient.visitExists(id(10), id(1), id(2))).toBe(true);
    const url = new URL(String(fetcher.mock.calls[0]![0]), 'https://gym.test');
    expect(url.pathname).toBe('/api/attendance');
    expect(Object.fromEntries(url.searchParams)).toEqual({ memberId: id(1), sessionId: id(2), limit: '1', offset: '0' });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
    expect(await attendanceClient.visitExists(id(10), id(1), id(2))).toBe(false);
    expect(await attendanceClient.visitExists(id(10), id(1), id(2))).toBe(false);
    await expect(attendanceClient.visitExists(id(10), 'invalid', id(2))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValueOnce(Response.json({ error: 'private detail' }, { status: 500 }));
    await expect(attendanceClient.visitExists(id(10), id(1), id(2))).rejects.toThrow('Attendance request failed');
    fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: id(10) }], pagination: { limit: 1, offset: 0, total: 1 } }));
    await expect(attendanceClient.visitExists(id(10), id(1), id(2))).rejects.toThrow();
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
    await expect(attendanceClient.roster(id(2), 0)).rejects.toThrow('Attendance request failed');
    await expect(attendanceClient.members('River')).rejects.toThrow('Attendance request failed');
    await expect(attendanceClient.record({ memberId: id(1), sessionId: null, programId: null })).rejects.toThrow('Attendance request failed');
  });
});
