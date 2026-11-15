// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

/** Identifies the address to clear without retaining its plaintext in a retry job. */
export function billingEmailDigest(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export interface ClearCustomerEmail {
  readonly householdId: string;
  readonly emailDigest: string;
  /** The household's default card when the erasure committed; never select a replacement card on retry. */
  readonly paymentMethodId?: string;
}

export function matchesBillingEmail(value: unknown, digest: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && billingEmailDigest(value) === digest;
}
