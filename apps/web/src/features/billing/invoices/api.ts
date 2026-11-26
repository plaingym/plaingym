// SPDX-License-Identifier: AGPL-3.0-only
import { linksContracts, membersContracts, releaseInvoiceHoldContract, releaseInvoiceProcessingContract } from '@plaingym/shared/contracts';
import type { CreateSignedLinkRequest, InvoiceStatus, Member } from '@plaingym/shared/contracts';
import { billingRequest, createBillingClient } from '../catalog/api.js';
import { readRefusal } from '../../../lib/api.js';
import { text } from './format.js';

export class InvoiceRequestError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export function invoiceError(error: unknown) {
  const reason = error instanceof InvoiceRequestError ? error.reason : 'save_failed';
  const translated = text('errors.' + reason);
  return translated === 'billing/payments:errors.' + reason ? text('saveError') : translated;
}

export function createInvoiceClient(fetcher: typeof fetch = fetch) {
  const checked: typeof fetch = async (...args) => {
    const response = await fetcher(...args);
    if (!response.ok) {
      const { reasons } = await readRefusal(response);
      const reason = reasons[0] ?? (response.status === 503 ? 'payments_unavailable' : response.status === 403 ? 'forbidden' : 'save_failed');
      throw new InvoiceRequestError(reason);
    }
    return response;
  };
  const client = createBillingClient(checked);
  return { ...client,
    releaseHold: (invoiceId: string) => billingRequest(releaseInvoiceHoldContract, {}, { invoiceId }, {}, checked),
    releaseProcessing: (invoiceId: string) => billingRequest(releaseInvoiceProcessingContract, {}, { invoiceId }, {}, checked),
    invoices: (query: { householdId?: string; status?: InvoiceStatus; offset?: number }) => client.call('listInvoices', undefined, {}, { ...query, limit: 25 }),
    invoice: async (invoiceId: string) => (await client.call('getInvoice', undefined, { invoiceId })).data,
    cards: (householdId: string, offset = 0) => client.call('listPaymentMethods', undefined, { householdId }, { limit: 25, offset }),
    activeDefaultCard: async (householdId: string) => {
      for (let offset = 0; ; ) {
        const page = await client.call('listPaymentMethods', undefined, { householdId }, { limit: 100, offset });
        if (page.data.some(card => card.isDefault && !card.revokedAt)) return true;
        offset += page.data.length;
        if (offset >= page.pagination.total) return false;
        if (!page.data.length) throw new Error('Incomplete card list');
      }
    },
    households: (search: string) => billingRequest(membersContracts.listHouseholds, undefined, {}, { ...(search.trim() ? { search: search.trim() } : {}), limit: 25 }, checked),
    household: async (householdId: string) => (await billingRequest(membersContracts.getHousehold, undefined, { householdId }, {}, checked)).data,
    householdMembers: async (householdId: string) => {
      const people: Member[] = [];
      for (;;) {
        const page = await billingRequest(membersContracts.listMembers, undefined, {}, { householdId, limit: 100, offset: people.length }, checked);
        people.push(...page.data);
        if (people.length >= page.pagination.total) return people;
        if (!page.data.length) throw new Error('Incomplete household member list');
      }
    },
    /** A generation sends the link; without one it is created for the page to show. */
    link: (input: CreateSignedLinkRequest, sendGeneration?: string, sms?: { channel: 'sms'; recipientMemberId?: string }) => sendGeneration
      ? billingRequest(linksContracts.sendLink, { ...input, sendGeneration, ...sms }, {}, {}, checked)
      : billingRequest(linksContracts.createLink, input, {}, {}, checked),
  };
}
export const invoiceClient = createInvoiceClient();
export type InvoiceClient = ReturnType<typeof createInvoiceClient>;
