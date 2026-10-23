// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, gyms } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { decryptSecret } from '../../core/secrets.js';

/** The gym's random 32-byte key, stored encrypted in `gyms.qr_key_encrypted` and restored with the gym.
 * Callers derive their own values with a domain-separated HMAC (household PINs, check-in codes). */
export type GymKeyResolver = (gymId: string) => Promise<Uint8Array>;
export function createGymKeyResolver(options: { key: Buffer; scope?: typeof forGym }): GymKeyResolver {
  const scope = options.scope ?? forGym;
  return async (gymId) => {
    const stored = await scope(gymId, async (tx) => (await tx.select({ qrKey: gyms.qrKey }).from(gyms).where(eq(gyms.id, gymId)))[0]?.qrKey);
    // Fail closed: a missing or short key must never fall back to a weaker secret.
    if (!stored) throw new AppError('unavailable', 'Gym key is not configured');
    const value = Buffer.from(decryptSecret(options.key, 'qr_key', stored), 'base64url');
    if (value.byteLength < 32) throw new AppError('unavailable', 'Gym key is not configured');
    return value;
  };
}
