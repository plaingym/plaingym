// SPDX-License-Identifier: AGPL-3.0-only
import { billingContracts, settingsContracts, membersContracts, type ApplyPlanPriceChangeRequest, type EndpointContract, type ListResponse } from '@plaingym/shared/contracts';
import { ApiError, readApiError } from '../../../lib/api.js';
import { parseResponse } from '../../../lib/response.js';

/** Only the price-change endpoint's bounded, expected client errors may display its message. */
export class PriceChangeError extends ApiError {
  constructor(status: number, message: string, reasons: readonly string[]) {
    super(status, 'invalid_request', reasons); this.message = message;
  }
}

export async function billingRequest<C extends EndpointContract>(contract: C,
  input?: unknown, params: Record<string, string> = {}, query: Record<string, string | number | undefined> = {}, fetcher: typeof fetch = fetch): Promise<ReturnType<C['response']['parse']>> {
  contract.params?.parse(params); contract.query?.parse(query);
  const body = contract.body?.parse(input), search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  const path = contract.path.replace(/\{([^}]+)\}/g, (_match, key: string) => encodeURIComponent(params[key] ?? ''));
  const response = await fetcher(path + (search.size ? '?' + search : ''), { method: contract.method.toUpperCase(),
    credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const error = await readApiError(response, contract.path === billingContracts.applyPlanPriceChange.path
      && contract.method === billingContracts.applyPlanPriceChange.method
      && response.status >= 400 && response.status < 500 && response.status !== 409
      ? [{ status: response.status, code: 'invalid_request' }, { status: response.status, code: 'not_found' },
        { status: response.status, code: 'forbidden' }, { status: response.status, code: 'unauthenticated' },
        { status: response.status, code: 'rate_limited' }] : []);
    if (error.message) throw new PriceChangeError(response.status, error.message, error.reasons);
    throw new ApiError(response.status, response.status === 409 ? 'conflict' : 'request_failed',
      error.reasons);
  }
  return parseResponse(contract.response, await response.json()) as ReturnType<C['response']['parse']>;
}
export async function all<T>(load: (offset: number) => Promise<ListResponse<T>>) {
  const result: T[] = [];
  for (let offset = 0; ; ) {
    const page = await load(offset); result.push(...page.data); offset += page.data.length;
    if (offset >= page.pagination.total) return result;
    if (!page.data.length) throw new Error('Incomplete catalog');
  }
}
export function createBillingClient(fetcher: typeof fetch = fetch) {
  const call = <K extends keyof typeof billingContracts>(name: K, input?: unknown, params: Record<string, string> = {},
    query: Record<string, string | number | undefined> = {}) => billingRequest(billingContracts[name], input, params, query, fetcher) as Promise<ReturnType<typeof billingContracts[K]['response']['parse']>>;
  return { call,
    plans: () => all(offset => call('listPlans', undefined, {}, { offset, limit: 100 })),
    taxes: () => all(offset => call('listTaxRates', undefined, {}, { offset, limit: 100 })),
    charges: () => all(offset => call('listChargeTypes', undefined, {}, { offset, limit: 100 })),
    memberships: (query: { memberId?: string; householdId?: string }) => all(offset => call('listMemberships', undefined, {}, { ...query, offset, limit: 100 })),
    settings: async () => (await billingRequest(settingsContracts.get, undefined, {}, {}, fetcher)).data,
    member: async (memberId: string) => (await billingRequest(membersContracts.getMember, undefined, { memberId }, {}, fetcher)).data,
    householdBilling: async (householdId: string) => (await billingRequest(membersContracts.getHouseholdBilling, undefined, { householdId }, {}, fetcher)).data,
  };
}
export const billingClient = createBillingClient();
export type BillingClient = ReturnType<typeof createBillingClient>;
export async function previewPriceChange(client: BillingClient, planId: string, amountCents: number, effectiveOn: string) {
  return (await client.call('previewPlanPriceChange', undefined, { planId }, { amountCents, effectiveOn })).data;
}
export async function applyPriceChange(client: BillingClient, planId: string, request: ApplyPlanPriceChangeRequest) {
  return (await client.call('applyPlanPriceChange', request, { planId })).data;
}
