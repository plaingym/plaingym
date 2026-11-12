// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { billingMutation, billingRoute } from '../catalog.routes.js';
import { createDiscountCatalogService, type DiscountCatalogService } from './catalog.js';

export function createDiscountCatalogRoutes(service: DiscountCatalogService = createDiscountCatalogService()) {
  return [
    billingRoute(c.discountContracts.listDiscounts, async (ctx, _p, q) => service.list(ctx.gym.gymId, q)),
    billingRoute(c.discountContracts.getDiscount, async (ctx, p) => ({ data: await service.get(ctx.gym.gymId, p.discountId!) })),
    billingRoute(c.discountContracts.createDiscount, async (ctx, _p, _q, b) =>
      ({ data: await service.create(billingMutation(ctx), c.createDiscountRequestSchema.parse(b)) })),
    billingRoute(c.discountContracts.updateDiscount, async (ctx, p, _q, b) =>
      ({ data: await service.update(billingMutation(ctx), p.discountId!, c.updateDiscountRequestSchema.parse(b)) })),
  ];
}
export const routes = createDiscountCatalogRoutes();
