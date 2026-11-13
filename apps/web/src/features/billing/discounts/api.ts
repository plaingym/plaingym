// SPDX-License-Identifier: AGPL-3.0-only
import { discountContracts, type Discount } from '@plaingym/shared/contracts';
import { billingRequest } from '../catalog/api.js';

export function createDiscountClient(fetcher: typeof fetch = fetch) {
  return {
    list: async () => {
      const rows: Discount[] = [];
      for (let offset = 0; ; ) {
        const page = await billingRequest(discountContracts.listDiscounts, undefined, {}, { offset, limit: 100 }, fetcher);
        rows.push(...page.data); offset += page.data.length;
        if (offset >= page.pagination.total) return rows;
        if (!page.data.length) throw new Error('Incomplete discount catalog');
      }
    },
    create: (input: unknown) => billingRequest(discountContracts.createDiscount, input, {}, {}, fetcher),
    update: (discountId: string, input: unknown) => billingRequest(discountContracts.updateDiscount, input, { discountId }, {}, fetcher),
  };
}
export const discountClient = createDiscountClient();
export type DiscountClient = ReturnType<typeof createDiscountClient>;
