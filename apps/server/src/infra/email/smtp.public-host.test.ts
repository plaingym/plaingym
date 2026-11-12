// SPDX-License-Identifier: AGPL-3.0-only
import net from 'node:net';
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
  describe('a host with several addresses', () => {
    // Nothing listens on these loopback addresses, so a connection to either is refused at once.
    const dead = '127.0.0.3', alsoDead = '127.0.0.4', v6 = '2001:db8::25';
    const several = { lookup, isPublic: (address: string) => [checked, dead, alsoDead, v6].includes(address), families: () => new Set([4] as const) };
    const connected = (connect: { mock: { calls: unknown[][] } }) => connect.mock.calls.map((call) => (call[0] as { host?: string }).host);
    it('connects to the next checked address when one refuses, within one lookup', async () => {
      lookup.mockResolvedValue([dead, checked]);
      const connect = vi.spyOn(net, 'connect'), before = good.messages.length;
      try {
        await using(new SmtpEmail(config(), { hostCheck: several }), async (email) => expect(await email.sendEmail(message)).toMatchObject({ status: 'sent' }));
        expect(connected(connect)).toEqual([dead, checked]);
      } finally { connect.mockRestore(); }
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(good.messages).toHaveLength(before + 1);
    });
    it('tries each checked address once and reports not sent when none answers', async () => {
      lookup.mockResolvedValue([dead, alsoDead]);
      const connect = vi.spyOn(net, 'connect');
      try {
        await using(new SmtpEmail(config(), { hostCheck: several }), async (email) => {
          await expect(email.sendEmail(message)).rejects.toMatchObject({ acceptance: 'not_accepted', message: 'SMTP connection failed' });
        });
        expect(connected(connect)).toEqual([dead, alsoDead]);
      } finally { connect.mockRestore(); }
    });
    it('skips a family the machine has no interface for', async () => {
      lookup.mockResolvedValue([v6, checked]);
      const connect = vi.spyOn(net, 'connect');
      try {
        await using(new SmtpEmail(config(), { hostCheck: several }), async (email) => expect(await email.sendEmail(message)).toMatchObject({ status: 'sent' }));
        expect(connected(connect)).toEqual([checked]);
      } finally { connect.mockRestore(); }
    });
    it('never moves on once the envelope is under way, so a message can\'t go out twice', async () => {
      lookup.mockResolvedValue([checked, dead]);
      const connect = vi.spyOn(net, 'connect');
      good.dropOn('MAIL');
      try {
        await using(new SmtpEmail(config(), { hostCheck: several }), async (email) => {
          await expect(email.sendEmail(message)).rejects.toMatchObject({ acceptance: 'unknown' });
        });
        expect(connected(connect)).toEqual([checked]);
      } finally { good.dropOn(undefined); connect.mockRestore(); }
    });
    it('stops trying further addresses once close() ends the session', async () => {
      lookup.mockResolvedValue([dead, checked]);
      const email = new SmtpEmail(config(), { hostCheck: several, sessionLimitMs: 2000 }), connections = good.connections;
      const connect = vi.spyOn(net, 'connect').mockImplementation(((...args: Parameters<typeof net.connect>) => {
        email.close();
        connect.mockRestore();
        return net.connect(...args);
      }) as typeof net.connect);
      try {
        await expect(email.sendEmail(message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
      } finally { connect.mockRestore(); email.close(); }
      expect(good.connections).toBe(connections);
    });
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
