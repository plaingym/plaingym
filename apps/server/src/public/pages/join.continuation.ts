// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const joinCookie = 'plaingym_join';
/** Long enough for Checkout (one hour) and the portal login step after it. */
export const joinCookieLifetimeMs = 2 * 60 * 60 * 1000;
const payload = z.strictObject({ g: z.uuid(), l: z.uuid(), x: z.int().positive() });
/** A signed reference to one pending join in one gym: no token, claim code, email address or other personal data. */
export function joinContinuations(key: Uint8Array) {
  if (key.byteLength < 32) throw new Error('Join continuations require a stable key of at least 32 bytes');
  const macKey = new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'plaingym public join continuation v1', 32));
  const mac = (value: string) => createHmac('sha256', macKey).update(value).digest('base64url');
  return {
    seal(input: { gymId: string; linkId: string; expiresAt: Date }) {
      const value = Buffer.from(JSON.stringify(payload.parse({ g: input.gymId, l: input.linkId, x: input.expiresAt.getTime() }))).toString('base64url');
      return 'v1.' + value + '.' + mac(value);
    },
    /** The pending join's link ID, only for the gym that issued it and before it expires. */
    open(cookie: string | undefined, now: Date, gymId: string): string | null {
      if (!cookie || cookie.length > 512) return null;
      const [version, value, signature, extra] = cookie.split('.');
      if (version !== 'v1' || !value || !signature || extra !== undefined) return null;
      const expected = Buffer.from(mac(value)), actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      try {
        const parsed = payload.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
        return parsed.g === gymId && parsed.x > now.getTime() ? parsed.l : null;
      } catch { return null; }
    },
  };
}
export type JoinContinuations = ReturnType<typeof joinContinuations>;
