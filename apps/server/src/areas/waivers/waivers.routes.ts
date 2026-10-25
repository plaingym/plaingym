// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { AppError } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { createWaiversService, type WaiversService, type WaiverOptions } from './waivers.js';

let configured: WaiversService | undefined;
export function configureWaivers(options: WaiverOptions) { configured = createWaiversService(options); return configured; }
const mutation = (ctx: RequestContext) => {
  if (ctx.principal.kind !== 'staff' || ctx.principal.gymId !== ctx.gym.gymId) throw new AppError('not_found', 'Resource not found');
  return { gymId: ctx.gym.gymId, actor: { kind: 'user' as const, userId: ctx.principal.userId } };
};
export function createWaiverRoutes(service?: WaiversService) {
  const get = () => { const value = service ?? configured; if (!value) throw new Error('Waivers not configured'); return value; };
  const handlers: Record<keyof typeof c.waiverContracts, (ctx: RequestContext, p: Record<string, string>, q: unknown, b: unknown) => Promise<unknown>> = {
    listTemplates: (ctx, _p, q) => get().listTemplates(ctx.gym.gymId, q),
    createTemplate: async (ctx, _p, _q, b) => ({ data: await get().createTemplate(mutation(ctx), c.waiverCreateTemplateRequestSchema.parse(b)) }),
    publishTemplate: async (ctx, p, _q, b) => ({ data: await get().publishTemplate(mutation(ctx), p.templateId!, c.waiverPublishTemplateRequestSchema.parse(b)) }),
    retireTemplate: async (ctx, p, _q, b) => ({ data: await get().retireTemplate(mutation(ctx), p.templateId!, c.waiverRetireTemplateRequestSchema.parse(b)) }),
    listSignatures: (ctx, _p, q) => get().listSignatures(ctx.gym.gymId, q),
    sign: async (ctx, _p, _q, b) => ({ data: await get().sign(mutation(ctx), c.waiverSignRequestSchema.parse(b), { timezone: ctx.gym.timezone, ipAddress: ctx.clientIp ?? 'unknown' }) }),
    pdf: (ctx, p) => get().pdf(ctx.gym.gymId, p.signatureId!),
    uploadSignature: async (ctx, _p, _q, b) => {
      const input = c.waiverUploadRequestSchema.parse(b);
      return { data: await get().uploadSignature(mutation(ctx), input.memberId, Buffer.from(input.pngBase64, 'base64')) };
    },
  };
  return Object.entries(c.waiverContracts).map(([key, value]) => {
    const contract: c.EndpointContract = value;
    return route({ ...contract,
      middleware: bodyLimit({ maxSize: 400_000, onError: () => { throw new AppError('invalid_request', 'Request too large'); } }),
      request: { ...(contract.params instanceof z.ZodObject ? { params: contract.params } : {}), ...(contract.query instanceof z.ZodObject ? { query: contract.query } : {}),
        ...(contract.body ? { body: { required: true, content: { 'application/json': { schema: contract.body } } } } : {}) },
      responses: { 200: { description: 'Waiver response', content: { 'application/json': { schema: contract.response } } } },
    }, async ctx => {
      const context = ctx.get('context'); mutation(context);
      const result = await handlers[key as keyof typeof handlers](context, ctx.req.param(), ctx.req.query(), contract.body ? await ctx.req.json() : undefined);
      ctx.header('Cache-Control', 'no-store'); return ctx.json(contract.response.parse(result) as { data: unknown }, 200);
    });
  });
}
export const routes = createWaiverRoutes();
