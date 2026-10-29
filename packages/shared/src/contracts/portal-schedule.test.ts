// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canMember, isRoutePermission } from '../permissions.js';
import { portalContracts, portalScheduleContracts, portalScheduleSessionSchema } from './index.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const session = { id, name: 'Training', startsAt: '2026-10-30T18:00:00Z', endsAt: '2026-10-30T19:00:00Z', coachId: null, capacity: 10, status: 'scheduled', revision: 1,
  bookingOpensAt: '2026-10-23T00:00:00Z', cancelBefore: '2026-10-30T17:00:00Z', placesLeft: 3, bookings: [] };
const booking = { id, memberId: id, sessionId: id, createdAt: '2026-10-29T12:00:00Z', status: 'booked', waitlistPosition: null, queueRank: null, cancelledAt: null };

describe('portal schedule, check-in and progress projections', () => {
  it('lists only active places, as counts and member projections without staff fields', () => {
    expect(portalScheduleSessionSchema.safeParse({ ...session, bookings: [booking] }).success).toBe(true);
    expect(portalScheduleSessionSchema.safeParse({ ...session, bookings: [{ ...booking, status: 'cancelled', cancelledAt: '2026-10-29T13:00:00Z' }] }).success).toBe(false);
    expect(portalScheduleSessionSchema.safeParse({ ...session, bookings: [{ ...booking, bookedBy: id }] }).success).toBe(false);
    expect(portalScheduleSessionSchema.safeParse({ ...session, notes: 'Staff note' }).success).toBe(false);
    expect(portalScheduleSessionSchema.safeParse({ ...session, endsAt: session.startsAt }).success).toBe(false);
    expect(portalScheduleSessionSchema.safeParse({ ...session, placesLeft: -1 }).success).toBe(false);
  });
  it('limits the member list to IDs and display names for both roles', () => {
    const { members } = portalScheduleContracts;
    expect(isRoutePermission(members.permission)).toBe(true);
    expect(members.permission.kind === 'member' && canMember('member', members.permission.capability)).toBe(true);
    expect(members.response.safeParse({ data: [{ id, name: 'Alex Example' }] }).success).toBe(true);
    expect(members.response.safeParse({ data: [{ id, name: 'Alex Example', email: 'a@example.test' }] }).success).toBe(false);
  });
  it('reads a missing code as null, while regeneration always returns one', () => {
    const data = { memberId: id, code: null, version: 2, revision: 3 };
    expect(portalContracts.checkinCode.response.safeParse({ data }).success).toBe(true);
    expect(portalContracts.regenerateCheckin.response.safeParse({ data }).success).toBe(false);
  });
  it('adds only gym names, colors and sub-ranks to progress', () => {
    const data = { history: [], criteria: [], programs: [{ id, name: 'Program', current: null, next: { rankId: id, subRank: 1 } }],
      ranks: [{ id, name: 'Level', color: '#123456', subRanks: [{ id: 'one', name: 'One' }] }] };
    expect(portalContracts.progress.response.safeParse({ data }).success).toBe(true);
    expect(portalContracts.progress.response.safeParse({ data: { ...data, ranks: [{ ...data.ranks[0], criteria: [] }] } }).success).toBe(false);
    expect(portalContracts.progress.response.safeParse({ data: { ...data, programs: [{ ...data.programs[0], rankSystemId: id }] } }).success).toBe(false);
    expect(portalContracts.progress.response.safeParse({ data: { ...data, programs: [{ ...data.programs[0], current: { rankId: id, subRank: 0 } }] } }).success).toBe(true);
    expect(portalContracts.progress.response.safeParse({ data: { ...data, programs: [{ id, name: 'Program', next: null }] } }).success).toBe(false);
  });
});
