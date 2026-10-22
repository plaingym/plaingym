// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { argon2Sync } from 'node:crypto';
import { authConfig } from './config.js';
import { createPasswordAdapter } from './password.js';

const secret = 'auth-test-secret-with-at-least-32-characters';
describe('authentication startup policy', () => {
  it('requires a secret and validates mode values', () => {
    expect(() => authConfig({})).toThrow('AUTH_SECRET');
    expect(() => authConfig({ AUTH_SECRET: secret, AUTH_PASSWORD_LOGIN: 'bad' })).toThrow('AUTH_PASSWORD_LOGIN');
    expect(() => authConfig({ AUTH_SECRET: secret, TENANCY: 'bad' })).toThrow('TENANCY');
  });
  it.each(['auto', 'on', 'off'])('enforces password mode %s with and without SMTP', (mode) => {
    expect(authConfig({ AUTH_SECRET: secret, AUTH_PASSWORD_LOGIN: mode }, false).passwordEnabled).toBe(mode !== 'off');
    expect(authConfig({ AUTH_SECRET: secret, AUTH_PASSWORD_LOGIN: mode }, true).passwordEnabled).toBe(mode === 'on');
  });
  it('requires password=off and SMTP for multiple gyms', () => {
    for (const mode of [undefined, 'auto', 'on']) expect(() => authConfig({ AUTH_SECRET: secret, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: mode }, true)).toThrow('AUTH_PASSWORD_LOGIN=off');
    expect(() => authConfig({ AUTH_SECRET: secret, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' }, false)).toThrow('requires SMTP');
    expect(authConfig({ AUTH_SECRET: secret, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' }, true).passwordEnabled).toBe(false);
  });
});
describe('Argon2id durable password adapter', () => {
  it('uses portable PHC encoding, random salts, NFKC, and rejects a wrong password', async () => {
    const adapter = createPasswordAdapter();
    const hash = await adapter.hash('passw\u212brd-password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await adapter.hash('passw\u212brd-password')).not.toBe(hash);
    expect(await adapter.verify({ hash, password: 'passw\u00c5rd-password' })).toBe(true);
    expect(await adapter.verify({ hash, password: 'incorrect password' })).toBe(false);
    const parts = hash.split('$');
    const independent = argon2Sync('argon2id', { message: 'passw\u00c5rd-password', nonce: Buffer.from(parts[4]!, 'base64'), memory: 19456, passes: 2, parallelism: 1, tagLength: 32 });
    expect(independent.equals(Buffer.from(parts[5]!, 'base64'))).toBe(true);
  });
  it('rejects malformed or unbounded-cost hashes before native work', async () => {
    const adapter = createPasswordAdapter();
    for (const hash of ['bad', '$argon2id$v=19$m=999999999,t=2,p=1$abcd$abcd', '$argon2i$v=19$m=19456,t=2,p=1$abcd$abcd']) expect(await adapter.verify({ hash, password: 'test' })).toBe(false);
    expect(adapter.active).toBe(0);
    await expect(adapter.hash('x'.repeat(4097))).rejects.toThrow('too long');
  });
  it('bounds native concurrency and pending queue, and benchmarks a login burst', async () => {
    const adapter = createPasswordAdapter(2, 8);
    const started = performance.now();
    const burst = Array.from({ length: 10 }, (_, i) => adapter.hash('benchmark-password-' + i));
    expect(adapter.active).toBe(2); expect(adapter.queued).toBe(8);
    await expect(adapter.hash('overflow-password')).rejects.toThrow('busy');
    const results = await Promise.all(burst);
    expect(new Set(results).size).toBe(10);
    expect(adapter.active).toBe(0); expect(adapter.queued).toBe(0);
    console.info(`Argon2id: 10 hashes, concurrency=2, ${Math.round(performance.now() - started)} ms, RSS=${Math.round(process.memoryUsage().rss / 1024 / 1024)} MiB`);
  });
});
