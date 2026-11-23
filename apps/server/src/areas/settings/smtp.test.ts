// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { encryptSecret, parseEncryptionKey } from '../../core/secrets.js';
import { DeliveryError } from '../../infra/email/index.js';
import { createSmtpResolver, encryptSmtpConfig, sendSmtpTest, smtpFromEnvironment, smtpTestFailure } from './smtp.js';

const database = useTestDatabase(), factory = createFactories(database);
const key = parseEncryptionKey('ab'.repeat(32));
const own = { host: 'smtp.gym-a.example', port: 587, security: 'starttls', from: 'desk@gym-a.example', username: 'gym-a', password: 'gym-a-secret' } as const;
const env = { SMTP_HOST: 'smtp.install.example', SMTP_PORT: '2525', SMTP_FROM: 'noreply@install.example', SMTP_USER: 'install', SMTP_PASS: 'install-secret' };
const gymA = uuidv7(), gymB = uuidv7();
beforeAll(async () => {
  await factory('gyms', gymA, { smtpConfig: encryptSmtpConfig(key, gymA, own) });
  await factory('gyms', gymB);
});

describe('SMTP test failures', () => {
  it.each([
    [{ code: 'ESOCKET', originalCode: 'ERR_SSL_WRONG_VERSION_NUMBER' }, 'tls'],
    [{ code: 'ETLS', command: 'STARTTLS' }, 'tls'],
    [{ code: 'ESOCKET', originalCode: 'CERT_HAS_EXPIRED' }, 'tls'],
    [{ code: 'EAUTH', responseCode: 535 }, 'authentication'],
    [{ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 }, 'sender_refused'],
    [{ code: 'EENVELOPE', command: 'RCPT TO' }, 'sender_refused'],
    [{ code: 'EMESSAGE' }, 'sender_refused'],
    [{ code: 'EREQUIRETLS' }, 'sender_refused'],
    [{ code: 'ECONNECTION', originalCode: 'ECONNREFUSED' }, 'connection'],
    [{ code: 'EDNS' }, 'connection'],
    [{ code: 'EPROTOCOL' }, 'connection'],
  ] as const)('classifies transport error %o as %s', (cause, expected) => {
    expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed', { cause }))).toBe(expected);
  });
  it('falls back to connection for unclassified errors and non-objects', () => {
    expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed'))).toBe('connection');
    expect(smtpTestFailure('x')).toBe('connection');
  });
  it('prioritizes TLS, then authentication, and reads at most four objects', () => {
    const authentication = { code: 'EENVELOPE', cause: { originalCode: 'EAUTH' } };
    const tls = { cause: { cause: { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } } } };
    expect(smtpTestFailure(authentication)).toBe('authentication');
    expect(smtpTestFailure({ ...tls, code: 'EAUTH' })).toBe('tls');
    expect(smtpTestFailure({ code: 'EAUTH', cause: tls })).toBe('authentication');
  });
  it.each([
    [{ code: 'ETIMEDOUT', command: 'CONN' }, { port: 465, security: 'starttls' }, 'tls'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, { port: 587, security: 'starttls' }, 'connection'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, { port: 465, security: 'tls' }, 'connection'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, undefined, 'connection'],
    [{ code: 'ECONNECTION', originalCode: 'ECONNREFUSED' }, { port: 465, security: 'starttls' }, 'tls'],
  ] as const)('classifies a timeout %o on %o as %s', (cause, settings, expected) => {
    expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed', { cause }), settings)).toBe(expected);
  });
  it.each([
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 530 }, 'authentication'],
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.7.1 Relaying denied' }, 'authentication'],
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 554, response: '554 5.7.0 Not allowed' }, 'authentication'],
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.1.1 No such user' }, 'sender_refused'],
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: 'Relaying 5.7.1 denied' }, 'sender_refused'],
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550-5.7.1 Relaying denied' }, 'authentication'],
  ] as const)('classifies a refused envelope %o as %s', (cause, expected) => {
    expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed', { cause }))).toBe(expected);
  });
  it.each(['UNABLE_TO_GET_ISSUER_CERT', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE',
    'CERT_CHAIN_TOO_LONG', 'EPROTO'].flatMap((code) => [[{ code }, 'tls'] as const, [{ originalCode: code }, 'tls'] as const]))(
    'classifies certificate error %o as tls', (cause, expected) => {
      expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed', { cause }))).toBe(expected);
    });
  it('classifies a server that offers no STARTTLS as tls even with a response code', () => {
    expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed', { cause: { code: 'ETLS', command: 'STARTTLS', responseCode: 502 } }))).toBe('tls');
  });
  it('classifies by code when the response getter throws', () => {
    const tls = { code: 'ETLS', get response() { throw new Error('reply contained a secret'); } };
    expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed', { cause: tls }))).toBe('tls');
    const authentication = { code: 'EENVELOPE', responseCode: 530, get response() { throw new Error('reply contained a secret'); } };
    expect(smtpTestFailure(new DeliveryError('unknown', 'SMTP failed', { cause: authentication }))).toBe('authentication');
  });
  it('uses the stored port and security for a timeout during the test send', async () => {
    const message = { to: 'test@example.test', subject: 'Test', text: 'Test', html: '<p>Test</p>' };
    await expect(sendSmtpTest({ ...own, port: 465 }, message, async () => {
      throw new DeliveryError('unknown', 'SMTP failed', { cause: { code: 'ETIMEDOUT', command: 'CONN' } });
    })).resolves.toBe('tls');
  });
  it('returns null on acceptance and returns a safe class on failure', async () => {
    const message = { to: 'test@example.test', subject: 'Test', text: 'Test', html: '<p>Test</p>' };
    await expect(sendSmtpTest(own, message, async () => {})).resolves.toBeNull();
    await expect(sendSmtpTest(own, message, async () => {
      throw new DeliveryError('not_accepted', 'SMTP failed', { cause: { code: 'EAUTH', response: '535 Authentication rejected' } });
    })).resolves.toBe('authentication');
  });
});

describe('per-gym SMTP with an install-wide fallback', () => {
  it('uses the gym\'s own settings first', async () => {
    const smtp = createSmtpResolver({ key, env, scope: database.forGym });
    expect(await smtp.status(gymA)).toEqual({ source: 'gym', unreadable: false });
    expect(await smtp.status(gymB)).toEqual({ source: 'install', unreadable: false });
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
    expect(await smtp.status(gymB)).toEqual({ source: null, unreadable: false });
    expect(await smtp.config(gymB)).toBeNull();
    expect(await smtp.configured(gymB)).toBe(false);
    expect(await smtp.configured(gymA)).toBe(true);
  });
  it('treats unreadable stored settings as unconfigured and uses only the install fallback', async () => {
    const smtp = createSmtpResolver({ key: parseEncryptionKey('cd'.repeat(32)), env, scope: database.forGym });
    expect(await smtp.status(gymA)).toEqual({ source: 'install', unreadable: true });
    expect(await smtp.config(gymA)).toMatchObject({ host: env.SMTP_HOST });
    const absent = createSmtpResolver({ key: parseEncryptionKey('cd'.repeat(32)), env: {}, scope: database.forGym });
    expect(await absent.configured(gymA)).toBe(false);
    expect(await absent.config(gymA)).toBeNull();
    expect(await absent.status(gymA)).toEqual({ source: null, unreadable: true });
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
