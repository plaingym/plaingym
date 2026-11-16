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
import { createGoLiveService } from './go-live.js';
import { createGymSettingsAccessor } from './settings.js';

const db = useTestDatabase(), factory = createFactories(db), key = Buffer.alloc(32, 12);
async function fixture(demo = false) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T04:00:00Z');
  await factory('gyms', gymId, { name: 'Sample gym', address: { country: 'US' }, smsDailyCap: 1 });
  const person = await factory('members', gymId, { phone: '+12025550110', phoneE164: '+12025550110',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const resolver = createSmsResolver({ key, tenancy: 'single', scope: db.forGym, demo, clock });
  const configured = vi.fn(async (id: string) => { assertNoTransaction('SMS configured'); return resolver.configured(id); });
  const service = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => false, smsConfigured: configured });
  const settings = createGymSettingsAccessor({ scope: db.forGym }), context = { gymId, actor: { kind: 'system' as const } };
  const toggle = async (memberSmsEnabled: boolean) => service.update(context, { revision: (await settings.get(gymId)).revision, memberSmsEnabled });
  return { gymId, clock, person, resolver, service, settings, context, toggle, configured };
}
describe('member SMS go-live', () => {
  it('enables a saved readable provider without sending a test or a member text', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ smsConfig: encryptSmsConfig(key, f.gymId, {
      accountSid: 'AC' + '1'.repeat(32), auth: { token: 'local-test-token' }, sender: { from: '+12025550111' },
    }) }).where(eq(gyms.id, f.gymId)));
    expect(await f.toggle(true)).toMatchObject({ memberSmsEnabled: true });
    expect((await f.service.checklist(f.gymId)).items.find(item => item.id === 'sms_ready')?.status).toBe('ready');
    expect(await db.forGym(f.gymId, tx => tx.select().from(smsDailyUsage))).toEqual([]);
  });
  it('requires an available readable provider, and always allows an up-to-date off request', async () => {
    const f = await fixture();
    await expect(f.toggle(true)).rejects.toMatchObject({ code: 'conflict', details: { memberSmsEnabled: ['no_provider'] } });
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ smsConfig: 'unreadable', memberSmsEnabled: true }).where(eq(gyms.id, f.gymId)));
    await expect(f.toggle(true)).rejects.toMatchObject({ code: 'conflict' });
    f.configured.mockClear(); await f.toggle(false);
    // Turning off does not consult the provider before the save; the resulting checklist still checks readiness.
    expect((await f.settings.get(f.gymId)).memberSmsEnabled).toBe(false);
    expect((await f.service.checklist(f.gymId)).items.find(item => item.id === 'sms_ready')?.status).toBe('needs_attention');
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
