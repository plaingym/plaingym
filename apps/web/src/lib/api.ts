// SPDX-License-Identifier: AGPL-3.0-only
import { createApiClient as generatedApiClient } from '@plaingym/shared/api';
export function createApiClient(options: Parameters<typeof generatedApiClient>[0] = {}) {
  const client = generatedApiClient(options);
  client.use({ async onResponse({ response }) { await reportApiRefusal(response); } });
  return client;
}
export type { paths } from '@plaingym/shared/api';

/** Typed contract client; auth transport is separate because it is not in OpenAPI. */
export const api = createApiClient({ credentials: 'same-origin' });
const errorListeners = new Set<(error: ApiError) => void>();
export function onApiError(listener: (error: ApiError) => void) {
  errorListeners.add(listener);
  return () => { errorListeners.delete(listener); };
}
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly reason: readonly string[] = []) {
    super('Request failed');
    this.name = 'ApiError';
  }
}
/** Notify once at the response boundary; constructing or mapping an error has no side effects. */
export function notifyApiRefusal(status: number, reasons: readonly string[]): void {
  if (status !== 403 || !reasons.length) return;
  const error = new ApiError(status, 'forbidden', reasons);
  for (const listener of errorListeners) listener(error);
}
/**
 * Require a successful typed-client response before validating its data. The typed client's middleware
 * already reported a refusal, so this only builds the error; `code` picks a code from the parsed body.
 */
export function checked<T>(result: { response: Response; data?: T; error?: unknown }, code?: (body: unknown) => string): T {
  if (!result.response.ok || result.data === undefined) {
    throw new ApiError(result.response.status, code?.(result.error) ?? 'request_failed', reasonsIn(result.error));
  }
  return result.data;
}
/** The `error.details.reason` string array of a parsed error body, else none. */
export function reasonsIn(body: unknown): readonly string[] {
  const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
  const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
  const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
  return Array.isArray(reason) && reason.every((value: unknown) => typeof value === 'string') ? reason : [];
}
export interface ErrorMessageRule { status: number; code: string; message?: string }
function allowedMessageIn(body: unknown, status: number, allowedMessages: readonly ErrorMessageRule[]): string | undefined {
  const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
  return error && typeof error === 'object' && 'message' in error && 'code' in error
    && typeof error.message === 'string' && error.message.trim().length > 0 && error.message.length <= 2000
    && allowedMessages.some(rule => rule.status === status && rule.code === error.code
      && (rule.message === undefined || rule.message === error.message)) ? error.message : undefined;
}
/** Responses whose refusal already reached the listeners, so a second read of one stays silent. */
const reported = new WeakSet<Response>();
export interface Refusal {
  status: number;
  body: unknown;
  reasons: readonly string[];
  message?: string;
  /** The error to throw: this response's status, the given code, and its reasons unless overridden. */
  error(code: string, reasons?: readonly string[]): ApiError;
}
/** Read a refused response once and report a 403 at most once per response; the response stays readable. */
export async function readRefusal(response: Response, allowedMessages: readonly ErrorMessageRule[] = []): Promise<Refusal> {
  // A fetcher that already read the body leaves nothing to parse, and `clone()` would throw on it.
  const body: unknown = response.bodyUsed ? undefined : await response.clone().json().catch(() => undefined);
  const reasons = reasonsIn(body);
  const message = allowedMessageIn(body, response.status, allowedMessages);
  if (response.status === 403 && !reported.has(response)) {
    reported.add(response);
    notifyApiRefusal(403, reasons);
  }
  return {
    status: response.status, body, reasons, ...(message === undefined ? {} : { message }),
    error: (code, override) => new ApiError(response.status, code, override ?? reasons),
  };
}
/** The error to throw for a refused response, after reporting it once. */
export async function refusalError(response: Response, code: string): Promise<ApiError> {
  return (await readRefusal(response)).error(code);
}
/** Clients with their own error classes keep their UI behavior and report structured refusals here. */
export async function reportApiRefusal(response: Response): Promise<void> {
  if (response.status === 403) await readRefusal(response);
}
/** Read an error once, preserving the response and exposing only explicitly allowed, bounded messages. Never notifies. */
export async function readApiError(response: Response, allowedMessages: readonly ErrorMessageRule[] = []): Promise<{ reasons: readonly string[]; message?: string }> {
  const body: unknown = await response.clone().json().catch(() => undefined);
  const message = allowedMessageIn(body, response.status, allowedMessages);
  return { reasons: reasonsIn(body), ...(message === undefined ? {} : { message }) };
}
/** Read structured reason codes without consuming the response or exposing server messages. */
export async function apiErrorReasons(response: Response): Promise<readonly string[]> {
  return (await readApiError(response)).reasons;
}
/** Restrict all API calls to this gym's origin, including injected auth transports. */
export function createJsonTransport(fetcher?: typeof fetch) {
  return async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith('/api/') || /[\\?#]/.test(path)) throw new Error('Expected a local API path');
    const response = await (fetcher ?? fetch)(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
    });
    // Never display arbitrary server/SQL messages to the user.
    if (!response.ok) throw await refusalError(response, response.status === 429 ? 'rate_limited' : 'request_failed');
    return await response.json() as T;
  };
}
