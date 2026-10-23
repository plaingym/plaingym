// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { classBookings } from '../../../db/src/schema/index.js';
import { canMember, canStaff, isRoutePermission } from '../permissions.js';
import {
  bookingListQuerySchema, bookingListResponseSchema, bookingRosterEntrySchema, bookingsContracts,
  classBookingSchema, createBookingRequestSchema, memberBookingSchema, memberCreateBookingRequestSchema,
  memberBookingListQuerySchema, type ClassBooking,
} from '@plaingym/shared/contracts';

const id = '019a08bf-1234-7000-8000-000000000001';
const otherId = '019a08bf-1234-7000-8000-000000000002';
const createdAt = '2026-10-21T12:00:00Z';
const booking = {
  id, memberId: id, sessionId: id, createdAt, bookedBy: otherId, bookedByKind: 'staff',
  status: 'booked', waitlistPosition: null, queueRank: null, cancelledAt: null,
};
const waitlisted = { ...booking, status: 'waitlisted', waitlistPosition: 9, queueRank: 2 };

describe('booking and waitlist contracts', () => {
  it('keeps allocation position distinct from current queue rank after earlier entries leave', () => {
    expect(classBookingSchema.parse(waitlisted)).toMatchObject({ waitlistPosition: 9, queueRank: 2 });
    expect(classBookingSchema.parse({ ...waitlisted, waitlistPosition: 42, queueRank: 1 }).queueRank).toBe(1);
  });
  it.each([
    { waitlistPosition: null }, { waitlistPosition: 0 }, { waitlistPosition: 1.5 },
    { queueRank: null }, { queueRank: 0 }, { queueRank: 1.5 }, { queueRank: 10 },
  ])('rejects inconsistent waitlist shape %j', (change) => {
    expect(classBookingSchema.safeParse({ ...waitlisted, ...change }).success).toBe(false);
  });
  it('does not retain a waitlist position or rank after booking or cancellation', () => {
    expect(classBookingSchema.parse(booking).status).toBe('booked');
    const cancelled = { ...booking, status: 'cancelled', cancelledAt: createdAt };
    expect(classBookingSchema.parse(cancelled).status).toBe('cancelled');
    expect(classBookingSchema.safeParse({ ...cancelled, cancelledAt: null }).success).toBe(false);
    for (const active of [booking, cancelled]) {
      expect(classBookingSchema.safeParse({ ...active, waitlistPosition: 9 }).success).toBe(false);
      expect(classBookingSchema.safeParse({ ...active, queueRank: 2 }).success).toBe(false);
    }
    expect(classBookingSchema.safeParse({ ...booking, status: 'confirmed' }).success).toBe(false);
    expect(classBookingSchema.safeParse({ ...booking, bookedByKind: 'device' }).success).toBe(false);
  });
  it('uses automatic waitlisting unless the caller explicitly declines it', () => {
    expect(createBookingRequestSchema.parse({ memberId: id, sessionId: id }).allowWaitlist).toBe(true);
    expect(createBookingRequestSchema.parse({ memberId: id, sessionId: id, allowWaitlist: false }).allowWaitlist).toBe(false);
    expect(createBookingRequestSchema.safeParse({ memberId: id, sessionId: id, allowWaitlist: 'false' }).success).toBe(false);
    for (const extra of [{ bookedBy: otherId }, { status: 'booked' }, { waitlistPosition: 1 }, { gymId: otherId }]) {
      expect(createBookingRequestSchema.safeParse({ memberId: id, sessionId: id, ...extra }).success).toBe(false);
    }
  });
  it('derives self from the principal and household members from authorized path parameters', () => {
    expect(memberCreateBookingRequestSchema.parse({ sessionId: id }).allowWaitlist).toBe(true);
    for (const extra of [{ memberId: otherId }, { householdId: otherId }, { gymId: otherId }, { bookedBy: otherId }]) {
      expect(memberCreateBookingRequestSchema.safeParse({ sessionId: id, ...extra }).success).toBe(false);
      expect(memberBookingListQuerySchema.safeParse(extra).success).toBe(false);
    }
    const { bookedBy, bookedByKind, ...safeProjection } = booking;
    expect(bookedBy).toBe(otherId);
    expect(bookedByKind).toBe('staff');
    expect(memberBookingSchema.parse(safeProjection)).toEqual(safeProjection);
    expect(memberBookingSchema.safeParse(booking).success).toBe(false);
    expect(memberBookingSchema.safeParse({ ...safeProjection, medicalNotes: 'private' }).success).toBe(false);
  });
  it('ties checked-in roster entries to the same member and session as the booking', () => {
    const attendance = { id: otherId, memberId: id, sessionId: id, programId: null, occurredAt: createdAt, createdAt, source: 'coach', kind: 'class' };
    expect(bookingRosterEntrySchema.parse({ booking, attendance }).attendance?.id).toBe(otherId);
    expect(bookingRosterEntrySchema.parse({ booking, attendance: null }).attendance).toBeNull();
    expect(bookingRosterEntrySchema.parse({ booking: null, attendance }).booking).toBeNull();
    expect(bookingRosterEntrySchema.safeParse({ booking: null, attendance: null }).success).toBe(false);
    expect(bookingRosterEntrySchema.safeParse({ booking: null, attendance: { ...attendance, sessionId: null } }).success).toBe(false);
    for (const change of [{ memberId: otherId }, { sessionId: otherId }, { sessionId: null }]) {
      expect(bookingRosterEntrySchema.safeParse({ booking, attendance: { ...attendance, ...change } }).success).toBe(false);
    }
  });
  it('uses the shared list envelope and rejects invalid filters and metadata', () => {
    expect(bookingListQuerySchema.parse({ sessionId: id, status: 'waitlisted' })).toMatchObject({ limit: 50, offset: 0 });
    expect(bookingListQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    const response = { data: [waitlisted], pagination: { limit: 50, offset: 0, total: 1 } };
    expect(bookingListResponseSchema.parse(response)).toEqual(response);
    expect(bookingListResponseSchema.safeParse({ data: response.data }).success).toBe(false);
    expect(bookingListResponseSchema.safeParse({ ...response, pagination: { ...response.pagination, total: -1 } }).success).toBe(false);
  });
  it('keeps persisted booking fields aligned with the schema and rank as a computed aggregate', () => {
    expectTypeOf<Omit<ClassBooking, 'createdAt' | 'cancelledAt' | 'queueRank'>>()
      .toExtend<Omit<typeof classBookings.$inferSelect, 'gymId' | 'createdAt' | 'cancelledAt'>>();
  });
  it('declares staff, self, and payer-only household access separately', () => {
    for (const endpoint of Object.values(bookingsContracts)) {
      expect(isRoutePermission(endpoint.permission)).toBe(true);
      const permission = endpoint.permission;
      if (permission.kind === 'staff') {
        for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) expect(canStaff([role], permission.capability)).toBe(true);
        expect(canStaff([], permission.capability)).toBe(false);
      } else {
        expect(canMember('payer', permission.capability)).toBe(true);
        expect(canMember('member', permission.capability)).toBe(!endpoint.path.includes('/members/'));
      }
    }
  });
});
