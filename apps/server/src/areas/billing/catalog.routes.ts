// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { AppError } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { createCatalogService, type CatalogService } from './catalog.js';

export function billingMutation(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Resource not found');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function billingRoute(contract: c.EndpointContract,
  handler: (ctx: RequestContext, params: Record<string, string>, query: unknown, body: unknown) => Promise<unknown>) {
  const params = contract.params instanceof z.ZodObject ? contract.params : undefined;
  const query = contract.query instanceof z.ZodObject ? contract.query : undefined;
  const status = contract.successStatus ?? 200;
  return route({ ...contract, middleware: bodyLimit({ maxSize: 64_000, onError: () => { throw new AppError('invalid_request', 'Request too large'); } }),
    request: { ...(params ? { params } : {}), ...(query ? { query } : {}),
      ...(contract.body ? { body: { required: true, content: { 'application/json': { schema: contract.body } } } } : {}) },
    responses: { [status]: { description: 'Billing response', content: { 'application/json': { schema: contract.response } } } },
  }, async ctx => {
    const context = ctx.get('context'); billingMutation(context);
    const result = await handler(context, ctx.req.param(), ctx.req.query(), contract.body ? await ctx.req.json() : undefined);
    ctx.header('Cache-Control', 'no-store');
    return ctx.json(contract.response.parse(result) as { data: unknown }, status);
  });
}
let configured: CatalogService | undefined;
export function configureCatalog(service: CatalogService) { configured = service; }
export function createCatalogRoutes(service?: CatalogService) {
  const fallback = createCatalogService(), read = () => service ?? configured ?? fallback;
  return [
    billingRoute(c.billingContracts.listTaxRates, async (ctx, _p, q) => read().listTaxRates(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getTaxRate, async (ctx, p) => ({ data: await read().getTaxRate(ctx.gym.gymId, p.taxRateId!) })),
    billingRoute(c.billingContracts.createTaxRate, async (ctx, _p, _q, b) => ({ data: await read().createTaxRate(billingMutation(ctx), c.createTaxRateRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.updateTaxRate, async (ctx, p, _q, b) => ({ data: await read().updateTaxRate(billingMutation(ctx), p.taxRateId!, c.updateTaxRateRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.listPlans, async (ctx, _p, q) => read().listPlans(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getPlan, async (ctx, p) => ({ data: await read().getPlan(ctx.gym.gymId, p.planId!) })),
    billingRoute(c.billingContracts.createPlan, async (ctx, _p, _q, b) => ({ data: await read().createPlan(billingMutation(ctx), c.createPlanRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.updatePlan, async (ctx, p, _q, b) => ({ data: await read().updatePlan(billingMutation(ctx), p.planId!, c.updatePlanRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.listChargeTypes, async (ctx, _p, q) => read().listChargeTypes(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getChargeType, async (ctx, p) => ({ data: await read().getChargeType(ctx.gym.gymId, p.chargeTypeId!) })),
    billingRoute(c.billingContracts.createChargeType, async (ctx, _p, _q, b) => ({ data: await read().createChargeType(billingMutation(ctx), c.createChargeTypeRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.updateChargeType, async (ctx, p, _q, b) => ({ data: await read().updateChargeType(billingMutation(ctx), p.chargeTypeId!, c.updateChargeTypeRequestSchema.parse(b)) })),
  ];
}
export const routes = createCatalogRoutes();
