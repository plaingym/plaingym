// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { AppError } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { createLeadContactsService } from './contacts.js';

function staff(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('not_found', 'Lead not found');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function createLeadContactsRoutes(supplied?: ReturnType<typeof createLeadContactsService>) {
  // The request clock keeps the contact's time consistent with every other change in the request.
  const current = (context: RequestContext) => supplied ?? createLeadContactsService({ clock: context.clock });
  const list = c.leadsContracts.contacts, log = c.leadsContracts.logContact;
  return [
    route({ ...list, request: { params: list.params as z.ZodObject, query: list.query }, responses: {
      200: { description: 'Logged contacts, newest first', content: { 'application/json': { schema: list.response } } },
    } }, async ctx => {
      const context = ctx.get('context'); staff(context);
      const result = await current(context).list(context.gym.gymId, ctx.req.param('memberId')!, ctx.req.valid('query'));
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(list.response.parse(result), 200);
    }),
    // A note of 2,000 code points takes up to 24,000 bytes when a client escapes every one as a \u surrogate pair.
    route({ ...log, middleware: bodyLimit({ maxSize: 32_768,
      onError: () => { throw new AppError('invalid_request', 'Request too large'); } }),
    request: { params: log.params as z.ZodObject, body: { required: true, content: { 'application/json': { schema: log.body } } } },
    responses: { 200: { description: 'The contact and the updated lead', content: { 'application/json': { schema: log.response } } } },
    }, async ctx => {
      const context = ctx.get('context'), actor = staff(context);
      const result = await current(context).log(actor, ctx.req.param('memberId')!, log.body.parse(await ctx.req.json()));
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(log.response.parse(result), 200);
    }),
  ];
}
export const routes = createLeadContactsRoutes();
