// SPDX-License-Identifier: AGPL-3.0-only
import { setupContracts, ranksContracts } from '@plaingym/shared/contracts';
import { ApiError } from '../../lib/api.js';

export function createSetupClient(fetcher: typeof fetch = fetch) {
  function setupToken(): string | null {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('token');
    if (token) {
      sessionStorage.setItem('setup.token', token);
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
    return token ?? sessionStorage.getItem('setup.token');
  }
  return {
    async call<K extends keyof typeof setupContracts>(name: K,
      input?: unknown,
      jobId?: string): Promise<ReturnType<typeof setupContracts[K]['response']['parse']>['data']> {
      const contract = setupContracts[name];
      const body = 'body' in contract ? contract.body.parse(input) : undefined;
      const token = setupToken();
      const response = await fetcher(jobId ? contract.path.replace('{jobId}', encodeURIComponent(jobId)) : contract.path, {
        method: contract.method.toUpperCase(), credentials: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(contract.gate === 'uninitialized_install' && name !== 'status' && token ? { 'X-Setup-Token': token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new ApiError(response.status, 'request_failed');
      if (name === 'finish') sessionStorage.removeItem('setup.token');
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
