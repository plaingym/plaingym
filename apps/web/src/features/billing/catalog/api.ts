// SPDX-License-Identifier: AGPL-3.0-only
import { billingContracts, settingsContracts, membersContracts, type EndpointContract, type ListResponse } from '@plaingym/shared/contracts';
import { ApiError } from '../../../lib/api.js';

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
  if (!response.ok) throw new ApiError(response.status, response.status === 409 ? 'conflict' : 'request_failed');
  return contract.response.parse(await response.json()) as ReturnType<C['response']['parse']>;
}
async function all<T>(load: (offset: number) => Promise<ListResponse<T>>) {
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
