// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
const receipt = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), gymId: z.uuid(), linkId: z.uuid(), sessionId: z.string().min(1).max(255), expires: z.number(), tablet: z.boolean() });
export type CheckoutReceipt = z.infer<typeof receipt>;
/** A stable installation key binds a provider return to this link without exposing its token to Stripe. */
export function checkoutReceipts(key: Uint8Array) {
  if (key.byteLength < 32) throw new Error('Signed-link receipts require a stable key of at least 32 bytes');
  // GCM authenticates the ciphertext itself; no separate MAC key is needed.
  const encryptionKey = Buffer.from(hkdfSync('sha256', key, 'signed-link-checkout', 'receipt-encryption-v1', 32));
  const aad = Buffer.from('signed-link-checkout:v1');
  return {
    seal(input: CheckoutReceipt) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      cipher.setAAD(aad);
      const value = Buffer.concat([cipher.update(JSON.stringify(receipt.parse(input)), 'utf8'), cipher.final()]);
      return ['v1', nonce.toString('base64url'), value.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },
    open(cookie: string | undefined, now: Date, expected: { gymId: string; linkId?: string }): CheckoutReceipt | null {
      if (!cookie || cookie.length > 2048) return null;
      const [version, iv, value, tag, extra] = cookie.split('.');
      if (version !== 'v1' || !iv || !value || !tag || extra !== undefined) return null;
      try {
        const nonce = Buffer.from(iv, 'base64url'), authTag = Buffer.from(tag, 'base64url');
        if (nonce.length !== 12 || authTag.length !== 16) return null;
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
        decipher.setAAD(aad); decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(Buffer.from(value, 'base64url')), decipher.final()]);
        const result = receipt.parse(JSON.parse(plaintext.toString('utf8')));
        return result.expires > now.getTime() && result.gymId === expected.gymId
          && (!expected.linkId || result.linkId === expected.linkId) ? result : null;
      }
      catch { return null; }
    },
  };
}
