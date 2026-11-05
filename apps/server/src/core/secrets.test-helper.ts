// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, randomBytes } from 'node:crypto';
import type { SecretClass } from './secrets.js';

/** A `v1` envelope, as installs stored secrets before `v2`: AES-256-GCM with only the secret class as additional data. */
export function legacySecret(key: Buffer, secretClass: SecretClass, plaintext: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(secretClass));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
