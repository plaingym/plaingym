// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold } from '@plaingym/db';
import { memberBookingListQuerySchema, memberBookingSchema, type MemberBookingListQuery, type MemberCreateBookingRequest } from '@plaingym/shared/contracts';
import type { MemberPermission } from '@plaingym/shared';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import { notFound } from '../../core/interfaces/common.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createBookingService, type BookingService } from '../bookings/bookings.js';
import type { BookingDelivery } from '../bookings/bookings.delivery.js';

export function createPortalBookingService(options: {
  households?: MemberHouseholdContext; householdScope?: typeof forHousehold; bookings?: BookingService;
  delivery?: () => BookingDelivery | undefined;
} = {}) {
  const households = options.households ?? createMemberHouseholdContext(), scope = options.householdScope ?? forHousehold;
  const bookings = options.bookings ?? createBookingService();
  async function target(identity: PortalIdentity, memberId?: string) {
    const resolved = await households.resolve(identity), id = memberId ?? resolved.memberId;
    if (!id) notFound();
    const permission: MemberPermission = memberId ? 'bookings.household' : 'bookings.self';
    await households.requireMember(identity, id, permission);
    await read(identity, async queries => { if (!(await queries.member(id))[0]) notFound(); });
    return id;
  }
  async function read<T>(identity: PortalIdentity, fn: Parameters<typeof forHousehold<T>>[1]) {
    try { return await scope({ kind: 'user', ...identity }, fn); }
    catch (error) { if (error instanceof Error && error.message === 'Household access denied') notFound(); throw error; }
  }
  const actor = (identity: PortalIdentity) => ({ gymId: identity.gymId, actor: { kind: 'user' as const, userId: identity.userId }, portal: identity });
  return {
    async list(identity: PortalIdentity, input: MemberBookingListQuery, memberId?: string) {
      const id = await target(identity, memberId), query = memberBookingListQuerySchema.parse(input);
      if (query.sessionId) await bookings.requireSession(identity.gymId, query.sessionId);
      const rows = (await read(identity, queries => queries.bookings())).filter(row => row.memberId === id
        && (!query.sessionId || row.sessionId === query.sessionId) && (!query.status || row.status === query.status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      const projected = await bookings.project(identity.gymId, rows.slice(query.offset, query.offset + query.limit));
      return { data: projected.map(portalView), pagination: { limit: query.limit, offset: query.offset, total: rows.length } };
    },
    async book(identity: PortalIdentity, input: MemberCreateBookingRequest, memberId?: string) {
      const id = await target(identity, memberId);
      return portalView(await bookings.book(actor(identity), { ...input, memberId: id }));
    },
    async cancel(identity: PortalIdentity, bookingId: string, memberId?: string) {
      const id = await target(identity, memberId);
      if (!(await read(identity, queries => queries.bookings())).some(row => row.id === bookingId && row.memberId === id)) notFound();
      const row = await bookings.cancel(actor(identity), bookingId, id);
      await options.delivery?.()?.request(identity.gymId, row.sessionId, row.id);
      return portalView(row);
    },
  };
}
function portalView(row: Awaited<ReturnType<BookingService['book']>>) {
  return memberBookingSchema.parse({ id: row.id, memberId: row.memberId, sessionId: row.sessionId,
    status: row.status, waitlistPosition: row.waitlistPosition, queueRank: row.queueRank,
    createdAt: row.createdAt, cancelledAt: row.cancelledAt });
}
