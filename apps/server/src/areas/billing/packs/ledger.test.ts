// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, classCreditEntries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { drawCredits, hasActiveMembership, isPackHolder, lockMemberCredits, usableLots } from './index.js';
import { createCreditLedgerService } from './ledger.service.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2028-03-13T04:00:00Z');
  await factory('gyms', gymId);
  const user = await factory('authUser', gymId), member = await factory('members', gymId);
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const service = createCreditLedgerService({ scope: db.forGym, clock });
  const adjust = (credits: number, adjustmentId = uuidv7(), reason = 'Corrected class count') =>
    service.adjust(context, { memberId: member.id, credits, adjustmentId, reason });
  const entries = () => db.forGym(gymId, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.memberId, member.id)));
  return { gymId, clock, user, member, context, service, adjust, entries };
}

describe('member credit lock, lots and adjustments', () => {
  it('opens a never-expiring lot and audits its redactable reason once on replay', async () => {
    const f = await fixture(), adjustmentId = uuidv7();
    const responses = await Promise.all([f.adjust(3, adjustmentId), f.adjust(3, adjustmentId)]);
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]!.data).toMatchObject({ balance: 3, adjustmentId,
      entries: [{ kind: 'adjust', credits: 3, expiresAt: null, createdBy: f.user.id, reason: 'Corrected class count' }] });
    expect(await f.entries()).toHaveLength(1);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
    expect(audits).toMatchObject([{ action: 'billing.credits.adjusted', actorUserId: f.user.id,
      targetId: f.member.id, occurredAt: f.clock.now(), after: { adjustmentId, credits: 3,
        entries: [{ reasonEntryId: responses[0]!.data.entries[0]!.id }] } }]);
    // No unredactable copy of staff free text is left in the audit.
    expect(JSON.stringify(audits)).not.toContain('Corrected class count');
    await expect(f.adjust(4, adjustmentId)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['adjustment_id_reused'] } });
    await expect(f.adjust(3, adjustmentId, 'Different reason')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('serializes two negative adjustments against one credit; exactly one succeeds', async () => {
    const f = await fixture(); await f.adjust(1);
    const outcomes = await Promise.allSettled([f.adjust(-1), f.adjust(-1)]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(row => row.status === 'rejected')).toMatchObject({ status: 'rejected',
      reason: { code: 'conflict', details: { reason: ['insufficient_credits'] } } });
    expect((await f.service.read(f.gymId, f.member.id, {})).data.balance).toBe(0);
    expect(await f.entries()).toHaveLength(2);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).toHaveLength(2);
  });

  it('draws earliest expiry, then oldest equal-expiry lot, then oldest never-expiring lot', async () => {
    const f = await fixture();
    const seed = (credits: number, expiresAt: string | null, createdAt: string) => factory('classCreditEntries', f.gymId,
      { memberId: f.member.id, credits, expiresAt: expiresAt ? new Date(expiresAt) : null, createdAt: new Date(createdAt) });
    const foreverNew = await seed(2, null, '2028-03-12T00:00:00Z');
    const foreverOld = await seed(2, null, '2028-03-01T00:00:00Z');
    const later = await seed(2, '2028-03-20T04:00:00Z', '2028-03-01T00:00:00Z');
    const soonNew = await seed(2, '2028-03-14T04:00:00Z', '2028-03-12T00:00:00Z');
    const soonOld = await seed(1, '2028-03-14T04:00:00Z', '2028-03-01T00:00:00Z');
    // The exact expiry boundary is unusable before any expiry job runs.
    const expired = await seed(99, f.clock.now().toISOString(), '2028-03-01T00:00:00Z');
    const lots = await db.forGym(f.gymId, async tx => {
      await lockMemberCredits(tx, f.member.id);
      return usableLots(tx, f.member.id, f.clock.now());
    });
    expect(lots.map(lot => lot.id)).toEqual([soonOld.id, soonNew.id, later.id, foreverOld.id, foreverNew.id]);
    const id = uuidv7();
    const first = await f.adjust(-6, id), retry = await f.adjust(-6, id);
    expect(retry).toEqual(first);
    expect(first.data.balance).toBe(3);
    expect(first.data.entries.map(row => [row.lotId, row.credits])).toEqual(expect.arrayContaining([
      [soonOld.id, -1], [soonNew.id, -2], [later.id, -2], [foreverOld.id, -1],
    ]));
    expect((await f.entries()).filter(row => row.lotId === expired.id)).toEqual([]);
    const count = (await f.entries()).length;
    await expect(f.adjust(-4)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['insufficient_credits'] } });
    expect(await f.entries()).toHaveLength(count);
  });

  it('preflights direct draws without writes, supports attendance, and rolls back the caller transaction', async () => {
    const f = await fixture(); await f.adjust(2);
    await db.forGym(f.gymId, async tx => {
      await lockMemberCredits(tx, f.member.id);
      const result = await drawCredits(tx, { gymId: f.gymId, memberId: f.member.id, credits: 3, now: f.clock.now(),
        kind: 'adjust', adjustmentId: uuidv7(), reason: 'Too many', createdBy: f.user.id });
      expect(result).toEqual({ outcome: 'insufficient_credits', balance: 2 });
    });
    expect(await f.entries()).toHaveLength(1);
    const attendanceId = uuidv7();
    await expect(db.forGym(f.gymId, async tx => {
      await lockMemberCredits(tx, f.member.id);
      const result = await drawCredits(tx, { gymId: f.gymId, memberId: f.member.id, credits: 1,
        now: f.clock.now(), kind: 'use', attendanceId });
      expect(result).toMatchObject({ outcome: 'drawn', entries: [{ credits: -1, attendanceId, kind: 'use' }] });
      throw new Error('rollback draw');
    })).rejects.toThrow('rollback draw');
    expect(await f.entries()).toHaveLength(1);
  });

  it.each(['pending', 'trial', 'active', 'frozen', 'cancelled'] as const)('recognizes membership status %s', async status => {
    const f = await fixture();
    await factory('memberships', f.gymId, { memberId: f.member.id, householdId: f.member.householdId, status });
    expect(await db.forGym(f.gymId, tx => hasActiveMembership(tx, f.member.id))).toBe(status === 'active' || status === 'trial');
  });

  it('keeps exhausted holders and scopes helper reads/locks to the gym', async () => {
    const a = await fixture(), b = await fixture();
    expect(await db.forGym(a.gymId, tx => isPackHolder(tx, a.member.id))).toBe(false);
    await a.adjust(1); await a.adjust(-1);
    expect(await db.forGym(a.gymId, tx => isPackHolder(tx, a.member.id))).toBe(true);
    expect(await db.forGym(b.gymId, tx => isPackHolder(tx, a.member.id))).toBe(false);
    expect(await db.forGym(b.gymId, tx => usableLots(tx, a.member.id, a.clock.now()))).toEqual([]);
    expect(await db.forGym(b.gymId, tx => hasActiveMembership(tx, a.member.id))).toBe(false);
    await expect(db.forGym(b.gymId, tx => lockMemberCredits(tx, a.member.id))).rejects.toMatchObject({ code: 'not_found' });
  });
});
