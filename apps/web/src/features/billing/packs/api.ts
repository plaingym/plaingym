// SPDX-License-Identifier: AGPL-3.0-only
import type { ClassPack } from '@plaingym/shared/contracts';
import { createBillingClient } from '../catalog/api.js';

export function createPackClient(fetcher: typeof fetch = fetch) {
  const client = createBillingClient(fetcher);
  return { ...client,
    packs: async () => {
      const packs: ClassPack[] = [];
      for (let offset = 0; ; ) {
        const page = await client.call('listClassPacks', undefined, {}, { offset, limit: 100 });
        packs.push(...page.data); offset += page.data.length;
        if (offset >= page.pagination.total) return packs;
        if (!page.data.length) throw new Error('Incomplete pack catalog');
      }
    },
    ledger: (memberId: string, offset: number) => client.call('getClassCreditLedger', undefined, { memberId }, { offset, limit: 25 }),
    // The ledger supplies invoice numbers. Resolve one only when requested, within this member's household.
    invoiceId: async (memberId: string, number: number) => {
      const member = await client.member(memberId);
      for (let offset = 0; ; ) {
        const page = await client.call('listInvoices', undefined, {}, { householdId: member.householdId, offset, limit: 100 });
        const invoice = page.data.find(row => row.number === number);
        if (invoice) return invoice.id;
        offset += page.data.length;
        if (offset >= page.pagination.total || !page.data.length) throw new Error('Invoice unavailable');
      }
    },
  };
}
export const packClient = createPackClient();
export type PackClient = ReturnType<typeof createPackClient>;
