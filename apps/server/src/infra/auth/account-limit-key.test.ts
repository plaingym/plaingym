// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const secret = 'account-limit-key-test-secret-32-characters';
const fresh = async () => {
  vi.resetModules();
  return import('./account-limit-key.js');
};

describe('the sign-in account limit key', () => {
  beforeEach(() => { vi.resetModules(); });

  it('digests the normalized address with the secret, never as a plain hash', async () => {
    const { configureAccountLimitKey, accountDigest } = await fresh();
    configureAccountLimitKey(secret);
    const digest = accountDigest('member@example.test');
    expect(accountDigest('Member@Example.test ')).toBe(digest);
    expect(digest.startsWith('k1:')).toBe(true);
    expect(digest).not.toBe(createHash('sha256').update('member@example.test').digest('base64url'));
    expect(digest).not.toContain('member@example.test');
  });

  it('gives two secrets different digests, and two processes with one secret the same one', async () => {
    const first = await fresh();
    first.configureAccountLimitKey(secret);
    const digest = first.accountDigest('member@example.test');
    first.configureAccountLimitKey(`${secret}-other`);
    expect(first.accountDigest('member@example.test')).not.toBe(digest);
    const second = await fresh();
    expect(second).not.toBe(first);
    second.configureAccountLimitKey(secret);
    expect(second.accountDigest('member@example.test')).toBe(digest);
  });

  it('refuses to digest before it is configured', async () => {
    const { accountDigest } = await fresh();
    expect(() => accountDigest('member@example.test')).toThrow('Sign-in limit key is not configured');
  });

  it('is configured by authConfig once the secret passes its check, and not by a short secret', async () => {
    const { authConfig } = await import('./config.js');
    const { accountDigest } = await import('./account-limit-key.js');
    expect(() => authConfig({ AUTH_SECRET: 'too-short' }, false)).toThrow('AUTH_SECRET must contain at least 32 characters');
    expect(() => accountDigest('member@example.test')).toThrow('Sign-in limit key is not configured');
    authConfig({ AUTH_SECRET: 'a'.repeat(32) }, false);
    const configured = accountDigest('member@example.test');
    const reference = await fresh();
    reference.configureAccountLimitKey('a'.repeat(32));
    expect(configured).toBe(reference.accountDigest('member@example.test'));
  });
});
