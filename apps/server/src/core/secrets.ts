// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encryptedFieldFor, encryptedFields } from '@plaingym/db';
export type SecretClass = (typeof encryptedFields)[number]['secretClass'];
/**
 * Where a stored secret lives: its registered class, which names its table and column, and the ID of the row that
 * holds it (for `gyms` columns, the gym). A `v2` envelope authenticates all of it, so a value copied to another gym's
 * row, another row or another column no longer opens. `v1` envelopes, written before, authenticate only the class.
 */
export interface SecretContext { readonly secretClass: SecretClass; readonly owner: string }
export type SecretVersion = 'v1' | 'v2';
export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('APP_ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(hex, 'hex');
}
const rowId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function additionalData(version: SecretVersion, key: Buffer, context: SecretContext): Buffer {
  if (key.length !== 32) throw new Error('Invalid encryption key');
  const field = encryptedFieldFor(context.secretClass);
  if (typeof context.owner !== 'string' || !rowId.test(context.owner)) throw new Error('Invalid secret owner');
  if (version === 'v1') return Buffer.from(field.secretClass);
  return Buffer.from(JSON.stringify(['plaingym-secret-v2', field.secretClass, field.table, field.column, context.owner.toLowerCase()]));
}
/** A new `v2` envelope: `v2.<iv>.<ciphertext>.<tag>`, AES-256-GCM with the value's context as additional data. */
export function encryptSecret(key: Buffer, context: SecretContext, plaintext: string): string {
  const aad = additionalData('v2', key, context);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v2', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
/** Opens a `v1` or `v2` envelope. Every failure is the same fixed error, which never quotes the input. */
export function openSecret(key: Buffer, context: SecretContext, envelope: string): { version: SecretVersion; plaintext: string } {
  try {
    const parts = envelope.split('.');
    const version = parts[0];
    if (parts.length !== 4 || (version !== 'v1' && version !== 'v2')) throw new Error();
    const aad = additionalData(version, key, context);
    const decode = (part: string) => {
      if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new Error();
      const value = Buffer.from(part, 'base64url');
      if (value.toString('base64url') !== part) throw new Error();
      return value;
    };
    const iv = decode(parts[1]!), ciphertext = decode(parts[2]!), tag = decode(parts[3]!);
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return { version, plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8') };
  } catch { throw new Error('Unable to decrypt secret'); }
}
export function decryptSecret(key: Buffer, context: SecretContext, envelope: string): string {
  return openSecret(key, context, envelope).plaintext;
}
/**
 * The stored value as a `v2` envelope under `to`, or null when it already is one (it opens as `v2` with `to`): what
 * restore's re-key, the one-time `v1` rewrite and a key rotation store. Anything else must open with `from`, as `v1` or
 * `v2`; otherwise this throws the fixed decrypt error. `from` and `to` may be the same key.
 */
export function reencryptSecret(from: Buffer, to: Buffer, context: SecretContext, envelope: string): string | null {
  let current: ReturnType<typeof openSecret> | null;
  try { current = openSecret(to, context, envelope); } catch { current = null; }
  if (current?.version === 'v2') return null;
  return encryptSecret(to, context, current ? current.plaintext : decryptSecret(from, context, envelope));
}
