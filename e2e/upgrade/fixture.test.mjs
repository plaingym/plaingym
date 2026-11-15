// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from './fixture.mjs';
import { gates, history } from './history.mjs';

for (const gate of gates) test(`${gate.gate} seeds legacy QR, SMTP and Stripe envelopes and a current envelope`, () => {
  const key = randomBytes(32);
  const seed = fixture(history(gate).tables, key.toString('hex'));
  assert.deepEqual(seed.secrets.map(({ column, version }) => [column, version]), [
    ['qr_key_encrypted', 'v1'], ['smtp_config_encrypted', 'v1'], ['stripe_config_encrypted', 'v1'], ['backup_blob_key_encrypted', 'v2'],
  ]);
  const gymInsert = seed.sql.split('\n').find(line => line.startsWith('INSERT INTO "gyms"'));
  for (const secret of seed.secrets) {
    assert.ok(gymInsert.includes(`"${secret.column}"`));
    // Locate by the independently authenticated plaintext, so a missing or misbound envelope fails.
    const opened = [...gymInsert.matchAll(/'(v[12]\.[^']+)'/g)].some(([, envelope]) => {
      try {
        const [version, iv, ciphertext, tag] = envelope.split('.');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(version === 'v1' ? secret.secretClass
          : JSON.stringify(['plaingym-secret-v2', secret.secretClass, 'gyms', secret.column, secret.owner])));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return version === secret.version && Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString() === secret.plaintext;
      } catch { return false; }
    });
    assert.ok(opened, `${secret.column} is inserted with its historical binding`);
  }
  const smtp = JSON.parse(seed.secrets.find(secret => secret.secretClass === 'smtp_config').plaintext);
  assert.equal(smtp.host, 'smtp.example.test');
  assert.equal(smtp.port, 587);
  assert.equal(smtp.security, 'starttls');
  assert.equal(smtp.from, 'gym@example.test');
  assert.ok(smtp.username && smtp.password);
  const stripe = JSON.parse(seed.secrets.find(secret => secret.secretClass === 'stripe_config').plaintext);
  assert.match(stripe.apiKey, /^rk_test_[a-z0-9]+$/);
  assert.equal(stripe.mode, 'test');
  assert.ok(stripe.endpointId && stripe.webhookSecret);
});
