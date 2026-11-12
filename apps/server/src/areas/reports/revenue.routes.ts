// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { reportsContracts } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { reportRoute } from './report-route.js';
import { createRevenueReportService } from './revenue.js';

// Staff capabilities accumulate across roles; a coach/front-desk combination is still not a manager.
const requireManager: MiddlewareHandler<RequestEnvironment> = async (c, next) => {
  const principal = c.get('context').principal;
  if (principal.kind !== 'staff' || !principal.roles.some(role => role === 'owner' || role === 'admin'))
    throw new AppError('forbidden', 'Revenue reports require owner or admin access');
  await next();
};

export function createRevenueReportRoutes(service = createRevenueReportService()) {
  return [reportRoute(reportsContracts.revenue, 'Payments net of refunds by currency, local month and revenue group', service, requireManager)];
}
export const routes = createRevenueReportRoutes();
