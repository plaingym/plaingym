// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailContract } from '../../core/registry-infra-contracts.js';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { uuidv7 } from '@plaingym/db';
import { SmtpEmail, smtpOptions, type SmtpConfig } from './index.js';
import { captureSmtp } from './test-smtp.js';

const database = useTestDatabase();
let capture: Awaited<ReturnType<typeof captureSmtp>>;
let email: SmtpEmail;
const message = { to: 'member@example.test', subject: 'Receipt', html: '<p>Your receipt</p>', text: 'Your receipt' };
beforeAll(async () => {
  capture = await captureSmtp();
  email = new SmtpEmail({ host: '127.0.0.1', port: capture.port, security: 'plain',
    from: 'Academy <owner@example.test>', replyTo: 'support@example.test' });
});
afterAll(async () => { email?.close(); await capture?.close(); });

emailContract('Nodemailer SMTP contract', async () => email);

describe('SMTP transport', () => {
  it('delivers both alternatives, configured sender and default reply-to over real SMTP', async () => {
    const before = capture.messages.length;
    const result = await email.sendEmail(message);
    expect(result).toMatchObject({ status: 'sent', messageId: expect.stringMatching(/@/) });
    expect(capture.messages).toHaveLength(before + 1);
    const mime = capture.messages.at(-1)!;
    expect(mime).toContain('From: Academy <owner@example.test>');
    expect(mime).toContain('Reply-To: support@example.test');
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain');
    expect(mime).toContain('Content-Type: text/html');
    expect(mime).toContain('<p>Your receipt</p>');
  });

  it('allows an individual reply-to override', async () => {
    await email.sendEmail({ ...message, replyTo: 'coach@example.test' });
    expect(capture.messages.at(-1)).toContain('Reply-To: coach@example.test');
    expect(capture.messages.at(-1)).not.toContain('support@example.test');
  });

  it('verifies without sending and supports an explicit setup test send', async () => {
    const before = capture.messages.length;
    await email.verifyConnection();
    expect(capture.messages).toHaveLength(before);
    expect(await email.verifyTestSend(message)).toMatchObject({ status: 'sent' });
    expect(capture.messages).toHaveLength(before + 1);
  });

  it('authenticates using configured credentials and rejects invalid credentials', async () => {
    const authenticated = await captureSmtp({ user: 'smtp-user', pass: 'test-password' });
    const config = { host: '127.0.0.1', port: authenticated.port, security: 'plain', from: 'owner@example.test' } as const;
    const good = new SmtpEmail({ ...config, auth: { user: 'smtp-user', pass: 'test-password' } });
    const bad = new SmtpEmail({ ...config, auth: { user: 'smtp-user', pass: 'wrong' } });
    try {
      await good.verifyConnection();
      await good.sendEmail(message);
      expect(authenticated.messages).toHaveLength(1);
      await expect(bad.verifyConnection()).rejects.toMatchObject({ code: 'EAUTH' });
      await expect(bad.sendEmail(message)).rejects.toMatchObject({ code: 'EAUTH' });
      expect(authenticated.messages).toHaveLength(1);
    } finally { good.close(); bad.close(); await authenticated.close(); }
  });

  it('requires STARTTLS by default and never downgrades to plaintext', async () => {
    const secured = new SmtpEmail({ host: '127.0.0.1', port: capture.port, from: 'owner@example.test' });
    const before = capture.messages.length;
    try { await expect(secured.sendEmail(message)).rejects.toMatchObject({ code: 'ETLS' }); }
    finally { secured.close(); }
    expect(capture.messages).toHaveLength(before);
  });

  it('selects implicit TLS and keeps certificate checks and I/O restrictions enabled', () => {
    const options = smtpOptions({ host: 'smtp.example.test', port: 465, security: 'tls', from: 'owner@example.test' });
    expect(options).toMatchObject({ secure: true, ignoreTLS: false, disableFileAccess: true,
      disableUrlAccess: true, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
  });

  it('propagates permanent and transient delivery failures without retrying', async () => {
    const before = capture.messages.length;
    capture.rejectRecipient(true);
    try { await expect(email.sendEmail(message)).rejects.toMatchObject({ responseCode: 550 }); }
    finally { capture.rejectRecipient(false); }
    capture.rejectData(true);
    try { await expect(email.sendEmail(message)).rejects.toMatchObject({ responseCode: 451 }); }
    finally { capture.rejectData(false); }
    expect(capture.messages).toHaveLength(before);
  });

  it('rejects send, verification and test sends inside a real scoped transaction before connecting', async () => {
    const before = capture.connections;
    await database.forGym(uuidv7(), async () => {
      await expect(email.sendEmail(message)).rejects.toThrow(/transaction/i);
      await expect(email.verifyConnection()).rejects.toThrow(/transaction/i);
      await expect(email.verifyTestSend(message)).rejects.toThrow(/transaction/i);
    });
    expect(capture.connections).toBe(before);
  });

  it('rejects malformed configuration and injected headers without connecting', async () => {
    const base: SmtpConfig = { host: '127.0.0.1', port: capture.port, from: 'owner@example.test', security: 'plain' };
    expect(() => new SmtpEmail({ ...base, port: 0 })).toThrow('port');
    expect(() => new SmtpEmail({ ...base, port: 65536 })).toThrow('port');
    expect(() => new SmtpEmail({ ...base, host: '' })).toThrow('host');
    expect(() => new SmtpEmail({ ...base, from: 'a@example.test\r\nBcc: b@example.test' })).toThrow('from');
    expect(() => new SmtpEmail({ ...base, auth: { user: 'user', pass: '' } })).toThrow('credentials');
    const before = capture.connections;
    for (const field of ['to', 'subject', 'replyTo'] as const)
      await expect(email.sendEmail({ ...message, [field]: 'value\r\nBcc: b@example.test' })).rejects.toThrow('Invalid email');
    expect(capture.connections).toBe(before);
  });
});
