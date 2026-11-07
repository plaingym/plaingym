// SPDX-License-Identifier: AGPL-3.0-only
import tls from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpEmail } from './index.js';
import { captureSmtp } from './test-smtp.js';

const message = { to: 'member@example.test', subject: 'Receipt', html: '<p>Receipt</p>', text: 'Receipt' };
const checked = '127.0.0.2', rebound = '127.0.0.1', host = 'mail.gym.example';
let good: Awaited<ReturnType<typeof captureSmtp>>, bad: Awaited<ReturnType<typeof captureSmtp>>;
/** Each answer has its own capture server, so the one that sees a connection shows which address was used. */
const lookup = vi.fn<(name: string) => Promise<string[]>>();
const hostCheck = { lookup, isPublic: (address: string) => address === checked };
const config = () => ({ host, port: good.port, security: 'plain', from: 'desk@gym.example', publicHostOnly: true }) as const;
async function using<T>(email: SmtpEmail, run: (email: SmtpEmail) => Promise<T>) { try { return await run(email); } finally { email.close(); } }

beforeAll(async () => { good = await captureSmtp(undefined, checked); bad = await captureSmtp(); });
afterAll(async () => { await good?.close(); await bad?.close(); });
beforeEach(() => { lookup.mockReset(); });

describe('SmtpEmail with publicHostOnly', () => {
  it('connects to the checked address even when the name would answer differently a moment later', async () => {
    lookup.mockResolvedValueOnce([checked]).mockResolvedValue([rebound]);
    const before = good.messages.length, strays = bad.connections;
    // The name doesn't exist, so a second lookup by Nodemailer would fail the send outright.
    await using(new SmtpEmail(config(), { hostCheck }), async (email) => expect(await email.sendEmail(message)).toMatchObject({ status: 'sent' }));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(good.messages).toHaveLength(before + 1);
    expect(bad.connections).toBe(strays);
  });
  it('resolves and checks again for each session, so a later answer can’t reach a private address', async () => {
    lookup.mockResolvedValueOnce([checked]).mockResolvedValue([rebound]);
    const before = good.messages.length, strays = bad.connections;
    await using(new SmtpEmail(config(), { hostCheck }), async (email) => {
      await expect(email.verifyTestSend(message)).rejects.toMatchObject({ acceptance: 'not_accepted', message: 'SMTP host is not a public address' });
    });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(good.messages).toHaveLength(before);
    expect(bad.connections).toBe(strays);
  });
  it('reports a failed lookup as not sent, and keeps the host out of its message', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), { code: 'ENOTFOUND' }));
    await using(new SmtpEmail(config(), { hostCheck }), async (email) => {
      await expect(email.sendEmail(message)).rejects.toMatchObject({ acceptance: 'not_accepted', message: 'SMTP connection failed' });
    });
  });
  it('never connects after close() ends a session still resolving its host', async () => {
    let answer: (addresses: string[]) => void = () => {};
    lookup.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const email = new SmtpEmail(config(), { hostCheck }), connections = good.connections;
    const send = email.sendEmail(message), outcome = expect(send).rejects.toMatchObject({ acceptance: 'not_accepted' });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
    email.close();
    answer([checked]);
    await outcome;
    expect(good.connections).toBe(connections);
  });
  it('refuses an address given as the host with the real check', async () => {
    const strays = bad.connections;
    await using(new SmtpEmail({ ...config(), host: rebound, port: bad.port }), async (email) => {
      await expect(email.sendEmail(message)).rejects.toMatchObject({ acceptance: 'not_accepted', message: 'SMTP host is not a public address' });
    });
    expect(bad.connections).toBe(strays);
  });
  it('keeps the name as the TLS server name, with certificates still verified, while connecting to the address', async () => {
    lookup.mockResolvedValue([checked]);
    const connect = vi.spyOn(tls, 'connect');
    try {
      await using(new SmtpEmail({ ...config(), security: 'tls' }, { hostCheck }), async (email) => {
        await expect(email.verifyConnection()).rejects.toMatchObject({ acceptance: 'not_accepted' });
      });
      expect(connect.mock.calls[0]?.[0]).toMatchObject({ host: checked, servername: host, rejectUnauthorized: true });
    } finally { connect.mockRestore(); }
  });
  it('sets no server name for a host that is itself an address', async () => {
    lookup.mockResolvedValue([checked]);
    const connect = vi.spyOn(tls, 'connect');
    try {
      await using(new SmtpEmail({ ...config(), host: checked, security: 'tls' }, { hostCheck }), async (email) => {
        await expect(email.verifyConnection()).rejects.toMatchObject({ acceptance: 'not_accepted' });
      });
      expect(connect.mock.calls[0]?.[0]).toMatchObject({ host: checked });
      expect(connect.mock.calls[0]?.[0]).not.toHaveProperty('servername');
    } finally { connect.mockRestore(); }
  });
  it('leaves a server without the flag alone: no lookup, and a private address is fine', async () => {
    const before = bad.messages.length;
    await using(new SmtpEmail({ host: rebound, port: bad.port, security: 'plain', from: 'desk@gym.example' }, { hostCheck }), async (email) => {
      expect(await email.sendEmail(message)).toMatchObject({ status: 'sent' });
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(bad.messages).toHaveLength(before + 1);
  });
});
