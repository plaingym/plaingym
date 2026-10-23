// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Resolve a stable, random per-gym secret; never derive it from the install encryption key. */
export type HouseholdPinSecret = (gymId: string) => Promise<Uint8Array>;
export function hashHouseholdPin(secret: Uint8Array, gymId: string, householdId: string, pin: string): string {
  if (secret.byteLength < 32 || !/^[0-9]{4,8}$/.test(pin)) throw new Error('Invalid PIN configuration');
  return createHmac('sha256', secret).update(JSON.stringify(['household-pin-v1', gymId, householdId, pin])).digest('hex');
}
export function verifyHouseholdPin(secret: Uint8Array, gymId: string, householdId: string, pin: string, hash: string | null): boolean {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !/^[0-9]{4,8}$/.test(pin)) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashHouseholdPin(secret, gymId, householdId, pin), 'hex'));
}
