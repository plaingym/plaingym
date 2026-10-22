// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { ranksContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createContentPackService } from './packs.js';

export function createContentPackRoutes(service = createContentPackService()) {
  const list = ranksContracts.listPacks, apply = ranksContracts.applyPack;
  return [
    route({ ...list, request: { query: list.query },
      responses: { 200: { description: 'Installed content packs', content: { 'application/json': { schema: list.response } } } },
    }, async (c) => {
      const context = c.get('context');
      if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
        throw new AppError('not_found', 'Gym not found');
      return c.json(await service.list(context.gym.gymId, c.req.valid('query')), 200);
    }),
    route({ ...apply,
      request: { body: { required: true, content: { 'application/json': { schema: apply.body } } } },
      responses: { 200: { description: 'Applied content pack', content: { 'application/json': { schema: apply.response } } } },
    }, async (c) => {
      const context = c.get('context');
      if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
        throw new AppError('not_found', 'Gym not found');
      const data = await service.apply({ gymId: context.gym.gymId, actor: { kind: 'user', userId: context.principal.userId } }, c.req.valid('json').pack);
      return c.json({ data }, 200);
    }),
  ];
}
export const routes = createContentPackRoutes();
