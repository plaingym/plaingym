// SPDX-License-Identifier: AGPL-3.0-only
import { reportsContracts } from '@plaingym/shared/contracts';
import { reportRoute } from './report-route.js';
import { createRevenueReportService } from './revenue.js';

export function createRevenueReportRoutes(service = createRevenueReportService()) {
  return [reportRoute(reportsContracts.revenue, 'Payments net of refunds by currency, local month and revenue group', service)];
}
export const routes = createRevenueReportRoutes();
