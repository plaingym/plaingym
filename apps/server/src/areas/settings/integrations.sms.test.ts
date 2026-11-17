// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { integrationsResponseSchema, saveSmsIntegrationResponseSchema } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { setLogSink } from '../../core/log.js';
import { createServerRegistry } from '../../core/registry.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { authConfig } from '../../infra/auth/config.js';
import { FakeSms, MemberSms, SmsDeliveryError, TwilioSms, type Sms } from '../../infra/sms/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createIntegrationsService, type IntegrationsOptions } from './integrations.js';
import { createIntegrationsRoutes } from './integrations.routes.js';
import { createSmsResolver } from './sms.js';
import { createGymSettingsAccessor } from './settings.js';

const database = useTestDatabase(), factory = createFactories(database), key = Buffer.alloc(32, 19);
const clock = new TestClock('2026-11-16T04:00:00Z');
const accountSid = 'AC' + '1'.repeat(32), apiKey = 'SK' + '2'.repeat(32), messagingServiceSid = 'MG' + '3'.repeat(32);
const token = 'sms-token-never-returned', secret = 'sms-secret-never-returned';
const env = { TENANCY: 'single', AUTH_SECRET: 'sms-settings-auth-secret-with-32-characters' };
const verify = vi.fn(async () => { assertNoTransaction('SMS check'); });
const send = vi.fn<Sms['sendSms']>(async () => { assertNoTransaction('SMS test'); return { status: 'sent', messageId: 'sent' }; });
const smsFactory = vi.fn((): Sms => ({ verifyAccount: verify, sendSms: send }));
let gymId: string, userId: string, restoreLog: () => void;
let seen: string[];
beforeEach(async () => {
  vi.clearAllMocks(); verify.mockReset(); send.mockReset();
  verify.mockImplementation(async () => { assertNoTransaction('SMS check'); });
  send.mockImplementation(async () => { assertNoTransaction('SMS test'); return { status: 'sent', messageId: 'sent' }; });
  gymId = uuidv7(); await factory('gyms', gymId, { name: 'Test gym', address: { country: 'US' } });
  userId = (await factory('authUser', gymId)).id;
  seen = []; const previous = setLogSink(line => seen.push(line)); restoreLog = () => { setLogSink(previous); };
});
afterEach(async () => {
  seen.push(JSON.stringify(await database.forGym(gymId, tx => tx.select().from(auditEvents))));
  restoreLog();
  for (const credential of [token, secret]) expect(seen.join('\n')).not.toContain(credential);
});
const row = async (id = gymId) => (await database.forGym(id, tx => tx.select().from(gyms)))[0]!;
function service(overrides: Partial<IntegrationsOptions> = {}) {
  return createIntegrationsService({ key, env, config: authConfig(env, false), scope: database.forGym, clock,
    origin: async () => 'https://gym.invalid', hasPassword: async () => true, smsFactory, ...overrides });
}
function server(options: { role?: StaffRole; resolvedGym?: string; principalGym?: string; current?: ReturnType<typeof service> } = {}) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId: options.resolvedGym ?? gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId: options.principalGym ?? gymId, userId, roles: [options.role ?? 'owner'] }, clock, requestId: 'sms-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createIntegrationsRoutes(options.current ?? service()) }).mount(app, authorize, new Set());
  return app;
}
async function call(app: ReturnType<typeof server>, method = 'GET', body?: unknown, path = '/sms') {
  const response = await app.request('/api/settings/integrations' + path, { method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await response.text(); seen.push(text);
  return { status: response.status, body: JSON.parse(text) as unknown };
}
const input = (revision: number, overrides: Record<string, unknown> = {}) => ({ revision, provider: 'twilio', accountSid,
  auth: { token }, sender: { from: '+1 (415) 555-2671' }, testTo: '+1 (202) 555-0123', ...overrides });
const save = async (app = server(), overrides: Record<string, unknown> = {}) => call(app, 'PUT', input((await row()).revision, overrides));
function providerError() {
  const error = new SmsDeliveryError('not_accepted');
  error.message = token + secret;
  return error;
}

describe('SMS integration settings', () => {
  it.each(staffRoles)('allows only the owner to change the SMS daily cap: %s', async role => {
    const result = await call(server({ role }), 'PATCH', { revision: (await row()).revision, smsDailyCap: 12 }, '/sms/cap');
    expect(result.status).toBe(role === 'owner' ? 200 : 403);
    expect((await row()).smsDailyCap).toBe(role === 'owner' ? 12 : 1000);
    expect(send).not.toHaveBeenCalled();
  });
  it('validates cap bounds, checks the gym revision, and audits only the saved cap', async () => {
    const app = server(), revision = (await row()).revision;
    for (const smsDailyCap of [0, -1, 1.5, 100001, '12', null])
      expect((await call(app, 'PATCH', { revision, smsDailyCap }, '/sms/cap')).status).toBe(400);
    expect((await call(app, 'PATCH', { revision, smsDailyCap: 1 }, '/sms/cap')).status).toBe(200);
    expect((await call(app, 'PATCH', { revision, smsDailyCap: 10 }, '/sms/cap')).status).toBe(409);
    expect((await call(app, 'PATCH', { revision: revision + 1, smsDailyCap: 100000 }, '/sms/cap')).status).toBe(200);
    const audits = await database.forGym(gymId, tx => tx.select().from(auditEvents));
    expect(audits.map(audit => ({ action: audit.action, before: audit.before, after: audit.after }))).toEqual([
      { action: 'integrations.sms_daily_cap_updated', before: { smsDailyCap: 1000 }, after: { smsDailyCap: 1 } },
      { action: 'integrations.sms_daily_cap_updated', before: { smsDailyCap: 1 }, after: { smsDailyCap: 100000 } },
    ]);
  });
  it('keeps another gym cap isolated, ignores a query gym ID and refuses a mismatched principal', async () => {
    const other = uuidv7(); await factory('gyms', other, { smsDailyCap: 99 });
    const before = await row(other);
    expect((await call(server({ resolvedGym: other }), 'PATCH', { revision: before.revision, smsDailyCap: 5 }, '/sms/cap')).status).toBe(403);
    expect((await call(server(), 'PATCH', { revision: (await row()).revision, smsDailyCap: 5 }, '/sms/cap?gymId=' + other)).status).toBe(200);
    expect((await row(other)).smsDailyCap).toBe(99);
    expect((await row()).smsDailyCap).toBe(5);
  });
  it.each(staffRoles)('permits only integrations.manage for read, save and remove: %s', async role => {
    const app = server({ role }), allowed = role === 'owner';
    expect((await call(app, 'GET', undefined, '')).status).toBe(allowed ? 200 : 403);
    expect((await save(app)).status).toBe(allowed ? 200 : 403);
    expect((await call(app, 'DELETE', { revision: (await row()).revision })).status).toBe(allowed ? 200 : 403);
    expect(send).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
  it.each(['token', 'apiKey'])('checks then tests only the typed number, encrypts and returns no credential: %s', async authKind => {
    const app = server();
    const result = await save(app, { auth: authKind === 'token' ? { token } : { apiKey, secret }, sender: { messagingServiceSid } });
    expect(result.status).toBe(200);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(send).toHaveBeenCalledExactlyOnceWith({ to: '+12025550123', body: 'Test gym: PlainGym SMS test.' });
    const value = saveSmsIntegrationResponseSchema.parse(result.body).data;
    expect(value.test).toBe('sent');
    expect(value.integrations.sms).toMatchObject({ configured: true, provider: 'twilio', accountSid, authKind, messagingServiceSid });
    const gym = await row(); expect(gym.smsConfig).not.toContain(authKind === 'token' ? token : secret);
    expect(JSON.parse(decryptSecret(key, { secretClass: 'sms_config', owner: gymId }, gym.smsConfig!))).toMatchObject({
      auth: authKind === 'token' ? { token } : { apiKey, secret }, sender: { messagingServiceSid },
    });
    expect(integrationsResponseSchema.parse((await call(app, 'GET', undefined, '')).body).data.sms).toEqual(value.integrations.sms);
    const audits = await database.forGym(gymId, tx => tx.select().from(auditEvents));
    expect(audits.map(a => a.action).sort()).toEqual(['integrations.sms_saved', 'integrations.sms_tested']);
    expect(audits.find(a => a.action === 'integrations.sms_saved')?.after).toEqual({ accountSid, authKind, from: null, messagingServiceSid, revision: gym.revision });
    expect(JSON.stringify(audits)).not.toContain('+12025550123');
    expect((await call(app, 'DELETE', { revision: gym.revision })).status).toBe(200);
    expect((await row()).smsConfig).toBeNull();
    const removed = (await database.forGym(gymId, tx => tx.select().from(auditEvents))).find(a => a.action === 'integrations.sms_removed');
    expect(removed).toMatchObject({ before: { accountSid, authKind, from: null, messagingServiceSid },
      after: { accountSid: null, authKind: null, from: null, messagingServiceSid: null, revision: gym.revision + 1 } });
  });
  it.each(['account', 'send', 'suppressed'])('stores nothing after a failed %s and strips provider errors', async failure => {
    if (failure === 'account') verify.mockRejectedValueOnce(providerError());
    else if (failure === 'send') send.mockRejectedValueOnce(providerError());
    else send.mockResolvedValueOnce({ status: 'suppressed', reason: 'disabled' });
    const before = await row(), result = await save();
    expect(result.status).toBe(200);
    expect(saveSmsIntegrationResponseSchema.parse(result.body).data).toMatchObject({ test: 'failed', integrations: { revision: before.revision } });
    expect((await row()).smsConfig).toBeNull();
    if (failure === 'account') expect(send).not.toHaveBeenCalled();
    const logs = seen.filter(line => line.includes('settings.sms_test_failed')).map(line => JSON.parse(line));
    expect(logs).toEqual([expect.objectContaining({ errorName: failure === 'suppressed' ? 'SmsSuppressed' : 'DeliveryError',
      providerStatus: failure === 'suppressed' ? 'suppressed' : 'not_accepted' })]);
    expect(Object.keys(logs[0]).sort()).toEqual(['time', 'level', 'event', 'errorName', 'providerStatus'].sort());
  });
  it('fails the test, not the request, when the adapter refuses the message itself', async () => {
    await database.forGym(gymId, tx => tx.update(gyms).set({ name: 'G'.repeat(1600) }));
    const result = await save(server({ current: service({ smsFactory: () => new FakeSms() }) }));
    expect(result.status).toBe(200);
    expect(saveSmsIntegrationResponseSchema.parse(result.body).data.test).toBe('failed');
    expect((await row()).smsConfig).toBeNull();
    expect(seen.filter(line => line.includes('settings.sms_test_failed')).map(line => JSON.parse(line)))
      .toEqual([expect.objectContaining({ errorName: 'DeliveryError', providerStatus: 'not_accepted' })]);
  });
  it('keeps the previous credentials when their replacement fails', async () => {
    await save(); const before = await row();
    send.mockRejectedValueOnce(providerError());
    await save(server(), { auth: { apiKey, secret } });
    expect((await row()).smsConfig).toBe(before.smsConfig);
    expect((await row()).revision).toBe(before.revision);
  });
  it('rejects stale revisions before checking and checks again after the test', async () => {
    const app = server();
    await database.forGym(gymId, tx => tx.update(gyms).set({ revision: 2 }));
    expect((await call(app, 'PUT', input(1))).status).toBe(409);
    expect(smsFactory).not.toHaveBeenCalled();
    send.mockImplementationOnce(async () => {
      await database.forGym(gymId, tx => tx.update(gyms).set({ revision: 3 }));
      return { status: 'sent', messageId: 'sent' };
    });
    expect((await save(app)).status).toBe(409); expect((await row()).smsConfig).toBeNull();
    const audits = await database.forGym(gymId, tx => tx.select().from(auditEvents));
    expect(audits.map(a => [a.action, a.after])).toEqual([['integrations.sms_tested', { test: 'sent' }]]);
    expect((await call(app, 'DELETE', { revision: 2 })).status).toBe(409);
  });
  it.each(['account', 'send'])('propagates programming errors in the %s path as 500 without saving', async failure => {
    (failure === 'account' ? verify : send).mockRejectedValueOnce(new TypeError(token + secret));
    const before = await row(), result = await save();
    expect(result.status).toBe(500);
    expect((await row()).revision).toBe(before.revision);
    expect((await row()).smsConfig).toBeNull();
    expect(seen.filter(line => line.includes('settings.sms_test_failed'))).toEqual([]);
    expect(await database.forGym(gymId, tx => tx.select().from(auditEvents))).toEqual([]);
  });
  it.each([['token', 'from'], ['apiKey', 'from'], ['token', 'service'], ['apiKey', 'service']])('settings and member sending read newer nested %s / %s fields consistently', async (authKind, senderKind) => {
    const sender = senderKind === 'from' ? { from: '+14155552671' } : { messagingServiceSid };
    const stored = { ...input(1), auth: { ...(authKind === 'token' ? { token } : { apiKey, secret }), futureAuth: true },
      sender: { ...sender, futureSender: true }, futureConfig: true };
    // Bypass strict new-write validation to model a config stored by a newer release.
    await database.forGym(gymId, tx => tx.update(gyms).set({ memberSmsEnabled: true, smsConfig: encryptSecret(key,
      { secretClass: 'sms_config', owner: gymId }, JSON.stringify(stored)) }));
    const app = server();
    expect(integrationsResponseSchema.parse((await call(app, 'GET', undefined, '')).body).data.sms)
      .toMatchObject({ configured: true, unreadable: false, accountSid, authKind, ...sender });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sid: 'SM' + '4'.repeat(32) }));
    const resolver = createSmsResolver({ key, tenancy: 'single', scope: database.forGym, fetch: fetcher });
    expect(await resolver.status(gymId)).toEqual({ source: 'gym', unreadable: false });
    const member = await factory('members', gymId, { phone: '+12025550123', phoneE164: '+12025550123',
      smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
    const sms = new MemberSms({ gymId, memberIds: [member.id], householdIds: [], kind: 'notices', resolver,
      settings: createGymSettingsAccessor({ scope: database.forGym }), scope: database.forGym, clock, logSuppression: () => undefined });
    expect(await sms.sendSms({ to: '+12025550123', body: 'Test' })).toMatchObject({ status: 'sent' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('refuses to remove SMS settings that were never saved, without a revision change or audit', async () => {
    const before = await row();
    const result = await call(server(), 'DELETE', { revision: before.revision });
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain('not_configured');
    expect((await row()).revision).toBe(before.revision);
    expect(await database.forGym(gymId, tx => tx.select().from(auditEvents))).toEqual([]);
  });
  it('leaves the member-text switch on when the provider is removed', async () => {
    await save();
    await database.forGym(gymId, tx => tx.update(gyms).set({ memberSmsEnabled: true }));
    expect((await call(server(), 'DELETE', { revision: (await row()).revision })).status).toBe(200);
    expect(await row()).toMatchObject({ memberSmsEnabled: true, smsConfig: null });
  });
  it('isolates reads and mutations between gyms and refuses a mismatched principal', async () => {
    const other = uuidv7(); await factory('gyms', other, { name: 'Other gym' });
    await save(); const before = await row();
    const foreign = server({ resolvedGym: gymId, principalGym: other });
    expect((await call(foreign, 'GET', undefined, '')).status).toBe(403);
    expect((await save(foreign)).status).toBe(403);
    expect((await call(foreign, 'DELETE', { revision: before.revision })).status).toBe(403);
    const otherApp = server({ resolvedGym: other, principalGym: other });
    expect(integrationsResponseSchema.parse((await call(otherApp, 'GET', undefined, '')).body).data.sms.configured).toBe(false);
    expect((await call(otherApp, 'DELETE', { revision: (await row(other)).revision })).status).toBe(409);
    expect((await row()).smsConfig).toBe(before.smsConfig);
  });
  it('refuses custom URLs in multi mode before network calls, accepts HTTPS in single mode', async () => {
    const multiEnv = { ...env, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off', GYM_INTEGRATIONS: 'gym' };
    const app = server({ current: service({ env: multiEnv, config: authConfig(multiEnv, true) }) });
    expect((await save(app, { baseUrl: 'https://gym.signalwire.com' })).status).toBe(400);
    expect(smsFactory).not.toHaveBeenCalled();
    expect((await save(app, { baseUrl: 'https://api.twilio.com/' })).status).toBe(200);
    expect(integrationsResponseSchema.parse((await call(app, 'GET', undefined, '')).body).data.sms).not.toHaveProperty('baseUrl');
    expect((await save(server(), { baseUrl: 'https://gym.signalwire.com' })).status).toBe(200);
    expect(smsFactory).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: 'https://gym.signalwire.com', sender: { from: '+14155552671' } }));
  });
  it.each(['http://provider.invalid', 'https://user:password@provider.invalid', 'not a URL', 'https://api.twilio.com/?secret=x'])('refuses unsafe base URL %s', async baseUrl => {
    expect((await save(server(), { baseUrl })).status).toBe(400); expect(smsFactory).not.toHaveBeenCalled();
  });
  it.each(['invalid', '+12025550123 ext 1'])('refuses an invalid test number %s before network calls', async testTo => {
    expect((await save(server(), { testTo })).status).toBe(400); expect(smsFactory).not.toHaveBeenCalled();
  });
  it('refuses sandbox and operator-managed saves and removes before touching the provider', async () => {
    const multiEnv = { ...env, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' };
    for (const current of [service({ sandbox: true }), service({ env: multiEnv, config: authConfig(multiEnv, true) })]) {
      const app = server({ current });
      expect((await save(app)).status).toBe(403);
      expect((await call(app, 'DELETE', { revision: (await row()).revision })).status).toBe(403);
    }
    expect(smsFactory).not.toHaveBeenCalled();
  });
  it.each(['sandbox', 'operator'])('allows a daily cap edit in a %s without touching credentials', async mode => {
    const multiEnv = { ...env, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' };
    const current = mode === 'sandbox' ? service({ sandbox: true }) : service({ env: multiEnv, config: authConfig(multiEnv, true) });
    expect((await call(server({ current }), 'PATCH', { revision: (await row()).revision, smsDailyCap: 9 }, '/sms/cap')).status).toBe(200);
    expect((await row()).smsDailyCap).toBe(9);
    expect(smsFactory).not.toHaveBeenCalled();
  });
  it('reports unreadable credentials without exposing them and lets the owner remove them', async () => {
    await database.forGym(gymId, tx => tx.update(gyms).set({ smsConfig: token + secret }));
    const app = server();
    expect(integrationsResponseSchema.parse((await call(app, 'GET', undefined, '')).body).data.sms).toMatchObject({ configured: false, unreadable: true, accountSid: null });
    expect((await call(app, 'DELETE', { revision: (await row()).revision })).status).toBe(200);
  });
  it('uses the raw Twilio adapter outside transactions, with GET verification and one typed POST recipient', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { sid: 'SM' + '4'.repeat(32) } : {})));
    const app = server({ current: service({ smsFactory: config => new TwilioSms(config, fetcher) }) });
    expect((await save(app)).status).toBe(200);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST']);
    expect(new URLSearchParams(fetcher.mock.calls[1]![1]?.body as URLSearchParams).get('To')).toBe('+12025550123');
  });
  it('returns validation errors without submitted secrets', async () => {
    expect((await save(server(), { auth: { token, secret } })).status).toBe(400);
    expect(smsFactory).not.toHaveBeenCalled();
  });
});
