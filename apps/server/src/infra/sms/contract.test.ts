// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInTransaction } from '@plaingym/shared/transaction';
import { FakeSms, SmsDeliveryError, TwilioSms, smsDeadlineMs, type Sms, type TwilioConfig } from './index.js';

const config: TwilioConfig = { accountSid: 'AC' + '1'.repeat(32), auth: { token: 'test-token' }, sender: { from: '+12025550124' } };
const message = { to: '+12025550123', body: 'Gym: Private notice' }, messageId = 'SM' + '2'.repeat(32);
const basicCredential = 'Basic ' + Buffer.from(`${config.accountSid}:test-token`).toString('base64');
const cases = [
  { name: '201', status: 201, acceptance: null }, { name: '400', status: 400, acceptance: 'not_accepted' },
  { name: '21610', status: 400, code: 21610, acceptance: 'not_accepted' }, { name: '401', status: 401, acceptance: 'not_accepted' },
  { name: '429', status: 429, acceptance: 'not_accepted' }, { name: '500', status: 500, acceptance: 'unknown' },
  { name: 'timeout', status: 0, acceptance: 'unknown' }, { name: 'refused connection', status: 0, acceptance: 'not_accepted' },
] as const;
type Scenario = typeof cases[number];
function contract(name: string, make: (scenario: Scenario) => Sms) {
  describe(name, () => {
    afterEach(() => vi.useRealTimers());
    it.each(cases)('classifies $name and exposes no provider details', async scenario => {
      vi.useFakeTimers();
      const sms = make(scenario), result = sms.sendSms(message).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(smsDeadlineMs + 1);
      const value = await result;
      if (!scenario.acceptance) expect(value).toEqual({ status: 'sent', messageId });
      else {
        expect(value).toMatchObject({ acceptance: scenario.acceptance });
        if (scenario.name === '21610') expect(value).toMatchObject({ reason: 'recipient_opted_out' });
        const rendered = JSON.stringify(value) + String(value);
        for (const secret of [message.to, message.body, 'test-token', 'sensitive reply']) expect(rendered).not.toContain(secret);
        expect(value).not.toHaveProperty('cause');
      }
    });
    it('rejects sends and verification inside a transaction', async () => {
      const sms = make(cases[0]);
      await runInTransaction(async () => {
        await expect(sms.sendSms(message)).rejects.toThrow(/transaction/);
        await expect(sms.verifyAccount()).rejects.toThrow(/transaction/);
      });
    });
  });
}
contract('FakeSms contract', scenario => {
  const fake = new FakeSms();
  fake.respondNext(scenario.acceptance ? new SmsDeliveryError(scenario.acceptance, scenario.name === '21610' ? 'recipient_opted_out' : 'provider_error')
    : { status: 'sent', messageId });
  return fake;
});
contract('Twilio recorded-response contract', scenario => new TwilioSms(config, async () => {
  if (scenario.name === 'timeout') return new Promise<Response>(() => {});
  if (scenario.name === 'refused connection') throw new TypeError('sensitive reply', { cause: Object.assign(new Error(message.to), { code: 'ECONNREFUSED' }) });
  return Response.json({ sid: messageId, code: 'code' in scenario ? scenario.code : 20003, message: 'sensitive reply ' + message.to }, { status: scenario.status });
}));

it.each([
  config,
  { ...config, auth: { apiKey: 'SK' + '3'.repeat(32), secret: 'test-secret' }, sender: { messagingServiceSid: 'MG' + '4'.repeat(32) } },
])('uses form encoding, Basic auth and a credential-only verification GET', async providerConfig => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sid: messageId }, { status: 201 }));
  const sms = new TwilioSms(providerConfig, fetcher);
  await sms.sendSms(message); await sms.verifyAccount();
  const [url, request] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`);
  expect(request).toMatchObject({ method: 'POST', redirect: 'manual' });
  const form = new URLSearchParams(request!.body as URLSearchParams);
  expect(form.get('To')).toBe(message.to); expect(form.get('Body')).toBe(message.body);
  const auth = providerConfig.auth;
  expect(new Headers(request!.headers).get('Authorization')).toBe('Basic ' + Buffer.from('token' in auth ? `${config.accountSid}:${auth.token}` : `${auth.apiKey}:${auth.secret}`).toString('base64'));
  if ('from' in providerConfig.sender) { expect(form.get('From')).toBe(providerConfig.sender.from); expect(form.has('MessagingServiceSid')).toBe(false); }
  else { expect(form.get('MessagingServiceSid')).toBe(providerConfig.sender.messagingServiceSid); expect(form.has('From')).toBe(false); }
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'GET' });
  expect(String(fetcher.mock.calls[1]![0])).toBe(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json?PageSize=1`);
  expect(fetcher.mock.calls[1]![1]).not.toHaveProperty('body');
});

