// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, gyms, RevisionConflictError, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createAutoUpdateSettings } from './auto-update.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(settings: Record<string, unknown> = {}) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { timezone: 'America/Denver', settings });
  const clock = new TestClock('2026-11-03T12:00:00Z');
  const user = await factory('authUser', gymId);
  const service = createAutoUpdateSettings({ scope: db.forGym, clock });
  const row = async () => (await db.forGym(gymId, tx => tx.select({ settings: gyms.settings, revision: gyms.revision }).from(gyms).where(eq(gyms.id, gymId))))[0]!;
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  return { gymId, user, service, row, context };
}

describe('automatic update setting', () => {
  it('is on by default and reports the gym timezone the updater uses for its nightly window', async () => {
    const f = await fixture();
    expect(await f.service.get(f.gymId)).toEqual({ enabled: true, revision: 1, timezone: 'America/Denver' });
  });
  it('saves a change with its own revision, keeps the other settings and the gym revision, and audits it', async () => {
    const f = await fixture({ setup: { completed: true } });
    const gymRevision = (await f.row()).revision;
    expect(await f.service.update(f.context, { enabled: false, revision: 1 })).toEqual({ enabled: false, revision: 2, timezone: 'America/Denver' });
    expect(await f.service.get(f.gymId)).toMatchObject({ enabled: false, revision: 2 });
    const row = await f.row();
    expect(row.settings).toEqual({ setup: { completed: true }, automaticUpdates: { enabled: false, revision: 2 } });
    // The other settings sections share the gym revision; this switch doesn't move it.
    expect(row.revision).toBe(gymRevision);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, 'settings.automatic_updates.updated'), eq(auditEvents.targetId, f.gymId))));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: 'user', actorUserId: f.user.id, before: { enabled: true }, after: { enabled: false } });
    expect(await f.service.update(f.context, { enabled: true, revision: 2 })).toMatchObject({ enabled: true, revision: 3 });
  });
  it('refuses a stale revision and changes nothing', async () => {
    const f = await fixture();
    await f.service.update(f.context, { enabled: false, revision: 1 });
    await expect(f.service.update(f.context, { enabled: true, revision: 1 })).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await f.service.get(f.gymId)).toMatchObject({ enabled: false, revision: 2 });
  });
  it('reads anything but an explicit false as on', async () => {
    for (const automaticUpdates of [null, 'off', { enabled: 'no' }, { enabled: 0 }, { revision: -4 }]) {
      const f = await fixture({ automaticUpdates });
      expect(await f.service.get(f.gymId)).toMatchObject({ enabled: true, revision: 1 });
    }
    const off = await fixture({ automaticUpdates: { enabled: false, revision: 7 } });
    expect(await off.service.get(off.gymId)).toMatchObject({ enabled: false, revision: 7 });
  });
  it('changes only its own gym', async () => {
    const a = await fixture(), b = await fixture();
    await a.service.update(a.context, { enabled: false, revision: 1 });
    expect(await b.service.get(b.gymId)).toMatchObject({ enabled: true, revision: 1 });
    // In gym B's scope gym A's row isn't there: row-level security hides it.
    expect(await db.forGym(b.gymId, tx => tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, a.gymId)))).toEqual([]);
    const asGymB = ((_gymId: string, fn: Parameters<typeof db.forGym>[1]) => db.forGym(b.gymId, fn)) as typeof db.forGym;
    const service = createAutoUpdateSettings({ scope: asGymB });
    await expect(service.update({ gymId: a.gymId, actor: { kind: 'system' } }, { enabled: true, revision: 2 })).rejects.toMatchObject({ code: 'not_found' });
    expect(await a.service.get(a.gymId)).toMatchObject({ enabled: false, revision: 2 });
  });
});
