// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { emailServiceFailure, smtpTestFailure } from './failure.js';
import { DeliveryError } from './index.js';

const refused = (cause: unknown) => new DeliveryError('not_accepted', 'SMTP failed', { cause });

describe('the sending service\'s failures', () => {
  it('names a refused login, a failed connection, a failed secure connection and a refused sender', () => {
    expect(emailServiceFailure(refused({ code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' }))).toBe('authentication');
    expect(emailServiceFailure(refused({ code: 'ECONNECTION' }))).toBe('connection');
    expect(emailServiceFailure(refused({ code: 'ETLS' }))).toBe('tls');
    expect(emailServiceFailure(refused({ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 }))).toBe('sender_refused');
    // A host refused before connecting has no cause and is the service's connection.
    expect(emailServiceFailure(new DeliveryError('not_accepted', 'SMTP host refused'))).toBe('connection');
  });
  it('blames nothing for a refused recipient or body, an unknown outcome or another error', () => {
    expect(emailServiceFailure(refused({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }))).toBeNull();
    expect(emailServiceFailure(refused({ code: 'EMESSAGE', command: 'DATA', responseCode: 552 }))).toBeNull();
    expect(emailServiceFailure(new DeliveryError('unknown', 'SMTP delivery outcome is unknown', { cause: { code: 'ECONNECTION' } }))).toBeNull();
    expect(emailServiceFailure(new Error('SMTP failed'))).toBeNull();
    expect(emailServiceFailure({ code: 'EAUTH' })).toBeNull();
    expect(emailServiceFailure(undefined)).toBeNull();
  });
  it('reads the sender refusal from a nested cause, and survives a getter that throws', () => {
    expect(emailServiceFailure(refused({ cause: { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 553 } }))).toBe('sender_refused');
    const hostile = { code: 'EENVELOPE', get command(): string { throw new Error('getter'); } };
    expect(emailServiceFailure(refused(hostile))).toBeNull();
  });
  it('keeps the test-send classes, including a port 465 timeout with STARTTLS', () => {
    const timeout = refused({ code: 'ETIMEDOUT' });
    expect(emailServiceFailure(timeout, { port: 465, security: 'starttls' })).toBe('tls');
    expect(emailServiceFailure(timeout, { port: 587, security: 'starttls' })).toBe('connection');
    expect(smtpTestFailure({ code: 'EENVELOPE', responseCode: 550, response: '550 5.7.1 Relaying denied' })).toBe('authentication');
    expect(emailServiceFailure(refused({ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550, response: '550 5.7.1 Relaying denied' }))).toBe('authentication');
  });
});
