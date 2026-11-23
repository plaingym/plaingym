// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import { healthContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createHealthService } from './status.js';
import { createStatusProviders, type StatusOptions } from './status.providers.js';
import { createFailedJobsAcknowledgement } from './failed-jobs.js';
import type { HealthTileProvider } from '../../core/interfaces/extensions.js';
import type { HealthTile } from '@plaingym/shared/contracts';

let service = createHealthService(createStatusProviders());
/** Runtime can supply its environment and additional tile providers without changing this route. */
export function configureHealthStatus(options: StatusOptions & { providers?: readonly HealthTileProvider<HealthTile>[] }) {
  service = createHealthService([...createStatusProviders(options), ...(options.providers ?? [])]);
}
export function createStatusRoutes(read = () => service, acknowledgement = createFailedJobsAcknowledgement()) {
  const contract = healthContracts.get, acknowledge = healthContracts.acknowledgeFailedJobs;
  return [route({ ...contract, responses: { 200: { description: 'System health', content: { 'application/json': { schema: contract.response } } } } }, async (c) => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    return c.json(await read().get({ gymId: context.gym.gymId, roles: principal.roles, clock: context.clock }), 200);
  }), route({ ...acknowledge, request: { body: { required: true, content: { 'application/json': { schema: acknowledge.body } } } },
    responses: {
      200: { description: 'Acknowledged failed jobs', content: { 'application/json': { schema: acknowledge.response } } },
      409: { description: 'Failed jobs changed', content: { 'application/json': { schema: z.object({
        error: z.object({ code: z.literal('conflict'), message: z.string() }), requestId: z.string(),
      }) } } },
    } }, async (c) => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
    const { through, failedVersion } = c.req.valid('json');
    const data = await acknowledgement.acknowledge({ gymId: context.gym.gymId, userId: principal.userId }, { through, failedVersion });
    c.header('Cache-Control', 'no-store');
    return c.json({ data }, 200);
  })];
}
export const routes = createStatusRoutes();
