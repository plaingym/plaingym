// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { billingMutation, billingRoute } from '../catalog.routes.js';
import { createPackCatalogService, type PackCatalogService } from './catalog.js';
import { createPackSalesRoutes } from './sales.handlers.js';
import { createCreditLedgerRoutes } from './ledger.handlers.js';

export function createPackCatalogRoutes(service?: PackCatalogService) {
  const fallback = service ?? createPackCatalogService(), read = () => fallback;
  return [
    billingRoute(c.billingContracts.listClassPacks, async (ctx, _p, q) => read().list(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getClassPack, async (ctx, p) => ({ data: await read().get(ctx.gym.gymId, p.packId!) })),
    billingRoute(c.billingContracts.createClassPack, async (ctx, _p, _q, b) =>
      ({ data: await read().create(billingMutation(ctx), c.createClassPackRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.updateClassPack, async (ctx, p, _q, b) =>
      ({ data: await read().update(billingMutation(ctx), p.packId!, c.updateClassPackRequestSchema.parse(b)) })),
  ];
}
export const routes = [...createPackCatalogRoutes(), ...createPackSalesRoutes(), ...createCreditLedgerRoutes()];
