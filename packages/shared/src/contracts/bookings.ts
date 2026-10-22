// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { idSchema, instantSchema, listResponseSchema, paginationSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';
import { attendanceSchema } from './attendance.js';

const manageBookings = { kind: 'staff', capability: 'bookings.manage' } as const satisfies RoutePermission;
const bookSelf = { kind: 'member', capability: 'bookings.self' } as const satisfies RoutePermission;
const bookHousehold = { kind: 'member', capability: 'bookings.household' } as const satisfies RoutePermission;
export const bookingStatusSchema = z.enum(['booked', 'waitlisted', 'cancelled']);
export const bookingIdParamsSchema = z.strictObject({ id: idSchema });
export const bookingMemberParamsSchema = z.strictObject({ memberId: idSchema });
export const bookingHouseholdCancelParamsSchema = z.strictObject({ memberId: idSchema, id: idSchema });
export const bookingRosterParamsSchema = z.strictObject({ sessionId: idSchema });
const bookingFieldsSchema = z.strictObject({
  id: idSchema, memberId: idSchema, sessionId: idSchema, createdAt: instantSchema,
  bookedBy: idSchema, bookedByKind: z.enum(['member', 'staff']),
});
/** Allocation positions are stable and may have gaps. queueRank is the current 1-based place in line. */
export const classBookingSchema = z.discriminatedUnion('status', [
  bookingFieldsSchema.extend({
    status: z.literal('booked'), waitlistPosition: z.null(), queueRank: z.null(), cancelledAt: z.null(),
  }),
  bookingFieldsSchema.extend({
    status: z.literal('waitlisted'), waitlistPosition: z.int32().positive(), queueRank: z.int().positive(), cancelledAt: z.null(),
  }),
  bookingFieldsSchema.extend({
    status: z.literal('cancelled'), waitlistPosition: z.null(), queueRank: z.null(), cancelledAt: instantSchema,
  }),
]).refine((booking) => booking.status !== 'waitlisted' || booking.queueRank <= booking.waitlistPosition, {
  path: ['queueRank'], message: 'Queue rank cannot exceed the allocated position',
});
/** Portal projections omit the staff/user identity that created the booking. */
const memberBookingFieldsSchema = bookingFieldsSchema.omit({ bookedBy: true, bookedByKind: true });
export const memberBookingSchema = z.discriminatedUnion('status', [
  memberBookingFieldsSchema.extend({ status: z.literal('booked'), waitlistPosition: z.null(), queueRank: z.null(), cancelledAt: z.null() }),
  memberBookingFieldsSchema.extend({ status: z.literal('waitlisted'), waitlistPosition: z.int32().positive(), queueRank: z.int().positive(), cancelledAt: z.null() }),
  memberBookingFieldsSchema.extend({ status: z.literal('cancelled'), waitlistPosition: z.null(), queueRank: z.null(), cancelledAt: instantSchema }),
]).refine((booking) => booking.status !== 'waitlisted' || booking.queueRank <= booking.waitlistPosition, {
  path: ['queueRank'], message: 'Queue rank cannot exceed the allocated position',
});
export const createBookingRequestSchema = z.strictObject({
  memberId: idSchema, sessionId: idSchema, allowWaitlist: z.boolean().default(true),
});
/** The principal supplies self; the household member ID comes from the authorized path. */
export const memberCreateBookingRequestSchema = createBookingRequestSchema.omit({ memberId: true });
export const bookingListQuerySchema = paginationSchema.extend({
  memberId: idSchema.optional(), sessionId: idSchema.optional(), status: bookingStatusSchema.optional(),
});
export const memberBookingListQuerySchema = paginationSchema.extend({
  sessionId: idSchema.optional(), status: bookingStatusSchema.optional(),
});
export const bookingResponseSchema = z.strictObject({ data: classBookingSchema });
export const bookingListResponseSchema = listResponseSchema(classBookingSchema);
export const memberBookingResponseSchema = z.strictObject({ data: memberBookingSchema });
export const memberBookingListResponseSchema = listResponseSchema(memberBookingSchema);
/** A walk-in can be checked in without a booking, including sessions that need no reservation. */
export const bookingRosterEntrySchema = z.strictObject({ booking: classBookingSchema.nullable(), attendance: attendanceSchema.nullable() })
  .refine((value) => value.booking !== null || value.attendance !== null, 'A roster entry needs a booking or attendance')
  .refine((value) => value.attendance === null || (value.attendance.sessionId !== null && (
    value.booking === null || (value.attendance.memberId === value.booking.memberId && value.attendance.sessionId === value.booking.sessionId)
  )), { path: ['attendance'], message: 'Attendance must match the roster session and booked member, when present' });
