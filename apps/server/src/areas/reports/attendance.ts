// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { attendanceReportQuerySchema, type AttendanceReportQuery, type AttendanceReportResponse } from '@plaingym/shared/contracts';
import { attendanceAggregate } from './attendance.query.js';
import { reportBuckets, type ReportContext } from './range.js';

export function createAttendanceReportService(scope: typeof forGym = forGym) {
  return {
    async get(context: ReportContext, input: AttendanceReportQuery): Promise<AttendanceReportResponse> {
      const parsed = attendanceReportQuerySchema.safeParse(input);
      if (!parsed.success) throw new AppError('invalid_request', 'Invalid attendance report query');
      const query = parsed.data;
      const boundaries = reportBuckets({ from: query.from, to: query.to }, context, query.granularity);
      const buckets: AttendanceReportResponse['data']['buckets'] = boundaries.map(bucket => ({ ...bucket,
        programs: [], totals: { checkIns: 0, uniqueMembers: 0 } }));
      const rows = await scope(context.gymId, tx => attendanceAggregate(tx, context.gymId, boundaries));
      for (const row of rows) {
        const bucket = buckets[row.bucket]!;
        const counts = { checkIns: row.checkIns, uniqueMembers: row.uniqueMembers };
        if (row.total) bucket.totals = counts;
        else if (row.checkIns) bucket.programs.push({ programId: row.programId, programName: row.programName, ...counts });
      }
      return { data: { ...query, timezone: context.timezone, buckets } };
    },
  };
}
