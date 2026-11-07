// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { encryptSecret, parseEncryptionKey } from '../../core/secrets.js';
import { createSmtpResolver, encryptSmtpConfig, smtpFromEnvironment } from './smtp.js';

const database = useTestDatabase(), factory = createFactories(database);
const key = parseEncryptionKey('ab'.repeat(32));
const own = { host: 'smtp.gym-a.example', port: 587, security: 'starttls', from: 'desk@gym-a.example', username: 'gym-a', password: 'gym-a-secret' } as const;
const env = { SMTP_HOST: 'smtp.install.example', SMTP_PORT: '2525', SMTP_FROM: 'noreply@install.example', SMTP_USER: 'install', SMTP_PASS: 'install-secret' };
const gymA = uuidv7(), gymB = uuidv7();
beforeAll(async () => {
  await factory('gyms', gymA, { smtpConfig: encryptSmtpConfig(key, gymA, own) });
  await factory('gyms', gymB);
});

describe('per-gym SMTP with an install-wide fallback', () => {
  it('uses the gym\'s own settings first', async () => {
    const smtp = createSmtpResolver({ key, env, scope: database.forGym });
    expect(await smtp.source(gymA)).toBe('gym');
    expect(await smtp.source(gymB)).toBe('install');
    expect(await smtp.config(gymA)).toEqual({ host: own.host, port: 587, security: 'starttls', from: own.from,
      auth: { user: 'gym-a', pass: 'gym-a-secret' } });
  });
  it('falls back to the install\'s SMTP_* settings, never another gym\'s', async () => {
    const smtp = createSmtpResolver({ key, env, scope: database.forGym });
    expect(await smtp.config(gymB)).toEqual({ host: 'smtp.install.example', port: 2525, security: 'starttls',
      from: 'noreply@install.example', auth: { user: 'install', pass: 'install-secret' } });
    expect(await smtp.configured(gymB)).toBe(true);
  });
  it('reports no email when neither the gym nor the install has SMTP', async () => {
    const smtp = createSmtpResolver({ key, env: {}, scope: database.forGym });
    expect(await smtp.source(gymB)).toBeNull();
    expect(await smtp.config(gymB)).toBeNull();
    expect(await smtp.configured(gymB)).toBe(false);
    expect(await smtp.configured(gymA)).toBe(true);
  });
  it('rejects stored settings encrypted with another key', async () => {
    const smtp = createSmtpResolver({ key: parseEncryptionKey('cd'.repeat(32)), env, scope: database.forGym });
    await expect(smtp.config(gymA)).rejects.toThrow();
  });
  it('reads a stored value a newer release added a key to, and still refuses an unknown key on a save', async () => {
    const gymId = uuidv7();
    await factory('gyms', gymId, { smtpConfig: encryptSecret(key, { secretClass: 'smtp_config', owner: gymId }, JSON.stringify({ ...own, newerKey: true })) });
    const smtp = createSmtpResolver({ key, env: {}, scope: database.forGym });
    expect(await smtp.config(gymId)).toEqual({ host: own.host, port: own.port, security: own.security, from: own.from, auth: { user: own.username, pass: own.password } });
    expect(() => encryptSmtpConfig(key, gymId, { ...own, newerKey: true } as typeof own)).toThrow();
  });
  it('validates the install settings', () => {
    expect(smtpFromEnvironment({})).toBeNull();
    expect(smtpFromEnvironment({ SMTP_HOST: 'mailpit', SMTP_PORT: '1025', SMTP_FROM: 'a@b.test', SMTP_SECURITY: 'plain' }))
      .toEqual({ host: 'mailpit', port: 1025, from: 'a@b.test', security: 'plain' });
    expect(() => smtpFromEnvironment({ SMTP_HOST: 'x', SMTP_SECURITY: 'ssl' })).toThrow('Invalid SMTP_SECURITY');
    expect(() => encryptSmtpConfig(key, gymA, { ...own, from: 'not-an-email' })).toThrow();
  });
});
