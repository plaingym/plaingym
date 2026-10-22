// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type ContentPack } from '@plaingym/shared';
import { ranksContracts, contentPackCatalogEntrySchema } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createContentPackService } from './packs.js';
import { loadContentPacks } from './packs.loader.js';

export function createContentPackRoutes(service = createContentPackService(), load: () => Promise<readonly ContentPack[]> = loadContentPacks) {
  const list = ranksContracts.listPacks, apply = ranksContracts.applyPack, catalog = ranksContracts.catalog;
  return [
    route({ ...catalog,
      responses: { 200: { description: 'Shipped content pack catalog', content: { 'application/json': { schema: catalog.response } } } },
    }, async (c) => {
      const packs = await load();
      return c.json({ data: packs.map((pack) => contentPackCatalogEntrySchema.parse({
        id: pack.id, name: pack.name, version: pack.version, summary: pack.summary ?? pack.name,
      })) }, 200);
    }),
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
