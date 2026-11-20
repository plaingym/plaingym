// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { auditEvents, smsOutbox, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { createSmsResolver, encryptSmsConfig, readSmsConfig, storedSmsSchema, type StoredSmsConfig } from './sms.js';

const db = useTestDatabase(), make = createFactories(db), scope = db.forGym, key = randomBytes(32);
const clock = new TestClock('2026-11-16T10:00:00Z');
const config: StoredSmsConfig = { accountSid: 'AC' + '1'.repeat(32), auth: { token: 'test-token' }, sender: { from: '+12025550124' } };
const message = { to: '+12025550123', body: 'Test Gym: Private notice' };
it('resolves each gym independently and never uses another gym credentials', async () => {
  const a = uuidv7(), b = uuidv7(), unconfigured = uuidv7();
  await make('gyms', a, { smsConfig: encryptSmsConfig(key, a, config) });
  const other = { ...config, accountSid: 'AC' + '2'.repeat(32), auth: { token: 'other-token' } };
  await make('gyms', b, { smsConfig: encryptSmsConfig(key, b, other) }); await make('gyms', unconfigured);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sid: 'SM' + '3'.repeat(32) }, { status: 201 }));
  const resolver = createSmsResolver({ key, tenancy: 'multi', scope, fetch: fetcher });
  await (await resolver.resolve(a))!.sms.sendSms(message);
  expect(String(fetcher.mock.calls[0]![0])).toContain(config.accountSid);
  expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('Authorization')).toBe('Basic ' + Buffer.from(config.accountSid + ':test-token').toString('base64'));
  await (await resolver.resolve(b))!.sms.verifyAccount();
  expect(String(fetcher.mock.calls[1]![0])).toContain(other.accountSid);
  expect(await resolver.resolve(unconfigured)).toBeNull();
  expect(await resolver.status(a)).toEqual({ source: 'gym', unreadable: false });
});
it('fails closed for unreadable or transplanted secrets and reports them without secret content', async () => {
  const a = uuidv7(), b = uuidv7();
  await make('gyms', a, { smsConfig: 'broken-secret' });
  await make('gyms', b, { smsConfig: encryptSmsConfig(key, a, config) });
  const resolver = createSmsResolver({ key, tenancy: 'single', scope });
  const logs: string[] = [], previous = setLogSink(line => logs.push(line));
  try {
    for (const id of [a, b]) {
      expect(await resolver.resolve(id)).toBeNull();
      expect(await resolver.status(id)).toEqual({ source: null, unreadable: true });
    }
  } finally { setLogSink(previous); }
  expect(logs).toHaveLength(2);
  for (const secret of ['broken-secret', 'test-token', message.to, message.body]) expect(logs.join('\n')).not.toContain(secret);
});
it('reads every auth and sender variant the strict write schema declares', () => {
  const gymId = uuidv7(), accountSid = config.accountSid;
  const auths: StoredSmsConfig['auth'][] = [{ token: 'test-token' }, { apiKey: 'SK' + '2'.repeat(32), secret: 'test-secret' }];
  const senders: StoredSmsConfig['sender'][] = [{ from: '+12025550124' }, { messagingServiceSid: 'MG' + '3'.repeat(32) }];
  // The lists cover the same variants as the write schema; a new variant must extend both before this test can pass.
  expect(auths).toHaveLength(storedSmsSchema.shape.auth.options.length);
  expect(senders).toHaveLength(storedSmsSchema.shape.sender.options.length);
  for (const auth of auths) for (const sender of senders) {
    const value: StoredSmsConfig = { accountSid, auth, sender };
    expect(storedSmsSchema.safeParse(value).success).toBe(true);
    expect(readSmsConfig(key, 'single', gymId, encryptSmsConfig(key, gymId, value))).toEqual(value);
  }
});
it('allows custom HTTPS bases only in single mode', async () => {
  const gymId = uuidv7();
  await make('gyms', gymId, { smsConfig: encryptSmsConfig(key, gymId, { ...config, baseUrl: 'https://sms.example.test/proxy' }) });
  expect(await createSmsResolver({ key, tenancy: 'single', scope }).configured(gymId)).toBe(true);
  expect(await createSmsResolver({ key, tenancy: 'multi', scope }).configured(gymId)).toBe(false);
  for (const baseUrl of ['invalid', 'http://sms.example.test', 'https://user:pass@sms.example.test', 'https://sms.example.test/?key=secret'])
    expect(storedSmsSchema.safeParse({ ...config, baseUrl }).success).toBe(false);
});
it('demo ignores even an unreadable credential and captures one scoped outbox row and a content-free audit', async () => {
  const gymId = uuidv7(), other = uuidv7();
  await make('gyms', gymId, { smsConfig: 'broken-secret' }); await make('gyms', other);
  const fetcher = vi.fn<typeof fetch>();
  const resolver = createSmsResolver({ key, tenancy: 'multi', demo: true, clock, scope, fetch: fetcher });
  expect(await resolver.status(gymId)).toEqual({ source: 'demo', unreadable: false });
  const sms = (await resolver.resolve(gymId))!.sms;
  await sms.verifyAccount(); await sms.sendSms(message);
  expect(fetcher).not.toHaveBeenCalled();
  const captured = await scope(gymId, tx => tx.select().from(smsOutbox));
  expect(captured).toEqual([expect.objectContaining({ recipient: message.to, body: message.body, sentAt: clock.now() })]);
  expect(await scope(other, tx => tx.select().from(smsOutbox))).toEqual([]);
  const audits = await scope(gymId, tx => tx.select().from(auditEvents));
  expect(audits).toEqual([expect.objectContaining({ action: 'demo.sms_captured', targetId: captured[0]!.id, before: null, after: null })]);
  expect(JSON.stringify(audits)).not.toContain(message.to); expect(JSON.stringify(audits)).not.toContain(message.body);
});
it('rolls demo capture and audit back together, without exposing the failed query', async () => {
  const gymId = uuidv7(); await make('gyms', gymId);
  const resolver = createSmsResolver({ key, tenancy: 'multi', demo: true, clock, scope });
  const resolved = (await resolver.resolve(gymId))!;
  const { OutboxSms } = await import('../../infra/sms/outbox.js');
  const failing = new OutboxSms(gymId, clock, (id, fn) => scope(id, async tx => { await fn(tx); throw new Error(message.body); }));
  await expect(failing.sendSms(message)).rejects.toMatchObject({ acceptance: 'not_accepted', message: 'SMS could not be captured' });
  expect(await scope(gymId, tx => tx.select().from(smsOutbox))).toEqual([]);
  expect(await scope(gymId, tx => tx.select().from(auditEvents))).toEqual([]);
  await resolved.sms.sendSms(message);
  expect(await scope(gymId, tx => tx.select().from(smsOutbox))).toHaveLength(1);
});
