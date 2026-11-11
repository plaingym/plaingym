// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { AppError } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { createLeadsService } from './list.js';

function mutation(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('not_found', 'Lead not found');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function createLeadsRoutes(supplied?: ReturnType<typeof createLeadsService>) {
  // The request clock keeps routes consistent with every other change in the request.
  const current = (context: RequestContext) => supplied ?? createLeadsService({ clock: context.clock });
  function item(contract: c.EndpointContract,
    handler: (context: RequestContext, memberId: string, body: unknown) => Promise<unknown>) {
    return route({ ...contract, middleware: bodyLimit({ maxSize: 8_192,
      onError: () => { throw new AppError('invalid_request', 'Request too large'); } }),
    request: { params: contract.params as z.ZodObject,
      ...(contract.body ? { body: { required: true, content: { 'application/json': { schema: contract.body } } } } : {}) },
    responses: { 200: { description: 'Lead details', content: { 'application/json': { schema: contract.response } } } },
    }, async ctx => {
      const context = ctx.get('context'); mutation(context);
      const result = await handler(context, ctx.req.param('memberId')!, contract.body ? await ctx.req.json() : undefined);
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(c.leadResponseSchema.parse(result), 200);
    });
  }
  const contract = c.leadsContracts.list;
  return [route({ ...contract, request: { query: contract.query }, responses: {
    200: { description: 'Leads and filtered stage totals', content: { 'application/json': { schema: contract.response } } },
  } }, async ctx => {
    const context = ctx.get('context'); mutation(context);
    ctx.header('Cache-Control', 'no-store');
    return ctx.json(await current(context).list(context.gym, ctx.req.valid('query')), 200);
  }),
  item(c.leadsContracts.read, (ctx, id) => current(ctx).read(ctx.gym.gymId, id)),
  item(c.leadsContracts.edit, (ctx, id, body) => current(ctx).edit(mutation(ctx), id, c.updateLeadRequestSchema.parse(body))),
  item(c.leadsContracts.lost, (ctx, id, body) => current(ctx).lost(mutation(ctx), id, c.loseLeadRequestSchema.parse(body))),
  item(c.leadsContracts.reopen, (ctx, id, body) => current(ctx).reopen(mutation(ctx), id, c.reopenLeadRequestSchema.parse(body))),
  ];
}
export const routes = createLeadsRoutes();
