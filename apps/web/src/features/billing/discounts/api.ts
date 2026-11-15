// SPDX-License-Identifier: AGPL-3.0-only
import { discountContracts } from '@plaingym/shared/contracts';
import { all, billingRequest } from '../catalog/api.js';

export function createDiscountClient(fetcher: typeof fetch = fetch) {
  return {
    list: () => all(offset => billingRequest(discountContracts.listDiscounts, undefined, {}, { offset, limit: 100 }, fetcher)),
    create: (input: unknown) => billingRequest(discountContracts.createDiscount, input, {}, {}, fetcher),
    update: (discountId: string, input: unknown) => billingRequest(discountContracts.updateDiscount, input, { discountId }, {}, fetcher),
  };
}
export const discountClient = createDiscountClient();
export type DiscountClient = ReturnType<typeof createDiscountClient>;
