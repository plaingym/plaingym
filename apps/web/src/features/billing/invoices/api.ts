// SPDX-License-Identifier: AGPL-3.0-only
import { linksContracts, membersContracts, releaseInvoiceHoldContract } from '@plaingym/shared/contracts';
import type { CreateSignedLinkRequest, InvoiceStatus } from '@plaingym/shared/contracts';
import { billingRequest, createBillingClient } from '../catalog/api.js';
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
      const body: unknown = await response.clone().json().catch(() => null);
      const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
      const details = error && typeof error === 'object' && 'details' in error ? error.details : null;
      const reasons = details && typeof details === 'object' && 'reason' in details ? details.reason : null;
      const reason = Array.isArray(reasons) && typeof reasons[0] === 'string' ? reasons[0]
        : response.status === 503 ? 'payments_unavailable' : response.status === 403 ? 'forbidden' : 'save_failed';
      throw new InvoiceRequestError(reason);
    }
    return response;
  };
  const client = createBillingClient(checked);
  return { ...client,
    releaseHold: (invoiceId: string) => billingRequest(releaseInvoiceHoldContract, {}, { invoiceId }, {}, checked),
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
    link: (input: CreateSignedLinkRequest, send: boolean) => send
      ? billingRequest(linksContracts.sendLink, input, {}, {}, checked)
      : billingRequest(linksContracts.createLink, input, {}, {}, checked),
  };
}
export const invoiceClient = createInvoiceClient();
export type InvoiceClient = ReturnType<typeof createInvoiceClient>;
