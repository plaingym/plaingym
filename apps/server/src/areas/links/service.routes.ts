// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { linksContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { createSignedLinksService } from './service.js';

function mutation(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('forbidden', 'Staff access required');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function createSignedLinksRoutes(service = createSignedLinksService()) {
  const create = linksContracts.createLink, send = linksContracts.sendLink;
  const list = linksContracts.listLinks, get = linksContracts.getLink, revoke = linksContracts.revokeLink;
  return [
    route({ ...create,
      request: { body: { required: true, content: { 'application/json': { schema: create.body } } } },
      responses: { 200: { description: 'Created signed link; token shown once', content: { 'application/json': { schema: create.response } } } },
    }, async (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.create(mutation(c.get('context')), c.req.valid('json')) }, 200);
    }),
    route({ ...send,
      request: { body: { required: true, content: { 'application/json': { schema: send.body } } } },
      responses: { 200: { description: 'Emailed signed link metadata', content: { 'application/json': { schema: send.response } } } },
    }, async (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.send(mutation(c.get('context')), c.req.valid('json')) }, 200);
    }),
    route({ ...list, request: { query: list.query },
      responses: { 200: { description: 'Signed link metadata', content: { 'application/json': { schema: list.response } } } },
    }, async (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json(await service.list(c.get('context').gym.gymId, c.req.valid('query')), 200);
    }),
    route({ ...get, request: { params: get.params },
      responses: { 200: { description: 'Signed link metadata', content: { 'application/json': { schema: get.response } } } },
    }, async (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.get(c.get('context').gym.gymId, c.req.valid('param').linkId) }, 200);
    }),
    route({ ...revoke, request: { params: revoke.params },
      responses: { 200: { description: 'Revoked signed link metadata', content: { 'application/json': { schema: revoke.response } } } },
    }, async (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.revoke(mutation(c.get('context')), c.req.valid('param').linkId) }, 200);
    }),
  ];
}
export const routes = createSignedLinksRoutes();