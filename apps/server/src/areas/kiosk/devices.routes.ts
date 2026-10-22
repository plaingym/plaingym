// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { kioskContracts } from '@plaingym/shared/contracts';
import type { Context } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { route } from '../../core/registry.js';
import { createKioskDeviceService } from './devices.js';

function mutation(c: Context<RequestEnvironment>) {
  const { gym, principal } = c.get('context');
  if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
  c.header('Cache-Control', 'no-store');
  return { gymId: gym.gymId, actor: { kind: 'user' as const, userId: principal.userId } };
}
export function createKioskDeviceRoutes(service = createKioskDeviceService()) {
  const list = kioskContracts.listDevices, register = kioskContracts.registerDevice, revoke = kioskContracts.revokeDevice;
  return [
    route({ ...list, request: { query: list.query },
      responses: { 200: { description: 'Kiosk devices', content: { 'application/json': { schema: list.response } } } },
    }, async (c) => c.json(await service.list(mutation(c).gymId, c.req.valid('query')), 200)),
    route({ ...register, request: { body: { required: true, content: { 'application/json': { schema: register.body } } } },
      responses: { 200: { description: 'Device and one-time token', content: { 'application/json': { schema: register.response } } } },
    }, async (c) => c.json({ data: await service.register(mutation(c), c.req.valid('json')) }, 200)),
    route({ ...revoke, request: { params: revoke.params },
      responses: { 200: { description: 'Revoked device', content: { 'application/json': { schema: revoke.response } } } },
    }, async (c) => c.json({ data: await service.revoke(mutation(c), c.req.valid('param').id) }, 200)),
  ];
}
export const routes = createKioskDeviceRoutes();
