// SPDX-License-Identifier: AGPL-3.0-only
import { ranksContracts, membersContracts, type ListResponse } from '@plaingym/shared/contracts';
import { ApiError } from '../../lib/api.js';

export async function allPages<T>(load: (offset: number) => Promise<ListResponse<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; ) {
    const page = await load(offset); rows.push(...page.data);
    offset += page.data.length;
    if (offset >= page.pagination.total) return rows;
    if (!page.data.length) throw new Error('Empty page before end of list');
  }
}
export function createRanksClient(fetcher: typeof fetch = fetch) {
  async function call<K extends keyof typeof ranksContracts>(name: K, input?: unknown, id?: string,
    query: Record<string, string | number | undefined> = {}): Promise<ReturnType<typeof ranksContracts[K]['response']['parse']>> {
    const contract = ranksContracts[name];
    const body = 'body' in contract ? contract.body.parse(input) : undefined;
    if ('params' in contract) contract.params.parse({ id });
    if ('query' in contract) contract.query.parse(query);
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) parameters.set(key, String(value));
    const path = contract.path.replace('{id}', encodeURIComponent(id ?? '')) + (parameters.size ? '?' + parameters.toString() : '');
    const response = await fetcher(path, { method: contract.method.toUpperCase(), credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new ApiError(response.status, 'request_failed');
    return contract.response.parse(await response.json()) as ReturnType<typeof ranksContracts[K]['response']['parse']>;
  }
  return {
    call,
    systems: () => allPages((offset) => call('listRankSystems', undefined, undefined, { offset, limit: 100 })),
    programs: () => allPages((offset) => call('listPrograms', undefined, undefined, { offset, limit: 100 })),
    ranks: (rankSystemId: string) => allPages((offset) => call('listRanks', undefined, undefined, { rankSystemId, offset, limit: 100 })),
    history: (memberId: string) => allPages((offset) => call('listPromotions', undefined, undefined, { memberId, offset, limit: 100 })),
    eligibility: (programId: string, rankId: string, readyOnly: boolean) => allPages((offset) => call('eligibility', undefined, undefined,
      { programId, rankId, readyOnly: String(readyOnly), offset, limit: 100 })),
    members: () => allPages(async (offset) => {
      const contract = membersContracts.listMembers;
      const response = await fetcher(contract.path + '?limit=100&offset=' + offset, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new ApiError(response.status, 'request_failed');
      return contract.response.parse(await response.json());
    }),
  };
}
export type RanksClient = ReturnType<typeof createRanksClient>;
export const ranksClient = createRanksClient();
