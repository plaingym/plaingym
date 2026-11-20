// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, smsDailyUsage, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { updateGoLiveRequestSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { FakeSms, MemberSms } from '../../infra/sms/index.js';
import { createSmsResolver, encryptSmsConfig } from './sms.js';
import { createGoLiveService, type GoLiveService } from './go-live.js';
import { createGymSettingsAccessor } from './settings.js';

const db = useTestDatabase(), factory = createFactories(db), key = Buffer.alloc(32, 12);
async function fixture(demo = false) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T04:00:00Z');
  await factory('gyms', gymId, { name: 'Sample gym', address: { country: 'US' }, smsDailyCap: 1 });
  const person = await factory('members', gymId, { phone: '+12025550110', phoneE164: '+12025550110',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const resolver = createSmsResolver({ key, tenancy: 'single', scope: db.forGym, demo, clock });
  const configured = vi.fn(async (id: string) => { assertNoTransaction('SMS configured'); return resolver.configured(id); });
  const smsStatus = vi.fn(async (id: string) => { assertNoTransaction('SMS status'); return resolver.status(id); });
  const options = { scope: db.forGym, clock, smtpConfigured: async () => false };
  const service = createGoLiveService({ ...options, smsStatus });
  const settings = createGymSettingsAccessor({ scope: db.forGym }), context = { gymId, actor: { kind: 'system' as const } };
  const toggle = async (memberSmsEnabled: boolean) => service.update(context, { revision: (await settings.get(gymId)).revision, memberSmsEnabled });
  return { gymId, clock, person, resolver, service, settings, context, toggle, configured, smsStatus, options };
}
const smsItem = (checklist: Awaited<ReturnType<GoLiveService['checklist']>>) =>
  checklist.items.find(item => item.id === 'sms_ready');
const unreadable = { status: 'needs_attention', message: 'The saved SMS settings could not be read. Replace or remove them in Settings.' };

describe('member SMS go-live', () => {
  it('enables a saved readable provider without sending a test or a member text', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ smsConfig: encryptSmsConfig(key, f.gymId, {
      accountSid: 'AC' + '1'.repeat(32), auth: { token: 'local-test-token' }, sender: { from: '+12025550111' },
    }) }).where(eq(gyms.id, f.gymId)));
    const before = await f.service.checklist(f.gymId);
    expect(before.memberSmsEnabled).toBe(false);
    expect(smsItem(before)?.status).toBe('ready');
    expect(await f.toggle(true)).toMatchObject({ memberSmsEnabled: true });
    expect(await db.forGym(f.gymId, tx => tx.select().from(smsDailyUsage))).toEqual([]);
  });
  it('refuses absent or unreadable status even when the fallback reports a provider', async () => {
    const f = await fixture();
    f.configured.mockResolvedValue(true);
    const service = createGoLiveService({ ...f.options, smsStatus: f.smsStatus, smsConfigured: f.configured });
    const before = await service.checklist(f.gymId);
    expect(smsItem(before)).toMatchObject({
      status: 'not_applicable', message: 'Member texts are off and no SMS provider is configured.',
    });
    const enable = () => service.update(f.context, { revision: before.revision, memberSmsEnabled: true });
    await expect(enable()).rejects.toMatchObject({ code: 'conflict', details: { memberSmsEnabled: ['no_provider'] } });
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: true }).where(eq(gyms.id, f.gymId)));
    expect(smsItem(await service.checklist(f.gymId))).toMatchObject({
      status: 'needs_attention', message: 'Member texts cannot be sent. Save a working SMS provider or turn member texts off.',
    });
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ smsConfig: 'unreadable', memberSmsEnabled: false }).where(eq(gyms.id, f.gymId)));
    f.smsStatus.mockResolvedValueOnce({ source: 'gym', unreadable: true });
    await expect(enable()).rejects.toMatchObject({ code: 'conflict', details: { memberSmsEnabled: ['no_provider'] } });
    expect(smsItem(await service.checklist(f.gymId))).toMatchObject(unreadable);
    expect(f.configured).not.toHaveBeenCalled();
  });
  it.each(['status', 'fallback'] as const)('handles a failed %s read after checking the revision and still allows disabling', async reader => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ revision: 2 }).where(eq(gyms.id, f.gymId)));
    const error = new Error('internal provider error');
    f.smsStatus.mockRejectedValue(error);
    if (reader === 'fallback') f.configured.mockRejectedValue(error);
    else f.configured.mockResolvedValue(true);
    const options = { ...f.options, smsConfigured: f.configured };
    const service = createGoLiveService(reader === 'status' ? { ...options, smsStatus: f.smsStatus } : options);
    const check = reader === 'status'
      ? { status: 'needs_attention', message: 'SMS readiness could not be checked. Refresh the checklist to try again.' }
      : { status: 'not_applicable', message: 'Member texts are off and no SMS provider is configured.' };
    const before = await service.checklist(f.gymId);
    expect(before.memberSmsEnabled).toBe(false);
    expect(smsItem(before)).toMatchObject(check);
    await expect(service.update(f.context, { revision: before.revision, memberSmsEnabled: true })).rejects.toMatchObject({
      code: 'unavailable', message: 'The SMS provider could not be checked. Try turning member texts on again.',
    });
    await expect(service.update(f.context, { revision: before.revision - 1, memberSmsEnabled: true }))
      .rejects.toMatchObject({ name: 'RevisionConflictError' });
    expect(await f.settings.get(f.gymId)).toMatchObject({ memberSmsEnabled: false, revision: before.revision });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.updated')))).toEqual([]);
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: true }).where(eq(gyms.id, f.gymId)));
    const disabled = await service.update(f.context, { revision: before.revision, memberSmsEnabled: false });
    expect(disabled.memberSmsEnabled).toBe(false);
    expect(smsItem(disabled)).toMatchObject(check);
    if (reader === 'status') expect(f.configured).not.toHaveBeenCalled();
  });
  it('falls back to the configured boolean when no status reader is supplied', async () => {
    const f = await fixture();
    const withoutReader = createGoLiveService(f.options);
    const service = createGoLiveService({ ...f.options, smsConfigured: f.configured });
    const before = await service.checklist(f.gymId);
    expect(smsItem(before)?.status).toBe('not_applicable');
    const enable = { revision: before.revision, memberSmsEnabled: true };
    await expect(withoutReader.update(f.context, enable)).rejects.toMatchObject({ code: 'conflict', details: { memberSmsEnabled: ['no_provider'] } });
    await expect(service.update(f.context, enable)).rejects.toMatchObject({ code: 'conflict', details: { memberSmsEnabled: ['no_provider'] } });
    f.configured.mockResolvedValue(true);
    expect(smsItem(await service.checklist(f.gymId))?.status).toBe('ready');
    expect(await service.update(f.context, enable)).toMatchObject({ memberSmsEnabled: true });
  });
  it('keeps a missing switch out of other go-live changes', () => {
    expect(updateGoLiveRequestSchema.parse({ revision: 1, memberEmailsEnabled: true })).toEqual({ revision: 1, memberEmailsEnabled: true });
    expect(updateGoLiveRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
  });
  it('audits the independent switch, preserves it through other updates, and enforces it through MemberSms', async () => {
    const f = await fixture(true), provider = new FakeSms();
    const resolve = vi.fn(async () => ({ gymId: f.gymId, name: 'Sample gym', sms: provider }));
    const sms = new MemberSms({ gymId: f.gymId, memberIds: [f.person.id], householdIds: [], kind: 'notices',
      resolver: { ...f.resolver, resolve }, settings: f.settings, scope: db.forGym, clock: f.clock, logSuppression: () => undefined });
    const before = await f.service.checklist(f.gymId);
    expect(before.memberSmsEnabled).toBe(false);
    expect(smsItem(before)?.status).toBe('ready');
    expect(await sms.sendSms({ to: '+12025550110', body: 'Class reminder' })).toEqual({ status: 'suppressed', reason: 'disabled' });
    expect(provider.messages).toHaveLength(0);
    const enabled = await f.toggle(true);
    await f.service.update(f.context, { revision: enabled.revision, memberEmailsEnabled: true });
    expect((await f.settings.get(f.gymId)).memberSmsEnabled).toBe(true);
    expect((await sms.sendSms({ to: '+12025550110', body: 'Class reminder' })).status).toBe('sent');
    expect(await sms.sendSms({ to: '+12025550110', body: 'Second reminder' })).toEqual({ status: 'suppressed', reason: 'cap_reached' });
    await f.toggle(false);
    expect(await sms.sendSms({ to: '+12025550110', body: 'Off reminder' })).toEqual({ status: 'suppressed', reason: 'disabled' });
    expect(provider.messages).toHaveLength(1);
    const [usage] = await db.forGym(f.gymId, tx => tx.select().from(smsDailyUsage));
    expect(usage).toMatchObject({ sent: 1, refused: 1 });
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.updated')));
    expect(audits[0]).toMatchObject({ before: { memberSmsEnabled: false }, after: { memberSmsEnabled: true } });
    await expect(f.service.update(f.context, { revision: enabled.revision, memberSmsEnabled: true })).rejects.toMatchObject({ name: 'RevisionConflictError' });
  });
  it('checks the requested gym provider and leaves the other gym switch and cap untouched', async () => {
    const a = await fixture(true), b = await fixture();
    await a.toggle(true);
    await expect(b.toggle(true)).rejects.toMatchObject({ code: 'conflict' });
    expect((await a.settings.get(a.gymId)).memberSmsEnabled).toBe(true);
    expect(await b.settings.get(b.gymId)).toMatchObject({ memberSmsEnabled: false, smsDailyCap: 1 });
    expect(await db.forGym(b.gymId, tx => tx.select().from(smsDailyUsage))).toEqual([]);
  });
});
