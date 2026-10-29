// SPDX-License-Identifier: AGPL-3.0-only
import { bookingsContracts, membersContracts, scheduleContracts, type CreateBookingRequest } from '@plaingym/shared/contracts';
import { addDays, zonedInstant } from '@plaingym/shared/time';
import { ApiError } from '../../lib/api.js';

async function request(path: string, query: Record<string, string | number> = {}, body?: unknown) {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const response = await fetch(path + (params.size ? '?' + params : ''), { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new ApiError(response.status, 'booking_request_failed');
  return response.json() as Promise<unknown>;
}
export const bookingClient = {
  async roster(sessionId: string, offset: number) {
    return bookingsContracts.roster.response.parse(await request(`/api/bookings/sessions/${sessionId}/roster`, { limit: 50, offset }));
  },
  async list(memberId: string, offset: number) {
    return bookingsContracts.list.response.parse(await request(bookingsContracts.list.path, { memberId, limit: 50, offset }));
  },
  async members(search: string) {
    return membersContracts.listMembers.response.parse(await request('/api/members', { ...(search ? { search } : {}), limit: 50, offset: 0 })).data;
  },
  async member(id: string) { return membersContracts.getMember.response.parse(await request(`/api/members/${id}`)).data; },
  async session(id: string) { return scheduleContracts.getSession.response.parse(await request(`/api/schedule/sessions/${id}`)).data; },
  async sessions(date: string, timezone: string) {
    const from = zonedInstant(date, '00:00', timezone, { gap: 'shift' })!.toISOString();
    const until = zonedInstant(addDays(date, 1), '00:00', timezone, { gap: 'shift' })!.toISOString();
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const page = scheduleContracts.listSessions.response.parse(await request('/api/schedule/sessions', { from, until, status: 'scheduled', limit: 100, offset }));
      rows.push(...page.data.filter(row => row.capacity !== null));
      if (offset + 100 >= page.pagination.total) return rows;
    }
  },
  async book(input: CreateBookingRequest) { return bookingsContracts.create.response.parse(await request('/api/bookings', {}, bookingsContracts.create.body.parse(input))).data; },
  async cancel(id: string) { return bookingsContracts.cancel.response.parse(await request(`/api/bookings/${id}/cancel`, {}, {})).data; },
};
