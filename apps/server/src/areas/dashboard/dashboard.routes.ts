// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { dashboardContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createDashboardService } from './dashboard.js';

type DashboardService = ReturnType<typeof createDashboardService>;
let configured: DashboardService | undefined;
/** Runtime supplies area services; unconfigured requests fail closed. */
export function configureDashboard(...options: Parameters<typeof createDashboardService>) {
  configured = createDashboardService(...options);
  return configured;
}
function runtimeService(): DashboardService {
  if (!configured) throw new AppError('unavailable', 'Dashboard is not configured');
  return configured;
}
export function createDashboardRoutes(read: () => DashboardService = runtimeService) {
  const contract = dashboardContracts.mat;
  return [route({ ...contract, responses: { 200: { description: 'Dashboard widgets',
    content: { 'application/json': { schema: contract.response } } } } }, async (c) => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId)
      throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    return c.json(await read().get({ gymId: context.gym.gymId, roles: principal.roles,
      clock: context.clock, enabledModules: context.gym.enabledModules }), 200);
  })];
}
export const routes = createDashboardRoutes();
