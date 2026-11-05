// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { encryptedFields, uuidv7 } from '@plaingym/db';
import { decryptSecret, encryptSecret, openSecret, parseEncryptionKey, reencryptSecret, type SecretClass } from './secrets.js';
import { legacySecret } from './secrets.test-helper.js';

const key = parseEncryptionKey('11'.repeat(32)), otherKey = parseEncryptionKey('22'.repeat(32));
const gymA = uuidv7(), gymB = uuidv7();
const fail = 'Unable to decrypt secret';
/** Another registered class: a different column of the same table where there is one, otherwise of another table. */
const otherClass = (secretClass: SecretClass): SecretClass => {
  const table = encryptedFields.find((field) => field.secretClass === secretClass)!.table;
  return (encryptedFields.find((field) => field.table === table && field.secretClass !== secretClass) ?? encryptedFields[0]!).secretClass;
};
describe('secret envelopes', () => {
  it.each(encryptedFields)('round trips $secretClass as v2 with random IVs, bound to its class, column and row', ({ secretClass }) => {
    const plaintext = 'private value ☃', context = { secretClass, owner: gymA };
    const first = encryptSecret(key, context, plaintext), second = encryptSecret(key, context, plaintext);
    expect(first).toMatch(/^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(first).not.toContain(plaintext); expect(first).not.toBe(second);
    expect(decryptSecret(key, context, first)).toBe(plaintext);
    expect(openSecret(key, context, first)).toEqual({ version: 'v2', plaintext });
    // The owning row's ID is compared case-insensitively, as Postgres prints UUIDs in lower case.
    expect(decryptSecret(key, { secretClass, owner: gymA.toUpperCase() }, first)).toBe(plaintext);
    expect(() => decryptSecret(otherKey, context, first)).toThrow(fail);
    // Moved to another gym's row (or another row of the table), or to another column, it no longer opens.
    expect(() => decryptSecret(key, { secretClass, owner: gymB }, first)).toThrow(fail);
    expect(() => decryptSecret(key, { secretClass: otherClass(secretClass), owner: gymA }, first)).toThrow(fail);
    for (const index of [1, 2, 3]) {
      const parts = first.split('.'); parts[index] = (parts[index]!.startsWith('A') ? 'B' : 'A') + parts[index]!.slice(1);
      expect(() => decryptSecret(key, context, parts.join('.'))).toThrow(fail);
    }
  });
  it.each(encryptedFields)('still reads a v1 $secretClass value, which only its class binds', ({ secretClass }) => {
    const legacy = legacySecret(key, secretClass, 'legacy value');
    expect(openSecret(key, { secretClass, owner: gymA }, legacy)).toEqual({ version: 'v1', plaintext: 'legacy value' });
    // The weakness v2 closes: a v1 value opens in any row.
    expect(decryptSecret(key, { secretClass, owner: gymB }, legacy)).toBe('legacy value');
    expect(() => decryptSecret(key, { secretClass: otherClass(secretClass), owner: gymA }, legacy)).toThrow(fail);
    expect(() => decryptSecret(otherKey, { secretClass, owner: gymA }, legacy)).toThrow(fail);
    // A v2 envelope is never read with v1's additional data, nor the reverse.
    expect(() => decryptSecret(key, { secretClass, owner: gymA }, legacy.replace(/^v1\./, 'v2.'))).toThrow(fail);
    expect(() => decryptSecret(key, { secretClass, owner: gymA }, encryptSecret(key, { secretClass, owner: gymA }, 'x').replace(/^v2\./, 'v1.'))).toThrow(fail);
  });
  it('re-encrypts as v2 under the new key, and leaves a value that already is one', () => {
    const context = { secretClass: 'stripe_config', owner: gymA } as const;
    const legacy = legacySecret(key, 'stripe_config', 'stripe value'), current = encryptSecret(key, context, 'stripe value');
    // The one-time rewrite: the same key, v1 to v2, bound to the row the value is in now.
    const rewritten = reencryptSecret(key, key, context, legacy)!;
    expect(openSecret(key, context, rewritten)).toEqual({ version: 'v2', plaintext: 'stripe value' });
    expect(() => decryptSecret(key, { ...context, owner: gymB }, rewritten)).toThrow(fail);
    expect(reencryptSecret(key, key, context, current)).toBeNull();
    // A rotation: v1 or v2 under the old key becomes v2 under the new one; a value already there is done.
    for (const value of [legacy, current]) {
      const rotated = reencryptSecret(key, otherKey, context, value)!;
      expect(openSecret(otherKey, context, rotated)).toEqual({ version: 'v2', plaintext: 'stripe value' });
      expect(reencryptSecret(key, otherKey, context, rotated)).toBeNull();
      expect(() => decryptSecret(key, context, rotated)).toThrow(fail);
    }
    // A v1 value under the new key is still rewritten as v2.
    expect(openSecret(otherKey, context, reencryptSecret(key, otherKey, context, legacySecret(otherKey, 'stripe_config', 'v'))!).version).toBe('v2');
    // Neither key: the fixed error. A value in another gym's row opens with neither.
    const wrong = parseEncryptionKey('33'.repeat(32));
    expect(() => reencryptSecret(wrong, otherKey, context, current)).toThrow(/^Unable to decrypt secret$/);
    expect(() => reencryptSecret(key, otherKey, { ...context, owner: gymB }, current)).toThrow(/^Unable to decrypt secret$/);
  });
  it('rejects malformed envelopes and owners without including input in errors', () => {
    const context = { secretClass: 'qr_key', owner: gymA } as const;
    const envelope = encryptSecret(key, context, '');
    expect(decryptSecret(key, context, envelope)).toBe('');
    for (const value of ['secret-input', envelope.replace('v2.', 'v3.'), envelope + '.extra', envelope + '=', 'v2.AA.AA.AA', 'v1.AA.AA.AA']) {
      expect(() => decryptSecret(key, context, value)).toThrow(/^Unable to decrypt secret$/);
    }
    for (const owner of ['', 'gym-a', gymA + ' ', 'private-owner-input'])
      expect(() => decryptSecret(key, { ...context, owner }, envelope)).toThrow(/^Unable to decrypt secret$/);
    expect(() => encryptSecret(key, { ...context, owner: 'not-a-row-id' }, 'value')).toThrow(/^Invalid secret owner$/);
    expect(() => encryptSecret(key, { secretClass: 'unknown' as SecretClass, owner: gymA }, 'value')).toThrow('Unregistered');
    expect(() => encryptSecret(Buffer.alloc(16), context, 'value')).toThrow('Invalid encryption key');
  });
  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' ' + 'a'.repeat(64)])('rejects invalid key %s', (value) => {
    expect(() => parseEncryptionKey(value)).toThrow('APP_ENCRYPTION_KEY');
  });
});
