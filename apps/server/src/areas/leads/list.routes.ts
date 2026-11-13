// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import * as c from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { createLeadsService } from './list.js';
import { leadBodyLimit, leadStaff } from './route-helpers.js';

export function createLeadsRoutes(supplied?: ReturnType<typeof createLeadsService>) {
  // The request clock keeps routes consistent with every other change in the request.
  const current = (context: RequestContext) => supplied ?? createLeadsService({ clock: context.clock });
  function item<B = undefined>(contract: c.EndpointContract,
    handler: (context: RequestContext, actor: ReturnType<typeof leadStaff>, memberId: string, body: B) => Promise<unknown>) {
    return route({ ...contract, middleware: leadBodyLimit(8_192),
    request: { params: contract.params as z.ZodObject,
      ...(contract.body ? { body: { required: true, content: { 'application/json': { schema: contract.body } } } } : {}) },
    responses: { 200: { description: 'Lead details', content: { 'application/json': { schema: contract.response } } } },
    }, async ctx => {
      const context = ctx.get('context'), actor = leadStaff(context);
      // Route validation establishes these values; the generic contract erases their inferred types.
      const request = ctx.req as typeof ctx.req & { valid(target: 'param'): { memberId: string }; valid(target: 'json'): B };
      const result = await handler(context, actor, request.valid('param').memberId, contract.body ? request.valid('json') : undefined as B);
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(c.leadResponseSchema.parse(result), 200);
    });
  }
  const contract = c.leadsContracts.list;
  return [route({ ...contract, request: { query: contract.query }, responses: {
    200: { description: 'Leads and filtered stage totals', content: { 'application/json': { schema: contract.response } } },
  } }, async ctx => {
    const context = ctx.get('context'); leadStaff(context);
    ctx.header('Cache-Control', 'no-store');
    return ctx.json(await current(context).list(context.gym, ctx.req.valid('query')), 200);
  }),
  item(c.leadsContracts.read, (ctx, _actor, id) => current(ctx).read(ctx.gym.gymId, id)),
  item<c.UpdateLeadRequest>(c.leadsContracts.edit, (ctx, actor, id, body) => current(ctx).edit(actor, id, body)),
  item<c.LoseLeadRequest>(c.leadsContracts.lost, (ctx, actor, id, body) => current(ctx).lost(actor, id, body)),
  item<c.ReopenLeadRequest>(c.leadsContracts.reopen, (ctx, actor, id, body) => current(ctx).reopen(actor, id, body)),
  ];
}
export const routes = createLeadsRoutes();
