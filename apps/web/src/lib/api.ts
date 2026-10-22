// SPDX-License-Identifier: AGPL-3.0-only
import { createApiClient } from '@plaingym/shared/api';
export { createApiClient };
export type { paths } from '@plaingym/shared/api';

/** Typed contract client; auth transport is separate because it is not in OpenAPI. */
export const api = createApiClient({ credentials: 'same-origin' });
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super('Request failed');
    this.name = 'ApiError';
  }
}
/** Restrict all API calls to this gym's origin, including injected auth transports. */
export function createJsonTransport(fetcher: typeof fetch = fetch) {
  return async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith('/api/') || /[\\?#]/.test(path)) throw new Error('Expected a local API path');
    const response = await fetcher(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      // Never display arbitrary server/SQL messages to the user.
      throw new ApiError(response.status, response.status === 429 ? 'rate_limited' : 'request_failed');
    }
    return await response.json() as T;
  };
}