it.each(['ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ECONNRESET'])('classifies network code %s without retaining its cause', async code => {
  const sms = new TwilioSms(config, async () => { throw new Error(message.to, { cause: { code } }); });
  await expect(sms.sendSms(message)).rejects.toMatchObject({ acceptance: code === 'ECONNRESET' ? 'unknown' : 'not_accepted' });
});
// The stored-config schema refuses these too; the adapter checks the base and account SID itself, since they decide where credentials go.
it.each([
  ['a plain HTTP base', { baseUrl: 'http://provider.invalid' }],
  ['a base with credentials', { baseUrl: 'https://user:password@provider.invalid' }],
  ['a base with a query', { baseUrl: 'https://provider.invalid/?to=elsewhere' }],
  ['a base with a fragment', { baseUrl: 'https://provider.invalid/#fragment' }],
  ['a base that is not a URL', { baseUrl: 'provider.invalid' }],
  ['an account SID that leaves its path', { accountSid: 'AC' + '1'.repeat(32) + '/../../elsewhere' }],
  ['a malformed account SID', { accountSid: 'AC123' }],
] as const)('refuses %s before any request, for sends and verification', async (_name, change) => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sid: messageId }, { status: 201 }));
  const sms = new TwilioSms({ ...config, ...change }, fetcher);
  await expect(sms.sendSms(message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  await expect(sms.verifyAccount()).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps a compatible provider path and sends credentials only to the configured host', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sid: messageId }, { status: 201 }));
  await new TwilioSms({ ...config, baseUrl: 'https://provider.invalid/api/laml/' }, fetcher).sendSms(message);
  expect(String(fetcher.mock.calls[0]![0])).toBe(`https://provider.invalid/api/laml/2010-04-01/Accounts/${config.accountSid}/Messages.json`);
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Authorization')).toBe(basicCredential);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([[302, 'unknown'], [401, 'not_accepted'], [500, 'unknown']] as const)(
  'verifies an account only on a 2xx answer, without following a redirect: %s', async (status, acceptance) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status, headers: status === 302 ? { Location: 'https://elsewhere.invalid/' } : {} }));
    const error = await new TwilioSms(config, fetcher).verifyAccount().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ acceptance });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    const rendered = JSON.stringify(error) + String(error);
    for (const secret of ['test-token', basicCredential.slice('Basic '.length)]) expect(rendered).not.toContain(secret);
  });
it('accepts the MM message SID Twilio returns for a message sent as MMS', async () => {
  const sid = 'MM' + '5'.repeat(32);
  const sms = new TwilioSms(config, async () => Response.json({ sid }, { status: 201 }));
  expect(await sms.sendSms(message)).toEqual({ status: 'sent', messageId: sid });
});
it('keeps malformed success and redirects uncertain, without following redirects', async () => {
  for (const status of [201, 302]) {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sid: message.to }, { status }));
    await expect(new TwilioSms(config, fetcher).sendSms(message)).rejects.toMatchObject({ acceptance: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it('bounds a stalled response body while preserving a known HTTP rejection', async () => {
  vi.useFakeTimers();
  try {
    for (const status of [201, 429]) {
      const sms = new TwilioSms(config, async () => new Response(new ReadableStream(), { status }));
      const result = sms.sendSms(message).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(smsDeadlineMs + 1);
      expect(await result).toMatchObject({ acceptance: status === 429 ? 'not_accepted' : 'unknown' });
    }
  } finally { vi.useRealTimers(); }
});