export const bookingRosterResponseSchema = listResponseSchema(bookingRosterEntrySchema);

/** Cancellation and promotion are idempotent transitions, not staff record edits; the table has no revision. */
export const bookingsContracts = {
  list: { method: 'get', path: '/api/bookings', permission: manageBookings, query: bookingListQuerySchema, response: bookingListResponseSchema },
  create: { method: 'post', path: '/api/bookings', permission: manageBookings, body: createBookingRequestSchema, response: bookingResponseSchema },
  cancel: { method: 'post', path: '/api/bookings/{id}/cancel', permission: manageBookings, params: bookingIdParamsSchema, response: bookingResponseSchema },
  roster: { method: 'get', path: '/api/bookings/sessions/{sessionId}/roster', permission: manageBookings, params: bookingRosterParamsSchema, query: paginationSchema, response: bookingRosterResponseSchema },
  listSelf: { method: 'get', path: '/api/portal/bookings', permission: bookSelf, query: memberBookingListQuerySchema, response: memberBookingListResponseSchema },
  createSelf: { method: 'post', path: '/api/portal/bookings', permission: bookSelf, body: memberCreateBookingRequestSchema, response: memberBookingResponseSchema },
  cancelSelf: { method: 'post', path: '/api/portal/bookings/{id}/cancel', permission: bookSelf, params: bookingIdParamsSchema, response: memberBookingResponseSchema },
  listHouseholdMember: { method: 'get', path: '/api/portal/members/{memberId}/bookings', permission: bookHousehold, params: bookingMemberParamsSchema, query: memberBookingListQuerySchema, response: memberBookingListResponseSchema },
  createHouseholdMember: { method: 'post', path: '/api/portal/members/{memberId}/bookings', permission: bookHousehold, params: bookingMemberParamsSchema, body: memberCreateBookingRequestSchema, response: memberBookingResponseSchema },
  cancelHouseholdMember: { method: 'post', path: '/api/portal/members/{memberId}/bookings/{id}/cancel', permission: bookHousehold, params: bookingHouseholdCancelParamsSchema, response: memberBookingResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type BookingStatus = z.infer<typeof bookingStatusSchema>;
export type ClassBooking = z.infer<typeof classBookingSchema>;
export type MemberBooking = z.infer<typeof memberBookingSchema>;
export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;
export type CreateBookingInput = z.input<typeof createBookingRequestSchema>;
export type MemberCreateBookingRequest = z.infer<typeof memberCreateBookingRequestSchema>;
export type BookingListQuery = z.infer<typeof bookingListQuerySchema>;
export type MemberBookingListQuery = z.infer<typeof memberBookingListQuerySchema>;
export type BookingRosterEntry = z.infer<typeof bookingRosterEntrySchema>;

export type BookingResponse = z.infer<typeof bookingResponseSchema>;
export type BookingListResponse = z.infer<typeof bookingListResponseSchema>;
export type MemberBookingResponse = z.infer<typeof memberBookingResponseSchema>;
export type MemberBookingListResponse = z.infer<typeof memberBookingListResponseSchema>;
export type BookingRosterResponse = z.infer<typeof bookingRosterResponseSchema>;
