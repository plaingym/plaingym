// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encryptedFieldFor, encryptedFields } from '@plaingym/db';
export type SecretClass = (typeof encryptedFields)[number]['secretClass'];
export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('APP_ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(hex, 'hex');
}
function validate(key: Buffer, secretClass: SecretClass) {
  if (key.length !== 32) throw new Error('Invalid encryption key');
  encryptedFieldFor(secretClass);
}
export function encryptSecret(key: Buffer, secretClass: SecretClass, plaintext: string): string {
  validate(key, secretClass);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(secretClass));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
export function decryptSecret(key: Buffer, secretClass: SecretClass, envelope: string): string {
  try {
    validate(key, secretClass);
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
    const decode = (part: string) => {
      if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new Error();
      const value = Buffer.from(part, 'base64url');
      if (value.toString('base64url') !== part) throw new Error();
      return value;
    };
    const iv = decode(parts[1]!), ciphertext = decode(parts[2]!), tag = decode(parts[3]!);
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(secretClass));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new Error('Unable to decrypt secret'); }
}
