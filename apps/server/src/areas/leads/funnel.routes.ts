// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { leadsContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createLeadFunnelService } from './funnel.js';

export function createLeadFunnelRoutes(service = createLeadFunnelService()) {
  const contract = leadsContracts.funnel;
  return [route({ ...contract, request: { query: contract.query },
    responses: { 200: { description: 'Lead funnel counts by source for a gym-local date cohort',
      content: { 'application/json': { schema: contract.response } } } },
  }, async c => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId)
      throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    return c.json(await service.get(context.gym, c.req.valid('query')), 200);
  })];
}
export const routes = createLeadFunnelRoutes();
