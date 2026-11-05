// SPDX-License-Identifier: AGPL-3.0-only
import { bookingsContracts, portalContracts, portalScheduleContracts, type PortalContext, type PortalScheduleSession } from '@plaingym/shared/contracts';
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
/**
 * Portal reads return the whole answer, which names the household it was read for; the page checks it against the household
 * its key names before keeping anything (`PortalScope.own`). Booking answers come from the bookings contracts and name none.
 */
export const portalClient = {
  async context() { return portalContracts.context.response.parse(await request(portalContracts.context.path)); },
  async members() { return portalScheduleContracts.members.response.parse(await request(portalScheduleContracts.members.path)); },
  /**
   * Every session in [from, to), following the server's pages. The answer names the household every page was read for; if a
   * later page names another one than the first, the server moved on mid-read, and the answer names no household (''), which is
   * never the open one, so it is never kept. Either page's household could be the open one (the session can move and move back).
   */
  async schedule(from: string, to: string): Promise<{ householdId: string; data: PortalScheduleSession[] }> {
    const rows = [];
    let householdId: string | undefined;
    for (let offset = 0; ; offset += 100) {
      const page = portalContracts.schedule.response.parse(await fetchJson(query(portalContracts.schedule.path, { from, to, limit: 100, offset })));
      if (householdId !== undefined && page.householdId !== householdId) return { householdId: '', data: [] };
      householdId = page.householdId;
      rows.push(...page.data);
      if (offset + 100 >= page.pagination.total) return { householdId, data: rows };
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
    return portalContracts.checkinCode.response.parse(await request(`/api/portal/members/${memberId}/checkin-code`));
  },
  async regenerateCheckin(memberId: string, revision: number) {
    return portalContracts.regenerateCheckin.response.parse(await request(`/api/portal/members/${memberId}/checkin-code`, { revision }));
  },
  async progress(memberId: string) {
    return portalContracts.progress.response.parse(await request(`/api/portal/members/${memberId}/progress`));
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
