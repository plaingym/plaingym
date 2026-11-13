// SPDX-License-Identifier: AGPL-3.0-only
import { all, createBillingClient } from '../catalog/api.js';

export const packCatalogKey = (gymId: string) => ['billing', gymId, 'catalog', 'packs'];
export function createPackClient(fetcher: typeof fetch = fetch) {
  const client = createBillingClient(fetcher);
  return { ...client,
    packs: () => all(offset => client.call('listClassPacks', undefined, {}, { offset, limit: 100 })),
    ledger: (memberId: string, offset: number) => client.call('getClassCreditLedger', undefined, { memberId }, { offset, limit: 25 }),
  };
}
export const packClient = createPackClient();
export type PackClient = ReturnType<typeof createPackClient>;
