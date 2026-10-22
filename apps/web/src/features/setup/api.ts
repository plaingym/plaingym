// SPDX-License-Identifier: AGPL-3.0-only
import { setupContracts, ranksContracts } from '@plaingym/shared/contracts';
import { ApiError } from '../../lib/api.js';

export function createSetupClient(fetcher: typeof fetch = fetch) {
  return {
    async call<K extends keyof typeof setupContracts>(name: K,
      input?: unknown,
      jobId?: string): Promise<ReturnType<typeof setupContracts[K]['response']['parse']>['data']> {
      const contract = setupContracts[name];
      const body = 'body' in contract ? contract.body.parse(input) : undefined;
      const response = await fetcher(jobId ? contract.path.replace('{jobId}', encodeURIComponent(jobId)) : contract.path, {
        method: contract.method.toUpperCase(), credentials: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new ApiError(response.status, 'request_failed');
      return contract.response.parse(await response.json()).data as ReturnType<typeof setupContracts[K]['response']['parse']>['data'];
    },
    async catalog() {
      const response = await fetcher(ranksContracts.catalog.path, { credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new ApiError(response.status, 'request_failed');
      return ranksContracts.catalog.response.parse(await response.json()).data;
    },
    async magicLink(email: string) {
      const response = await fetcher('/api/auth/sign-in/magic-link', { method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, callbackURL: '/setup', errorCallbackURL: '/setup' }) });
      if (!response.ok) throw new ApiError(response.status, 'request_failed');
    },
  };
}
export const setupClient = createSetupClient();
