// SPDX-License-Identifier: AGPL-3.0-only
import { reportsContracts } from '@plaingym/shared/contracts';
import { reportRoute } from './report-route.js';
import { createMembersReportService } from './members.js';

export function createMembersReportRoutes(service = createMembersReportService()) {
  return [reportRoute(reportsContracts.members, 'Member activity and churn in gym-local months', service)];
}
export const routes = createMembersReportRoutes();
