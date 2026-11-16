// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { forGym, gyms, smsDailyUsage, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createStatusProviders } from '../health/status.providers.js';
import { encryptSmsConfig } from './sms.js';

const db = useTestDatabase(), factory = createFactories(db), key = Buffer.alloc(32, 12);
const clock = new TestClock('2026-11-16T04:00:00Z');
const config = { accountSid: 'AC' + '1'.repeat(32), auth: { token: 'private-test-token' }, sender: { from: '+12025550110' } };
async function fixture() {
  const gymId = uuidv7();
  await factory('gyms', gymId, { timezone: 'America/Los_Angeles', memberSmsEnabled: true, smsDailyCap: 2,
    smsConfig: encryptSmsConfig(key, gymId, config) });
  const read = async (demo = false, scope: typeof forGym = db.forGym) => {
    const provider = createStatusProviders({ scope, env: { TENANCY: 'single', APP_ENCRYPTION_KEY: key.toString('hex'), DEMO_MODE: String(demo) } })
      .find(provider => provider.id === 'sms')!;
    return provider.read({ gymId, roles: ['owner'], clock });
  };
  return { gymId, read };
}
describe('SMS health provider', () => {
  it('reports configured and enabled, off, missing and unreadable states without exposing configuration', async () => {
    const f = await fixture();
    expect(await f.read()).toMatchObject({ id: 'sms', status: 'healthy', details: { configured: true, memberSmsEnabled: true, smsDailyCap: 2 } });
    expect(JSON.stringify(await f.read())).not.toMatch(/private-test-token|1202555|AC111/);
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, f.gymId)));
    expect(await f.read()).toMatchObject({ status: 'warning', details: { memberSmsEnabled: false } });
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ smsConfig: null }).where(eq(gyms.id, f.gymId)));
    expect(await f.read()).toMatchObject({ status: 'not_configured', details: { configured: false } });
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ smsConfig: 'unreadable' }).where(eq(gyms.id, f.gymId)));
    expect(await f.read()).toMatchObject({ status: 'warning', message: expect.stringContaining('could not be read'), details: { configured: false } });
  });
  it('counts the requesting gym local day and warns about refused attempts even if the cap was increased', async () => {
    const a = await fixture(), b = await fixture();
    await factory('smsDailyUsage', a.gymId, { day: '2026-11-15', sent: 2, refused: 3 });
    await factory('smsDailyUsage', a.gymId, { day: '2026-11-16', sent: 11, refused: 12 });
    expect(await a.read()).toMatchObject({ status: 'warning', details: { sentToday: 2, refusedToday: 3 } });
    expect(await b.read()).toMatchObject({ status: 'healthy', details: { sentToday: 0, refusedToday: 0 } });
    await db.forGym(a.gymId, tx => tx.update(gyms).set({ smsDailyCap: 20 }).where(eq(gyms.id, a.gymId)));
    expect(await a.read()).toMatchObject({ status: 'warning', details: { smsDailyCap: 20 } });
    expect((await db.forGym(b.gymId, tx => tx.select().from(smsDailyUsage))).length).toBe(0);
  });
  it('reports the last submitted test, clears it on removal and keeps other gyms tests separate', async () => {
    const a = await fixture(), b = await fixture();
    const audit = async (action: string, after?: { test: string }) => {
      clock.advance(1000);
      await db.forGym(a.gymId, tx => writeAudit(tx, { gymId: a.gymId, actorKind: 'system', action, targetType: 'gym', targetId: a.gymId, after, occurredAt: clock.now() }));
    };
    await audit('integrations.sms_tested', { test: 'failed' });
    expect(await a.read()).toMatchObject({ status: 'warning', details: { lastTestResult: 'failed', lastTestAt: clock.now().toISOString() } });
    expect(await b.read()).toMatchObject({ status: 'healthy', details: { lastTestAt: null, lastTestResult: null } });
    await audit('integrations.sms_tested', { test: 'sent' });
    expect(await a.read()).toMatchObject({ status: 'healthy', details: { lastTestResult: 'sent' } });
    await audit('integrations.sms_removed');
    expect(await a.read()).toMatchObject({ details: { lastTestAt: null, lastTestResult: null } });
  });
  it('uses the demo outbox without reading a stored SMS secret', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ smsConfig: 'not-readable' }).where(eq(gyms.id, f.gymId)));
    expect(await f.read(true)).toMatchObject({ status: 'healthy', message: expect.stringContaining('outbox'), details: { configured: true } });
  });
});
