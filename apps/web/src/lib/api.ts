// SPDX-License-Identifier: AGPL-3.0-only
import { createApiClient } from '@plaingym/shared/api';
export { createApiClient };
export type { paths } from '@plaingym/shared/api';

/** Typed contract client; auth transport is separate because it is not in OpenAPI. */
export const api = createApiClient({ credentials: 'same-origin', fetch: (...args) => fetch(...args) });
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly reason: readonly string[] = []) {
    super('Request failed');
    this.name = 'ApiError';
  }
}
/** Require a successful typed-client response before validating its data. */
export function checked<T>(result: { response: Response; data?: T }): T {
  if (!result.response.ok || result.data === undefined) throw new ApiError(result.response.status, 'request_failed');
  return result.data;
}
export interface ErrorMessageRule { status: number; code: string; message?: string }
/** Read an error once, preserving the response and exposing only explicitly allowed, bounded messages. */
export async function readApiError(response: Response, allowedMessages: readonly ErrorMessageRule[] = []): Promise<{ reasons: readonly string[]; message?: string }> {
  const body: unknown = await response.clone().json().catch(() => undefined);
  const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
  const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
  const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
  const reasons = Array.isArray(reason) && reason.every((value: unknown) => typeof value === 'string') ? reason : [];
  const message = error && typeof error === 'object' && 'message' in error && 'code' in error
    && typeof error.message === 'string' && error.message.trim().length > 0 && error.message.length <= 2000
    && allowedMessages.some(rule => rule.status === response.status && rule.code === error.code
      && (rule.message === undefined || rule.message === error.message)) ? error.message : undefined;
  return { reasons, ...(message === undefined ? {} : { message }) };
}
/** Read structured reason codes without consuming the response or exposing server messages. */
export async function apiErrorReasons(response: Response): Promise<readonly string[]> {
  return (await readApiError(response)).reasons;
}
/** Restrict all API calls to this gym's origin, including injected auth transports. */
export function createJsonTransport(fetcher: typeof fetch = (...args) => fetch(...args)) {
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
