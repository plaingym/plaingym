// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { bookingsContracts, membersContracts, scheduleContracts, type CreateBookingRequest } from '@plaingym/shared/contracts';
import { addDays, localMidnight } from '@plaingym/shared/time';
import { refusalError } from '../../lib/api.js';

export interface BookingCancelNotice { channels: ('email' | 'sms')[]; note?: string }
async function request(path: string, query: Record<string, string | number> = {}, body?: unknown) {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const response = await fetch(path + (params.size ? '?' + params : ''), { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await refusalError(response, 'booking_request_failed');
  return response.json() as Promise<unknown>;
}
export const bookingClient = {
  async roster(sessionId: string, offset: number) {
    return parseResponse(bookingsContracts.roster.response, await request(`/api/bookings/sessions/${sessionId}/roster`, { limit: 50, offset }));
  },
  async list(memberId: string, offset: number) {
    return parseResponse(bookingsContracts.list.response, await request(bookingsContracts.list.path, { memberId, limit: 50, offset }));
  },
  /** The staff booking picker offers no erased or Cancelled members. */
  async members(search: string) {
    return parseResponse(membersContracts.listMembers.response, await request('/api/members',
      { ...(search ? { search } : {}), checkInEligible: 'true', limit: 50, offset: 0 })).data;
  },
  async session(id: string) { return parseResponse(scheduleContracts.getSession.response, await request(`/api/schedule/sessions/${id}`)).data; },
  async sessions(date: string, timezone: string) {
    const from = localMidnight(date, timezone).toISOString();
    const until = localMidnight(addDays(date, 1), timezone).toISOString();
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const page = parseResponse(scheduleContracts.listSessions.response, await request('/api/schedule/sessions', { from, until, status: 'scheduled', limit: 100, offset }));
      rows.push(...page.data.filter(row => row.capacity !== null));
      if (offset + 100 >= page.pagination.total) return rows;
    }
  },
  async book(input: CreateBookingRequest) { return parseResponse(bookingsContracts.create.response, await request('/api/bookings', {}, bookingsContracts.create.body.parse(input))).data; },
  /** Without a notice the body carries no notice fields. The note is sent only with the email channel. */
  async cancel(id: string, notice?: BookingCancelNotice) {
    const body = notice?.channels.length ? { notify: true, channels: notice.channels,
      ...(notice.channels.includes('email') && notice.note?.trim() ? { note: notice.note } : {}) } : {};
    return parseResponse(bookingsContracts.cancel.response, await request(`/api/bookings/${id}/cancel`, {}, bookingsContracts.cancel.body.parse(body))).data;
  },
};
