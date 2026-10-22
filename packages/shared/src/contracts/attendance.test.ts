// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { attendances } from '../../../db/src/schema/index.js';
import { canStaff, isRoutePermission } from '../permissions.js';
import {
  attendanceContracts, attendanceListQuerySchema, attendanceSchema, attendanceTotalsResponseSchema,
  recordAttendanceRequestSchema, type Attendance,
} from '@plaingym/shared/contracts';

const id = '019a08bf-1234-7000-8000-000000000001';
const occurredAt = '2026-10-21T12:00:00Z';
const attendance = { id, memberId: id, sessionId: null, programId: null, occurredAt, createdAt: occurredAt, source: 'import' };

describe('attendance contracts', () => {
  it('accepts imported and open-mat history without a session or program', () => {
    for (const source of ['kiosk', 'coach', 'import']) expect(attendanceSchema.parse({ ...attendance, source }).sessionId).toBeNull();
    expect(recordAttendanceRequestSchema.parse({ memberId: id, sessionId: null, programId: null }))
      .toEqual({ memberId: id, sessionId: null, programId: null });
  });
  it('requires explicit nullable references and valid source/instants in responses', () => {
    const { sessionId, ...missingSession } = attendance;
    expect(sessionId).toBeNull();
    expect(attendanceSchema.safeParse(missingSession).success).toBe(false);
    for (const change of [{ source: 'admin' }, { occurredAt: '2026-10-21' }, { sessionId: '1' }, { createdAt: null }]) {
      expect(attendanceSchema.safeParse({ ...attendance, ...change }).success).toBe(false);
    }
  });
  it('prevents coach forms from choosing a source, deduplication key, or gym', () => {
    const request = { memberId: id, sessionId: null, programId: null, occurredAt };
    for (const extra of [{ source: 'import' }, { source: 'kiosk' }, { sourceKey: 'old-system-1' }, { gymId: id }, { id }, { revision: 1 }]) {
      expect(recordAttendanceRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });
  it('supports source, program, tag, session and time filters with shared pagination', () => {
    const query = { memberId: id, sessionId: id, programId: id, tagId: id, source: 'import', since: occurredAt, until: '2026-10-22T12:00:00Z' };
    expect(attendanceListQuerySchema.parse(query)).toMatchObject({ ...query, limit: 50, offset: 0 });
    expect(attendanceListQuerySchema.safeParse({ ...query, until: occurredAt }).success).toBe(false);
    expect(attendanceListQuerySchema.safeParse({ ...query, since: '2026-10-23T12:00:00Z' }).success).toBe(false);
    expect(attendanceListQuerySchema.safeParse({ ...query, limit: 101 }).success).toBe(false);
    expect(attendanceListQuerySchema.safeParse({ ...query, householdId: id }).success).toBe(false);
  });
  it('keeps per-program and per-tag counts independent: a class can count for several', () => {
    const result = { data: { memberId: id, total: 1, byProgram: [{ programId: id, count: 1 }], byTag: [{ tagId: id, count: 1 }] } };
    expect(attendanceTotalsResponseSchema.parse(result)).toEqual(result);
    expect(attendanceTotalsResponseSchema.safeParse({ data: { ...result.data, total: -1 } }).success).toBe(false);
    expect(attendanceTotalsResponseSchema.safeParse({ data: { ...result.data, byTag: [{ tagId: id, count: 1.5 }] } }).success).toBe(false);
  });
  it('matches the persisted projection without exposing internal source keys', () => {
    expectTypeOf<Omit<Attendance, 'createdAt' | 'occurredAt'>>()
      .toExtend<Omit<typeof attendances.$inferSelect, 'gymId' | 'createdAt' | 'occurredAt' | 'sourceKey'>>();
    expect(attendanceSchema.safeParse({ ...attendance, sourceKey: 'private-key' }).success).toBe(false);
  });
  it('allows all staff to manage attendance and declares no unauthenticated endpoint', () => {
    for (const endpoint of Object.values(attendanceContracts)) {
      expect(isRoutePermission(endpoint.permission)).toBe(true);
      for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) expect(canStaff([role], endpoint.permission.capability)).toBe(true);
      expect(canStaff([], endpoint.permission.capability)).toBe(false);
    }
  });
});
