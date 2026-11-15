// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, hkdfSync } from 'node:crypto';

/** Identifies the address to clear without retaining its plaintext in a retry job. */
export function billingEmailDigest(email: string, secret: string): string {
  if (!secret) throw new Error('Billing email erasure secret is required');
  const key = Buffer.from(hkdfSync('sha256', secret, new Uint8Array(0), 'plaingym billing email erasure v1', 32));
  return 'k1:' + createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex');
}

export interface ClearCustomerEmail {
  readonly householdId: string;
  readonly emailDigest: string;
  /** Install secret, supplied only while executing; never stored in a job or audit. */
  readonly secret: string;
  /** Every unrevoked card at erasure; never select replacement cards on retry. */
  readonly paymentMethodIds?: readonly string[] | undefined;
  /** Compatibility with jobs queued before every card was included. */
  readonly paymentMethodId?: string | undefined;
}

export function matchesBillingEmail(value: unknown, digest: string, secret: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  // Drain already queued jobs; new erasures always emit a versioned, keyed digest.
  return (/^[a-f0-9]{64}$/.test(digest)
    ? createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
    : billingEmailDigest(value, secret)) === digest;
}
