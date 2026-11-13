// SPDX-License-Identifier: AGPL-3.0-only
import { bookingsContracts, portalContracts, portalScheduleContracts, type PortalContext, type PortalScheduleSession } from '@plaingym/shared/contracts';
import { ApiError, apiErrorReasons, createJsonTransport } from '../../../lib/api.js';
import { parseResponse } from '../../../lib/response.js';
import { householdTransport } from '../household/api.js';

/** A translated booking refusal safe to show to the member. */
export class BookingConflictError extends Error { readonly status = 409; }
const request = <T>(path: string, body?: unknown, householdId?: string) => {
  const fetcher = householdId ? householdTransport(householdId) : fetch;
  return createJsonTransport(async (input, init) => {
    const response = await fetcher(input, init);
    // Only the booking service's coded refusals are translated for members; a generic conflict keeps the generic text.
    if (response.status === 409 && path.includes('/bookings') && (await apiErrorReasons(response)).length) {
      const answer: unknown = await response.clone().json().catch(() => null);
      const error = (answer as { error?: { message?: unknown } } | null)?.error;
      if (typeof error?.message === 'string' && error.message.trim()) throw new BookingConflictError(error.message);
    }
    return response;
  })<T>(path, body);
};
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
  async context() { return parseResponse(portalContracts.context.response, await request(portalContracts.context.path)); },
  async members() { return parseResponse(portalScheduleContracts.members.response, await request(portalScheduleContracts.members.path)); },
  /**
   * Every session in [from, to), following the server's pages. The answer names the household every page was read for; if a
   * later page names another one than the first, the server moved on mid-read, and the answer names no household (''), which is
   * never the open one, so it is never kept. Either page's household could be the open one (the session can move and move back).
   */
  async schedule(from: string, to: string): Promise<{ householdId: string; data: PortalScheduleSession[] }> {
    const rows = [];
    let householdId: string | undefined;
    for (let offset = 0; ; offset += 100) {
      const page = parseResponse(portalContracts.schedule.response, await fetchJson(query(portalContracts.schedule.path, { from, to, limit: 100, offset })));
      if (householdId !== undefined && page.householdId !== householdId) return { householdId: '', data: [] };
      householdId = page.householdId;
      rows.push(...page.data);
      if (offset + 100 >= page.pagination.total) return { householdId, data: rows };
    }
  },
  async book(context: PortalContext, memberId: string, sessionId: string, householdId: string) {
    const response = context.role === 'member' ? bookingsContracts.createSelf.response : bookingsContracts.createHouseholdMember.response;
    return parseResponse(response, await request(bookingPath(context, memberId), { sessionId, allowWaitlist: true }, householdId)).data;
  },
  async cancel(context: PortalContext, memberId: string, bookingId: string, householdId: string) {
    return parseResponse(bookingsContracts.cancelSelf.response, await request(`${bookingPath(context, memberId)}/${bookingId}/cancel`, {}, householdId)).data;
  },
  async checkinCode(memberId: string, householdId: string) {
    return parseResponse(portalContracts.checkinCode.response, await request(`/api/portal/members/${memberId}/checkin-code`, undefined, householdId));
  },
  async regenerateCheckin(memberId: string, revision: number, householdId: string) {
    return parseResponse(portalContracts.regenerateCheckin.response, await request(`/api/portal/members/${memberId}/checkin-code`, { revision }, householdId));
  },
  async progress(memberId: string, householdId: string) {
    return parseResponse(portalContracts.progress.response, await request(`/api/portal/members/${memberId}/progress`, undefined, householdId));
  },
  async attendance(memberId: string, offset: number, householdId: string, limit = 20) {
    return parseResponse(portalContracts.attendance.response, await fetchJson(query(`/api/portal/members/${memberId}/attendance`, { limit, offset }), householdId));
  },
};
export type PortalClient = typeof portalClient;

/** The shared transport refuses query strings, so reads with filters use the same same-origin options here. */
async function fetchJson(path: string, householdId?: string): Promise<unknown> {
  if (!path.startsWith('/api/portal/')) throw new Error('Expected a portal API path');
  const fetcher = householdId ? householdTransport(householdId) : fetch;
  const response = await fetcher(path, { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, response.status === 429 ? 'rate_limited' : 'request_failed');
  return response.json();
}
