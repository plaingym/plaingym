// SPDX-License-Identifier: AGPL-3.0-only
import { bookingsContracts, portalContextResponseSchema, portalContracts, portalScheduleContracts,
  type PortalContext } from '@plaingym/shared/contracts';
import { ApiError, createJsonTransport } from '../../../lib/api.js';

/** Created per call, so importing this module (through the registry) has no side effects. */
const request = <T>(path: string, body?: unknown) => createJsonTransport()<T>(path, body);
const query = (path: string, values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams(Object.entries(values).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]));
  return params.size ? `${path}?${params}` : path;
};
/** Booking paths for a member: an adult member books only for themself; the payer uses the household-member paths. */
function bookingPath(context: PortalContext, memberId: string) {
  return context.role === 'member' ? '/api/portal/bookings' : `/api/portal/members/${memberId}/bookings`;
}
export const portalClient = {
  async context() { return portalContextResponseSchema.parse(await request('/api/portal/context')).data; },
  async members() { return portalScheduleContracts.members.response.parse(await request(portalScheduleContracts.members.path)).data; },
  /** Every session in [from, to), following the server's pages. */
  async schedule(from: string, to: string) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const page = portalContracts.schedule.response.parse(await fetchJson(query(portalContracts.schedule.path, { from, to, limit: 100, offset })));
      rows.push(...page.data);
      if (offset + 100 >= page.pagination.total) return rows;
    }
  },
  async book(context: PortalContext, memberId: string, sessionId: string) {
    const response = context.role === 'member' ? bookingsContracts.createSelf.response : bookingsContracts.createHouseholdMember.response;
    return response.parse(await request(bookingPath(context, memberId), { sessionId, allowWaitlist: true })).data;
  },
  async cancel(context: PortalContext, memberId: string, bookingId: string) {
    return bookingsContracts.cancelSelf.response.parse(await request(`${bookingPath(context, memberId)}/${bookingId}/cancel`, {})).data;
  },
  async checkinCode(memberId: string) {
    return portalContracts.checkinCode.response.parse(await request(`/api/portal/members/${memberId}/checkin-code`)).data;
  },
  async regenerateCheckin(memberId: string, revision: number) {
    return portalContracts.regenerateCheckin.response.parse(await request(`/api/portal/members/${memberId}/checkin-code`, { revision })).data;
  },
  async progress(memberId: string) {
    return portalContracts.progress.response.parse(await request(`/api/portal/members/${memberId}/progress`)).data;
  },
  async attendance(memberId: string, offset: number, limit = 20) {
    return portalContracts.attendance.response.parse(await fetchJson(query(`/api/portal/members/${memberId}/attendance`, { limit, offset })));
  },
};
export type PortalClient = typeof portalClient;

/** The shared transport refuses query strings, so reads with filters use the same same-origin options here. */
async function fetchJson(path: string): Promise<unknown> {
  if (!path.startsWith('/api/portal/')) throw new Error('Expected a portal API path');
  const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, response.status === 429 ? 'rate_limited' : 'request_failed');
  return response.json();
}
