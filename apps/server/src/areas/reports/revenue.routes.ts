// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { reportsContracts } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { route } from '../../core/registry.js';
import { createRevenueReportService } from './revenue.js';

// Staff capabilities accumulate across roles; a coach/front-desk combination is still not a manager.
const requireManager: MiddlewareHandler<RequestEnvironment> = async (c, next) => {
  const principal = c.get('context').principal;
  if (principal.kind !== 'staff' || !principal.roles.some(role => role === 'owner' || role === 'admin'))
    throw new AppError('forbidden', 'Revenue reports require owner or admin access');
  await next();
};

export function createRevenueReportRoutes(service = createRevenueReportService()) {
  const contract = reportsContracts.revenue;
  return [route({ ...contract, middleware: requireManager, request: { query: contract.query },
    responses: { 200: { description: 'Payments net of refunds by currency, local month and revenue group',
      content: { 'application/json': { schema: contract.response } } } },
  }, async c => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId)
      throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    return c.json(await service.get({ gymId: context.gym.gymId, timezone: context.gym.timezone, clock: context.clock }, c.req.valid('query')), 200);
  })];
}
export const routes = createRevenueReportRoutes();
