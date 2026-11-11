// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { dateSchema, idSchema, instantSchema } from './common.js';
import type { EndpointContract } from './definition.js';

export const reportMonthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/);
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5));
/** Inclusive month range. The current gym-local month is checked by the service's injected clock. */
export const reportRangeQuerySchema = z.strictObject({ from: reportMonthSchema, to: reportMonthSchema })
  .refine(value => value.from <= value.to, 'Range ends before it starts')
  .refine(value => monthIndex(value.to) - monthIndex(value.from) < 24, 'Range exceeds 24 months');
export const attendanceReportQuerySchema = reportRangeQuerySchema.safeExtend({ granularity: z.enum(['week', 'month']) });
/** endDate and endsAt are exclusive; dates and week starts belong to the gym's timezone. */
export const reportBucketSchema = z.strictObject({
  startDate: dateSchema, endDate: dateSchema, startsAt: instantSchema, endsAt: instantSchema, partial: z.boolean(),
});
const counts = { checkIns: z.int().nonnegative(), uniqueMembers: z.int().nonnegative() };
export const attendanceReportResponseSchema = z.strictObject({ data: z.strictObject({
  from: reportMonthSchema, to: reportMonthSchema, timezone: z.string(), granularity: z.enum(['week', 'month']),
  buckets: z.array(reportBucketSchema.extend({
    programs: z.array(z.strictObject({ programId: idSchema.nullable(), programName: z.string().nullable(), ...counts })),
    totals: z.strictObject(counts),
  })),
}) });
export const reportsContracts = {
  attendance: { method: 'get', path: '/api/reports/attendance',
    permission: { kind: 'staff', capability: 'reports.read' },
    query: attendanceReportQuerySchema, response: attendanceReportResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;
export type ReportBucket = z.infer<typeof reportBucketSchema>;
export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;
export type AttendanceReportResponse = z.infer<typeof attendanceReportResponseSchema>;
