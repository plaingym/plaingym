// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { route } from '../../core/registry.js';
import { deleteRequest, deleteResponse } from '../../demo/contracts.js';
import type { GymDeleteService } from './gym-delete.js';
let service: GymDeleteService | undefined;
export function configureGymDeletion(value: GymDeleteService): void { service = value; }
export function createGymDeleteRoutes(deletion: GymDeleteService) {
  return [route({ method: 'delete', path: '/api/settings/gym', permission: { kind: 'staff', capability: 'ownership.transfer' },
    request: { body: { required: true, content: { 'application/json': { schema: deleteRequest } } } },
    responses: { 200: { description: 'Gym deleted', content: { 'application/json': { schema: deleteResponse } } } },
  }, async (c) => {
    const { gym, principal } = c.get('context');
    if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Not found');
    await deletion.remove(gym.gymId, c.req.valid('json').revision, principal.userId);
    return c.json({ data: { deleted: true as const } }, 200);
  })];
}
export const routes = createGymDeleteRoutes({ async remove(...args) {
  if (!service) throw new AppError('not_found', 'Not found');
  await service.remove(...args);
} });
