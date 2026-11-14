// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openSecret, parseEncryptionKey } from '../../apps/server/src/core/secrets.ts';

// Run through tsx: this intentionally uses the application's reader, not a second implementation of decryption.
const { key, secrets, row } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const expected of secrets) {
  const actual = openSecret(parseEncryptionKey(key), expected, row[expected.column]);
  assert.equal(actual.version, expected.storedVersion ?? expected.version);
  assert.equal(actual.plaintext, expected.plaintext);
}
console.log('PASS: stored settings opened with the production reader and retained their plaintext');
