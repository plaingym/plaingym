// SPDX-License-Identifier: AGPL-3.0-only
import { createKeyedCommandDigest, normalizeAddress } from '../email/deliveries.js';

let digest: ((request: readonly unknown[]) => string) | undefined;

/**
 * Keys the sign-in account limit's stored digests with the install's `AUTH_SECRET`, so a row of `auth_rate_limit` (or a
 * backup) can't be tested against a list of guessed addresses. `authConfig` calls it once it has checked the secret.
 */
export function configureAccountLimitKey(secret: string): void {
  digest = createKeyedCommandDigest(secret);
}

/** The keyed digest of an account's normalized address that ends its sign-in limit window's key. */
export function accountDigest(email: string): string {
  if (!digest) throw new Error('Sign-in limit key is not configured');
  return digest(['auth.account_limit', normalizeAddress(email)]);
}
