// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { healthContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createHealthService } from './status.js';
import { createStatusProviders, type StatusOptions } from './status.providers.js';
import type { HealthTileProvider } from '../../core/interfaces/extensions.js';
import type { HealthTile } from '@plaingym/shared/contracts';

let service = createHealthService(createStatusProviders());
/** Runtime can supply its environment and additional tile providers without changing this route. */
export function configureHealthStatus(options: StatusOptions & { providers?: readonly HealthTileProvider<HealthTile>[] }) {
  service = createHealthService([...createStatusProviders(options), ...(options.providers ?? [])]);
}
export function createStatusRoutes(read = () => service) {
  const contract = healthContracts.get;
  return [route({ ...contract, responses: { 200: { description: 'System health', content: { 'application/json': { schema: contract.response } } } } }, async (c) => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    return c.json(await read().get({ gymId: context.gym.gymId, roles: principal.roles, clock: context.clock }), 200);
  })];
}
export const routes = createStatusRoutes();
