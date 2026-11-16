// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { dashboardContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createBillingDashboardService, type BillingDashboardServices } from './billing.js';

type Service = ReturnType<typeof createBillingDashboardService>;
let configured: Service | undefined;
export function configureBillingDashboard(services: BillingDashboardServices) {
  configured = createBillingDashboardService(services);
  return configured;
}
function required(): Service {
  if (!configured) throw new AppError('unavailable', 'Billing dashboard is not configured');
  return configured;
}
export function createBillingDashboardRoutes(read: () => Service = required) {
  const contract = dashboardContracts.billing;
  return [route({ ...contract, responses: { 200: { description: 'Billing dashboard',
    content: { 'application/json': { schema: contract.response } } } } }, async c => {
    const { gym, principal, clock } = c.get('context');
    if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    return c.json(await read().get({ gymId: gym.gymId, roles: principal.roles, clock }), 200);
  })];
}
export const routes = createBillingDashboardRoutes();
