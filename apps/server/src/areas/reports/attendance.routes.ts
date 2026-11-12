// SPDX-License-Identifier: AGPL-3.0-only
import { reportsContracts } from '@plaingym/shared/contracts';
import { reportRoute } from './report-route.js';
import { createAttendanceReportService } from './attendance.js';

export function createAttendanceReportRoutes(service = createAttendanceReportService()) {
  return [reportRoute(reportsContracts.attendance, 'Attendance by program in gym-local periods', service)];
}
export const routes = createAttendanceReportRoutes();
