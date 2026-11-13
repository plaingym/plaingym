// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, classCreditEntries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { addDays, zonedInstant } from '@plaingym/shared/time';
import { TestClock } from '../../../core/clock.js';
import { cronOccurrences } from '../../../infra/jobs/cron.js';
import { jobs as billingJobs } from '../jobs.js';
import { createCreditExpiryJobs, createCreditExpiryService } from './expiry.jobs.js';
import { lockMemberCredits, usableLots } from './index.js';
import { createCreditLedgerService } from './ledger.service.js';

const db = useTestDatabase(), factory = createFactories(db), timezone = 'America/New_York';
async function fixture(expiresAt: Date) {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone });
  const member = await factory('members', gymId);
  const sale = await factory('classPackSales', gymId, { memberId: member.id, householdId: member.householdId });
  const lot = await factory('classCreditEntries', gymId, { memberId: member.id, kind: 'grant', credits: 3,
    saleId: sale.id, reason: null, adjustmentId: null, expiresAt });
  const rows = () => db.forGym(gymId, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.memberId, member.id)));
  return { gymId, member, lot, rows };
}

describe('daily credit expiry', () => {
  it('does not revisit used-up or already-expired lots, including credits returned after expiry', async () => {
    const clock = new TestClock('2028-03-13T04:07:00Z'), f = await fixture(new Date('2028-03-13T04:00:00Z'));
    const used = await factory('members', f.gymId);
    const opening = await factory('classCreditEntries', f.gymId, { memberId: used.id, credits: 2, expiresAt: f.lot.expiresAt });
    await factory('classCreditEntries', f.gymId, { memberId: used.id, credits: -2, lotId: opening.id });
    let transactions = 0;
    const scope: typeof db.forGym = (gymId, work) => { transactions++; return db.forGym(gymId, work); };
    const service = createCreditExpiryService({ scope, clock });
    expect(await service.expire(f.gymId)).toBe(1);
    transactions = 0;
    expect(await service.expire(f.gymId)).toBe(0);
    expect(transactions).toBe(1); // Candidates only: no member transaction or lock.
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, kind: 'reverse', credits: 1,
      lotId: f.lot.id, attendanceId: uuidv7(), adjustmentId: null, reason: null });
    transactions = 0;
    expect(await service.expire(f.gymId)).toBe(0);
    expect(transactions).toBe(1);
    const read = await createCreditLedgerService({ scope: db.forGym, clock }).read(f.gymId, f.member.id, {});
    expect(read.data.balance).toBe(0);
    expect(read.data.lots).toEqual([]);
  });
  it.each([['2028-03-12', 23], ['2028-11-05', 25]] as const)('expires at local midnight across %s DST (%s-hour day)', async (date, hours) => {
    const start = zonedInstant(date, '00:00', timezone, { gap: 'shift' })!;
    const expiresAt = zonedInstant(addDays(date, 1), '00:00', timezone, { gap: 'shift' })!;
    expect((expiresAt.getTime() - start.getTime()) / 3_600_000).toBe(hours);
    const f = await fixture(expiresAt), other = await fixture(expiresAt);
    const clock = new TestClock(new Date(expiresAt.getTime() - 1));
    const service = createCreditExpiryService({ scope: db.forGym, clock });
    expect(await service.expire(f.gymId)).toBe(0);
    expect(await db.forGym(f.gymId, tx => usableLots(tx, f.member.id, clock.now()))).toHaveLength(1);
    clock.set(expiresAt);
    expect(await db.forGym(f.gymId, tx => usableLots(tx, f.member.id, clock.now()))).toHaveLength(0);
    // Midnight blocks draws even though the job does not run until 00:07.
    expect(await f.rows()).toHaveLength(1);
    const job = createCreditExpiryJobs({ scope: db.forGym })[0]!;
    const until = zonedInstant(addDays(date, 1), '00:08', timezone, { gap: 'shift' })!;
    const runs = [...cronOccurrences(job.cron!, timezone, start, until)];
    expect(runs).toEqual([zonedInstant(date, '00:07', timezone, { gap: 'shift' }),
      zonedInstant(addDays(date, 1), '00:07', timezone, { gap: 'shift' })]);
    clock.set(runs[1]!);
    const context = { gymId: f.gymId, timezone, clock, jobId: uuidv7(), attempt: 1 };
    await job.handler({}, context); await job.handler({}, context);
    expect((await f.rows()).filter(row => row.kind === 'expire')).toMatchObject([
      { lotId: f.lot.id, credits: -3, createdAt: clock.now() },
    ]);
    expect(await other.rows()).toHaveLength(1);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.credits.expired')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: 'system', occurredAt: clock.now() });
    expect(billingJobs.filter(item => item.id === job.id)).toHaveLength(1);
  });

  it('expires only the remainder, serializes concurrent jobs and keeps returned expired credits unusable', async () => {
    const clock = new TestClock('2028-03-13T04:07:00Z'), f = await fixture(new Date('2028-03-13T04:00:00Z'));
    const attendanceId = uuidv7();
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, kind: 'use', credits: -1,
      lotId: f.lot.id, attendanceId, adjustmentId: null, reason: null });
    const service = createCreditExpiryService({ scope: db.forGym, clock });
    expect((await Promise.all([service.expire(f.gymId), service.expire(f.gymId)])).sort()).toEqual([0, 1]);
    const expired = (await f.rows()).filter(row => row.kind === 'expire');
    expect(expired).toMatchObject([{ credits: -2, lotId: f.lot.id }]);
    await db.forGym(f.gymId, async tx => {
      await lockMemberCredits(tx, f.member.id);
      await tx.insert(classCreditEntries).values({ id: uuidv7(), gymId: f.gymId, memberId: f.member.id,
        kind: 'reverse', credits: 1, lotId: f.lot.id, attendanceId, createdAt: clock.now() });
      expect(await usableLots(tx, f.member.id, clock.now())).toHaveLength(0);
    });
    expect(await service.expire(f.gymId)).toBe(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries).where(and(
      eq(classCreditEntries.kind, 'expire'), eq(classCreditEntries.lotId, f.lot.id))))).toHaveLength(1);
  });
});
