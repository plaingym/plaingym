// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, members, smsOptedOutNumbers, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- One extra app-role connection holds the lock in this disposable test database.
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createSmsOptOutSweepJob, jobs, smsOptOutSweepJob } from './members.jobs.js';
import { forgetUnheldSmsOptOut } from './sms-opt-out.js';

const database = useTestDatabase(), factory = createFactories(database), scope = database.forGym;
const clock = new TestClock('2026-11-20T18:00:00Z');
const sweep = createSmsOptOutSweepJob(scope);
const run = (gymId: string) => sweep.handler({}, { gymId, jobId: 'sms-opt-out-sweep', timezone: 'UTC', attempt: 1, clock });
const [p1, p2, p3, p4, p5] = ['+12025550101', '+12025550102', '+12025550103', '+12025550104', '+12025550105'];
const local = (phoneE164: string) => phoneE164.slice(2);

async function gym() {
  const gymId = uuidv7();
  await factory('gyms', gymId, { name: 'Test Gym', address: { country: 'US' }, timezone: 'America/Los_Angeles' });
  return gymId;
}
const list = (gymId: string, phoneE164: string) => factory('smsOptedOutNumbers', gymId, { phoneE164, optedOutAt: clock.now() });
const listed = (gymId: string) => scope(gymId, async tx => (await tx.select({ phoneE164: smsOptedOutNumbers.phoneE164 })
  .from(smsOptedOutNumbers).orderBy(asc(smsOptedOutNumbers.phoneE164))).map(row => row.phoneE164));
const audits = (gymId: string) => scope(gymId, tx => tx.select().from(auditEvents).orderBy(asc(auditEvents.id)));
const expectNoPhone = (rows: unknown) => {
  for (const phone of [p1, p2, p3, p4, p5]) for (const value of [phone!, local(phone!)]) expect(JSON.stringify(rows)).not.toContain(value);
};

/** Gym A lists a member's number, a household's, a number nobody holds and one only an erased member holds. */
async function seeded() {
  const gymId = await gym();
  const home = await factory('households', gymId, { phone: local(p2!), phoneE164: p2 });
  await factory('members', gymId, { householdId: home.id, phone: local(p1!), phoneE164: p1 });
  await factory('members', gymId, { householdId: home.id, phone: local(p4!), phoneE164: p4, anonymizedAt: clock.now() });
  for (const phone of [p1, p2, p3, p4]) await list(gymId, phone!);
  return gymId;
}

describe('the daily opted-out list sweep', () => {
  it('is registered with the members jobs on a daily schedule', () => {
    expect(jobs.find(job => job.id === smsOptOutSweepJob)).toMatchObject({ cron: '53 3 * * *' });
    expect(sweep).toMatchObject({ id: smsOptOutSweepJob, cron: '53 3 * * *' });
  });

  it('drops numbers no current record holds and audits only the count', async () => {
    const gymId = await seeded();
    await run(gymId);
    expect(await listed(gymId)).toEqual([p1, p2]);
    const rows = await audits(gymId);
    expect(rows).toEqual([expect.objectContaining({ gymId, actorKind: 'system', actorUserId: null, action: 'members.sms_opt_outs.swept',
      targetType: 'gym', targetId: gymId, before: null, after: { count: 2 }, occurredAt: clock.now() })]);
    expectNoPhone(rows);
  });

  it('leaves another gym\'s unheld numbers listed', async () => {
    const gymId = await seeded(), other = await gym();
    await list(other, p5!); await list(other, p3!);
    await run(gymId);
    expect(await listed(other)).toEqual([p3, p5]);
    expect(await audits(other)).toEqual([]);
  });

  it('deletes nothing and writes no audit on a second run', async () => {
    const gymId = await seeded();
    await run(gymId);
    clock.advance(86_400_000);
    await run(gymId);
    expect(await listed(gymId)).toEqual([p1, p2]);
    expect((await audits(gymId)).map(row => row.action)).toEqual(['members.sms_opt_outs.swept']);
  });

  it('deletes nothing and writes no audit for an empty list', async () => {
    const gymId = await gym();
    await factory('households', gymId, { phone: local(p2!), phoneE164: p2 });
    await run(gymId);
    expect(await listed(gymId)).toEqual([]);
    expect(await audits(gymId)).toEqual([]);
  });

  it('keeps a number whose holder commits while the sweep waits for its row', async () => {
    const gymId = await gym(), home = await factory('households', gymId, {});
    await list(gymId, p3!);
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holderConnection = openConnection(database.appUrl, 1);
    // A writer gives a member the number and renews its row, then pauses before committing.
    const holding = scopedDatabase(holderConnection.db).forGym(gymId, async tx => {
      await tx.insert(members).values({ id: uuidv7(), gymId, householdId: home.id, firstName: 'Late', lastName: 'Holder',
        phone: local(p3!), phoneE164: p3, createdAt: clock.now() });
      await tx.update(smsOptedOutNumbers).set({ optedOutAt: clock.now() }).where(eq(smsOptedOutNumbers.phoneE164, p3!));
      held.resolve(); await release.promise;
    });
    let sweeping: Promise<unknown> | undefined;
    try {
      await held.promise;
      sweeping = run(gymId);
      await expect.poll(async () => {
        const [row] = await database.system.sql`select exists (select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query ilike '%"sms_opted_out_numbers"%') as waiting`;
        return row!.waiting;
      }, { timeout: 5000 }).toBe(true);
      release.resolve();
      await holding; await sweeping;
      expect(await listed(gymId)).toEqual([p3]);
      expect(await audits(gymId)).toEqual([]);
    } finally {
      release.resolve(); await holding.catch(() => undefined); await sweeping?.catch(() => undefined); await holderConnection.close();
    }
  });

  it('leaves forgetting a single number unchanged', async () => {
    const gymId = await seeded();
    await scope(gymId, async tx => { await forgetUnheldSmsOptOut(tx, p1); await forgetUnheldSmsOptOut(tx, p3); await forgetUnheldSmsOptOut(tx, p4); });
    expect(await listed(gymId)).toEqual([p1, p2]);
  });
});
