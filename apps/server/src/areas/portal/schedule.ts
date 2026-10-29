// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold } from '@plaingym/db';
import { memberBookingSchema, portalScheduleQuerySchema, portalScheduleSessionSchema,
  type ClassBooking, type PortalScheduleQuery } from '@plaingym/shared/contracts';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { notFound } from '../../core/interfaces/common.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createBookingService, type BookingService } from '../bookings/bookings.js';
import { bookingOpensAt, cancellationCutoffAt } from '../bookings/bookings.rules.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createGymSettingsAccessor } from '../settings/settings.js';

type ScheduleService = Pick<ReturnType<typeof createScheduleService>, 'listSessions'>;
export interface PortalScheduleOptions {
  households?: MemberHouseholdContext; householdScope?: typeof forHousehold;
  schedule?: ScheduleService; bookings?: BookingService; settings?: GymSettingsAccessor;
}
/** Portal responses omit the user who created a booking. */
export function memberBookingView({ bookedBy: _by, bookedByKind: _kind, ...row }: ClassBooking) { return memberBookingSchema.parse(row); }

/** The gym's class schedule with the booking engine's times and open-place counts, plus this login's own places. */
export function createPortalScheduleService(options: PortalScheduleOptions = {}) {
  const households = options.households ?? createMemberHouseholdContext(), scope = options.householdScope ?? forHousehold;
  const schedule = options.schedule ?? createScheduleService(), bookings = options.bookings ?? createBookingService();
  const settings = options.settings ?? createGymSettingsAccessor();
  async function read<T>(identity: PortalIdentity, fn: Parameters<typeof forHousehold<T>>[1]) {
    try { return await scope({ kind: 'user', ...identity }, fn); }
    catch (error) { if (error instanceof Error && error.message === 'Household access denied') notFound(); throw error; }
  }
  return {
    async sessions(identity: PortalIdentity, input: PortalScheduleQuery) {
      const query = portalScheduleQuerySchema.parse(input);
      // The grant is reloaded on every request; the visible members bound whose places are listed.
      const context = await households.resolve(identity), visible = new Set(context.visibleMemberIds);
      const page = await schedule.listSessions(identity.gymId, { from: query.from, until: query.to, limit: query.limit, offset: query.offset });
      const ids = new Set(page.data.map(session => session.id)), gym = await settings.get(identity.gymId);
      const own = (await read(identity, queries => queries.bookings()))
        .filter(row => visible.has(row.memberId) && ids.has(row.sessionId) && row.status !== 'cancelled')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      const [places, projected] = await Promise.all([bookings.openPlaces(identity.gymId, [...ids]), bookings.project(identity.gymId, own)]);
      return { pagination: page.pagination, data: page.data.map(session => {
        const startsAt = new Date(session.startsAt);
        return portalScheduleSessionSchema.parse({ id: session.id, name: session.name, startsAt: session.startsAt, endsAt: session.endsAt,
          coachId: session.coachId, capacity: session.capacity, status: session.status, revision: session.revision,
          bookingOpensAt: bookingOpensAt(startsAt, gym).toISOString(), cancelBefore: cancellationCutoffAt({ startsAt }, gym).toISOString(),
          placesLeft: session.capacity === null ? null : places.get(session.id) ?? 0,
          bookings: projected.filter(row => row.sessionId === session.id).map(memberBookingView) });
      }) };
    },
    /** Display names only. The payer sees the household; an adult member sees themself. Erased and cancelled members are left out. */
    async members(identity: PortalIdentity) {
      const context = await households.resolve(identity), visible = new Set(context.visibleMemberIds);
      const rows = await read(identity, queries => queries.members());
      return rows.filter(row => visible.has(row.id) && row.status !== 'cancelled')
        .sort((a, b) => Number(b.id === context.memberId) - Number(a.id === context.memberId)
          || a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName) || a.id.localeCompare(b.id))
        .map(row => ({ id: row.id, name: `${row.firstName} ${row.lastName}` }));
    },
  };
}
export type PortalScheduleService = ReturnType<typeof createPortalScheduleService>;
