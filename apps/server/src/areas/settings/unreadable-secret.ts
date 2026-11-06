// SPDX-License-Identifier: AGPL-3.0-only
import { logError } from '../../core/log.js';

// Retain only the last failed ciphertext for each secret and owner, never plaintext.
// A different key object or changed value retries the read; removing a value clears it.
const failures = new WeakMap<Buffer, Map<string, string>>();
export function readStoredSecret<T>(key: Buffer, secretClass: string, owner: string, value: string | null, read: () => T): T | null {
  const identity = JSON.stringify([secretClass, owner]);
  const failed = failures.get(key);
  if (!value) { failed?.delete(identity); return null; }
  if (failed?.get(identity) === value) return null;
  try {
    const result = read();
    failed?.delete(identity);
    return result;
  } catch (error) {
    const cache = failed ?? new Map<string, string>();
    cache.set(identity, value);
    failures.set(key, cache);
    logError(`settings.${secretClass}_unreadable`, { gymId: owner }, error);
    return null;
  }
}
