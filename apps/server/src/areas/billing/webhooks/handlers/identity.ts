// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

/** RFC 9562 UUIDv5: stable across concurrent delivery and process restarts. */
export function processorRefundId(gymId: string, processorId: string): string {
  const digest = createHash('sha1').update(Buffer.from(gymId.replaceAll('-', ''), 'hex'))
    .update('billing.refund:' + processorId).digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
