// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { attendanceSourceSchema } from './states.js';
import { idSchema, instantSchema, listResponseSchema, paginationSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';

const manageAttendance = { kind: 'staff', capability: 'attendance.manage' } as const satisfies RoutePermission;
export { attendanceSourceSchema } from './states.js';
export const attendanceSchema = z.strictObject({
  id: idSchema, memberId: idSchema, sessionId: idSchema.nullable(), programId: idSchema.nullable(),
  occurredAt: instantSchema, source: attendanceSourceSchema, createdAt: instantSchema,
});
export const attendanceResponseSchema = z.strictObject({ data: attendanceSchema });
export const attendanceListResponseSchema = listResponseSchema(attendanceSchema);
/** Source and import deduplication keys are assigned by the service, never by the coach form. */
export const recordAttendanceRequestSchema = z.strictObject({
  memberId: idSchema, sessionId: idSchema.nullable(), programId: idSchema.nullable(),
  occurredAt: instantSchema.optional(),
});
export const attendanceListQuerySchema = paginationSchema.extend({
  memberId: idSchema.optional(), sessionId: idSchema.optional(), programId: idSchema.optional(),
  tagId: idSchema.optional(), source: attendanceSourceSchema.optional(),
  since: instantSchema.optional(), until: instantSchema.optional(),
}).refine((value) => !value.since || !value.until || Date.parse(value.until) > Date.parse(value.since), {
  path: ['until'], message: 'Range must end after it starts',
});
/** Counts include the start instant and exclude until, matching attendance history filters. */
export const attendanceTotalsQuerySchema = z.strictObject({
  memberId: idSchema, since: instantSchema.optional(), until: instantSchema.optional(),
}).refine((value) => !value.since || !value.until || Date.parse(value.until) > Date.parse(value.since), {
  path: ['until'], message: 'Range must end after it starts',
});
export const attendanceTotalsSchema = z.strictObject({
  memberId: idSchema, total: z.int().nonnegative(),
  byProgram: z.array(z.strictObject({ programId: idSchema, count: z.int().nonnegative() })),
  byTag: z.array(z.strictObject({ tagId: idSchema, count: z.int().nonnegative() })),
});
export const attendanceTotalsResponseSchema = z.strictObject({ data: attendanceTotalsSchema });
/** Attendance is append-only; duplicate member/session or import-source keys return the original record. */
export const attendanceContracts = {
  record: { method: 'post', path: '/api/attendance', permission: manageAttendance, body: recordAttendanceRequestSchema, response: attendanceResponseSchema },
  list: { method: 'get', path: '/api/attendance', permission: manageAttendance, query: attendanceListQuerySchema, response: attendanceListResponseSchema },
  totals: { method: 'get', path: '/api/attendance/totals', permission: manageAttendance, query: attendanceTotalsQuerySchema, response: attendanceTotalsResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type AttendanceSource = z.infer<typeof attendanceSourceSchema>;
export type Attendance = z.infer<typeof attendanceSchema>;
export type RecordAttendanceRequest = z.infer<typeof recordAttendanceRequestSchema>;
export type AttendanceListQuery = z.infer<typeof attendanceListQuerySchema>;
export type AttendanceTotalsQuery = z.infer<typeof attendanceTotalsQuerySchema>;
export type AttendanceTotals = z.infer<typeof attendanceTotalsSchema>;

export type AttendanceResponse = z.infer<typeof attendanceResponseSchema>;
export type AttendanceListResponse = z.infer<typeof attendanceListResponseSchema>;
export type AttendanceTotalsResponse = z.infer<typeof attendanceTotalsResponseSchema>;
