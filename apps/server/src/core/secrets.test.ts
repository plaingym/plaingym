// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { encryptedFields } from '@plaingym/db';
import { encryptSecret, decryptSecret, parseEncryptionKey, type SecretClass } from './secrets.js';
const key = parseEncryptionKey('11'.repeat(32));
describe('secret envelopes', () => {
  it.each(encryptedFields)('round trips $secretClass with random IVs and class binding', ({ secretClass }) => {
    const plaintext = 'private value \u2603';
    const first = encryptSecret(key, secretClass, plaintext), second = encryptSecret(key, secretClass, plaintext);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(first).not.toContain(plaintext); expect(first).not.toBe(second);
    expect(decryptSecret(key, secretClass, first)).toBe(plaintext);
    expect(() => decryptSecret(parseEncryptionKey('22'.repeat(32)), secretClass, first)).toThrow('Unable to decrypt secret');
    const other = secretClass === 'qr_key' ? 'smtp_config' : 'qr_key';
    expect(() => decryptSecret(key, other, first)).toThrow('Unable to decrypt secret');
    for (const index of [1, 2, 3]) {
      const parts = first.split('.'); parts[index] = (parts[index]!.startsWith('A') ? 'B' : 'A') + parts[index]!.slice(1);
      expect(() => decryptSecret(key, secretClass, parts.join('.'))).toThrow('Unable to decrypt secret');
    }
  });
  it('rejects malformed envelopes without including input in errors', () => {
    const envelope = encryptSecret(key, 'qr_key', '');
    expect(decryptSecret(key, 'qr_key', envelope)).toBe('');
    for (const value of ['secret-input', envelope.replace('v1.', 'v2.'), envelope + '.extra', envelope + '=', 'v1.AA.AA.AA']) {
      expect(() => decryptSecret(key, 'qr_key', value)).toThrow(/^Unable to decrypt secret$/);
    }
    expect(() => encryptSecret(key, 'unknown' as SecretClass, 'value')).toThrow('Unregistered');
  });
  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' ' + 'a'.repeat(64)])('rejects invalid key %s', (value) => {
    expect(() => parseEncryptionKey(value)).toThrow('APP_ENCRYPTION_KEY');
  });
});
