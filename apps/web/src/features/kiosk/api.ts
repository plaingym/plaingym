// SPDX-License-Identifier: AGPL-3.0-only
import { followServerVersion } from '../../app/version.js';
import {
  kioskFamilyCheckinResponseSchema, kioskLookupResponseSchema,
  type KioskCheckinResult, type KioskLookupResponse, type KioskNamePinCheckinRequest,
} from '@plaingym/shared/contracts';

export const tokenKey = 'plaingym.kioskToken';
/** The device token lives only in this browser's storage; the URL fragment form (`#token=…`) is never sent to the server. */
export function readToken(onSaveError?: () => void): string | null {
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get('token')?.trim();
    if (fragment) {
      const saved = saveToken(fragment);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (!saved) { onSaveError?.(); return null; }
    }
    return window.localStorage.getItem(tokenKey);
  } catch { return null; }
}
export function saveToken(token: string): boolean {
  try { window.localStorage.setItem(tokenKey, token.trim()); return true; } catch { return false; }
}
export function forgetToken(token: string) {
  try {
    if (window.localStorage.getItem(tokenKey) === token) window.localStorage.removeItem(tokenKey);
  } catch { /* storage unavailable */ }
}

/** A revoked or unknown token: the device must be set up again. */
export class KioskAuthError extends Error {}
/** A kiosk can stay on one route across releases. Check before sending any member credentials. */
export class KioskReloadError extends Error {}
export async function checkKioskVersion() {
  if (import.meta.env.DEV) return;
  try {
    await followServerVersion({ reload: (destination) => {
      window.location.assign(destination);
      // Navigation is asynchronous: do not send a request from the old bundle meanwhile.
      throw new KioskReloadError('Loading the current kiosk');
    } });
  } catch (error) {
    // A guard that cannot act (blocked session storage, a reload that did not fix the mismatch) must not
    // stop check-in: the strict response parsing still protects the device.
    if (error instanceof KioskReloadError) throw error;
  }
}
async function post<T>(token: string, path: string, body: unknown, schema: { parse(input: unknown): T }): Promise<T> {
  await checkKioskVersion();
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
