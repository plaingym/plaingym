// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { healthContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createUpdateAvailableProvider, type UpdateProviderOptions } from './updates.js';

let configured = createUpdateAvailableProvider();
/** The runtime passes the environment it runs with, so this route and the Health page's tile read the same one. */
export function configureUpdateRoutes(options: UpdateProviderOptions) { configured = createUpdateAvailableProvider(options); }
/** The banner's own route: the release check alone, so the admin shell never reads every health tile. */
export function createUpdateRoutes(read = () => configured) {
  const contract = healthContracts.getUpdate;
  return [route({ ...contract, responses: { 200: { description: 'Latest release', content: { 'application/json': { schema: contract.response } } } } }, async (c) => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    let tile;
    try { tile = contract.response.parse({ data: await read().read({ gymId: context.gym.gymId, roles: principal.roles, clock: context.clock }) }); }
    catch { tile = { data: { id: 'update_available' as const, status: 'unavailable' as const, checkedAt: context.clock.now().toISOString(), details: null, message: '' } }; }
    return c.json(tile, 200);
  })];
}
export const routes = createUpdateRoutes();
