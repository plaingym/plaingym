// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api.js';
import { reportClient } from './api.js';
import { attendanceFixture, membersFixture, revenueFixture } from './fixtures.js';

afterEach(() => vi.restoreAllMocks());
it('validates all three queries, forwards cancellation and parses compatible answers through each contract', async () => {
  const get = vi.spyOn(api, 'GET');
  const signal = new AbortController().signal;
  const range = { from: '2026-10', to: '2026-11' };
  get.mockResolvedValueOnce({ response: new Response('{}'), data: { data: { ...attendanceFixture, future: true }, future: true } } as never);
  expect(await reportClient.attendance({ ...range, granularity: 'month' }, signal)).toEqual(attendanceFixture);
  expect(get).toHaveBeenLastCalledWith('/api/reports/attendance', { params: { query: { ...range, granularity: 'month' } }, signal });
  get.mockResolvedValueOnce({ response: new Response('{}'), data: { data: membersFixture } } as never);
  expect(await reportClient.members(range, signal)).toEqual(membersFixture);
  expect(get).toHaveBeenLastCalledWith('/api/reports/members', { params: { query: range }, signal });
  get.mockResolvedValueOnce({ response: new Response('{}'), data: { data: revenueFixture } } as never);
  expect(await reportClient.revenue(range, signal)).toEqual(revenueFixture);
  expect(get).toHaveBeenLastCalledWith('/api/reports/revenue', { params: { query: range }, signal });
});
it.each(['attendance', 'members', 'revenue'] as const)('%s refuses invalid queries before transport and malformed successful answers', async report => {
  const get = vi.spyOn(api, 'GET').mockResolvedValue({ response: new Response('{}'), data: { data: {} } } as never);
  await expect(reportClient[report]({ from: '2026-11', to: '2026-10', granularity: 'month' })).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
  await expect(reportClient[report]({ from: '2026-10', to: '2026-11', ...(report === 'attendance' ? { granularity: 'month' as const } : {}) } as never)).rejects.toThrow();
});
it.each([403, 500])('preserves HTTP %i without exposing server error content', async status => {
  vi.spyOn(api, 'GET').mockResolvedValue({ response: new Response('{}', { status }), error: { message: 'private SQL' } });
  await expect(reportClient.members({ from: '2026-10', to: '2026-11' })).rejects.toMatchObject({ status, code: 'request_failed', message: 'Request failed' });
});
