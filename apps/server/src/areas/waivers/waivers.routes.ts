// SPDX-License-Identifier: AGPL-3.0-only
import { waiverValidation } from './messages.js';
import { z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '@plaingym/shared';
import { pdfText } from '../../infra/pdf/messages.js';
import * as c from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { rateLimit } from '../../core/rate-limit.js';
import type { RequestContext, RequestEnvironment } from '../../core/context.js';
import { createWaiversService, type WaiversService, type WaiverOptions } from './waivers.js';
import { documentByteLimit } from '../../infra/pdf/document.js';
import { createWaiverDocumentDownloadRoute } from './document-delivery.js';
import { documentReadLimit } from './document-read.js';
import { configureWaiverImageSweep } from './waivers.jobs.js';

let configured: WaiversService | undefined;
export function configureWaivers(options: WaiverOptions) {
  configured = createWaiversService(options); configureWaiverImageSweep(options); return configured;
}
const mutation = (ctx: RequestContext) => {
  if (ctx.principal.kind !== 'staff' || ctx.principal.gymId !== ctx.gym.gymId) throw new AppError('not_found', 'Resource not found');
  return { gymId: ctx.gym.gymId, actor: { kind: 'user' as const, userId: ctx.principal.userId } };
};
export function createWaiverRoutes(service?: WaiversService) {
  const get = () => { const value = service ?? configured; if (!value) throw new Error('Waivers not configured'); return value; };
  const pdfLimit = rateLimit({ limit: 10, windowMs: 60_000, perGym: true });
  const uploadLimit = rateLimit({ limit: 10, windowMs: 60_000, perGym: true });
  const documentLimit = documentReadLimit();
  const limitDemoPdf: MiddlewareHandler<RequestEnvironment> = async (ctx, next) => {
    if (await get().isDemo(ctx.get('context').gym.gymId)) return pdfLimit(ctx, next);
    await next();
  };
  const handlers: Record<keyof typeof c.waiverContracts, (ctx: RequestContext, p: Record<string, string>, q: unknown, b: unknown) => Promise<unknown>> = {
    uploadDocument: async (ctx, _p, _q, b) => ({ data: await get().uploadDocument(mutation(ctx), b as Uint8Array) }),
    document: (ctx, p) => get().document(ctx.gym.gymId, p.templateId!),
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
  return [createWaiverDocumentDownloadRoute(() => get().documentDelivery()), ...Object.entries(c.waiverContracts).map(([key, value]) => {
    const contract: c.EndpointContract = value;
    return route({ ...contract,
      middleware: [bodyLimit({ maxSize: key === 'uploadDocument' ? documentByteLimit : 400_000, onError: () => { throw new AppError('invalid_request', key === 'uploadDocument' ? pdfText('byteLimit') : waiverValidation('requestSize')); } }),
        ...(key === 'pdf' ? [limitDemoPdf] : key === 'document' ? [documentLimit] : key === 'uploadDocument' ? [uploadLimit] : [])],
      request: { ...(contract.params instanceof z.ZodObject ? { params: contract.params } : {}), ...(contract.query instanceof z.ZodObject ? { query: contract.query } : {}),
        ...(key === 'uploadDocument' ? { body: { required: true, content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } } } }
          : contract.body ? { body: { required: true, content: { 'application/json': { schema: contract.body } } } } : {}) },
      responses: { 200: { description: 'Waiver response', content: { 'application/json': { schema: contract.response } } } },
    }, async ctx => {
      const context = ctx.get('context'); mutation(context);
      if (key === 'uploadDocument' && ctx.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf')
        throw new AppError('invalid_request', waiverValidation('pdfType'));
      const result = await handlers[key as keyof typeof handlers](context, ctx.req.param(), ctx.req.query(),
        key === 'uploadDocument' ? new Uint8Array(await ctx.req.arrayBuffer()) : contract.body
          ? await ctx.req.json().catch(() => { throw new AppError('invalid_request', 'Request body must be JSON'); }) : undefined);
      ctx.header('Cache-Control', 'no-store'); return ctx.json(contract.response.parse(result) as { data: unknown }, 200);
    });
  })];
}
export const routes = createWaiverRoutes();
