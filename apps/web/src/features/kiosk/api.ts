// SPDX-License-Identifier: AGPL-3.0-only
import {
  kioskFamilyCheckinResponseSchema, kioskLookupResponseSchema,
  type KioskCheckinResult, type KioskLookupResponse, type KioskNamePinCheckinRequest,
} from '@plaingym/shared/contracts';

const tokenKey = 'plaingym.kioskToken';
/** The device token lives only in this browser's storage; the URL fragment form (`#token=…`) is never sent to the server. */
export function readToken(): string | null {
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (fragment) {
      window.localStorage.setItem(tokenKey, fragment);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    return window.localStorage.getItem(tokenKey);
  } catch { return null; }
}
export function saveToken(token: string) { try { window.localStorage.setItem(tokenKey, token.trim()); } catch { /* storage unavailable */ } }
export function forgetToken() { try { window.localStorage.removeItem(tokenKey); } catch { /* storage unavailable */ } }

/** A revoked or unknown token: the device must be set up again. */
export class KioskAuthError extends Error {}
async function post<T>(token: string, path: string, body: unknown, schema: { parse(input: unknown): T }): Promise<T> {
  // No cookies: the kiosk authenticates only with its device token, never a staff session.
  const response = await fetch(path, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new KioskAuthError('Device not authorized');
  if (!response.ok) throw new Error('Request failed');
  return schema.parse(await response.json());
}
export const kioskApi = {
  async lookup(token: string, name: string, pin: string): Promise<KioskLookupResponse['data']> {
    return (await post(token, '/api/kiosk/lookup', { name, pin }, kioskLookupResponseSchema)).data;
  },
  async checkin(token: string, request: KioskNamePinCheckinRequest): Promise<KioskCheckinResult[]> {
    return (await post(token, '/api/kiosk/checkin', request, kioskFamilyCheckinResponseSchema)).data;
  },
};
