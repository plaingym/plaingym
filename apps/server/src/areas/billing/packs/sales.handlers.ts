// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { billingMutation, billingRoute } from '../catalog.routes.js';
import { createPackSalesService, type PackSalesService } from './sales.js';

let configured: PackSalesService | undefined;
export function configurePackSales(service: PackSalesService | undefined) { configured = service; }
export function createPackSalesRoutes(service?: PackSalesService) {
  const fallback = createPackSalesService(), read = () => service ?? configured ?? fallback;
  return [billingRoute(c.billingContracts.sellClassPack, async (ctx, p, _q, body) =>
    ({ data: await read().sell(billingMutation(ctx), p.packId!, body) }))];
}
