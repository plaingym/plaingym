// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, leads, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { recordLeadIntake } from './intake.js';

const database = useTestDatabase(), factory = createFactories(database), now = new Date('2026-11-10T12:00:00Z');
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const member = await factory('members', gymId, { status: 'prospect' });
  const rows = () => database.forGym(gymId, async tx => ({ leads: await tx.select().from(leads),
    audits: await tx.select().from(auditEvents).where(eq(auditEvents.action, 'lead.created')) }));
  return { gymId, memberId: member.id, rows };
}
describe('lead intake', () => {
  it('keeps the first source and writes one source-only audit on concurrent or later replay', async () => {
    const f = await fixture();
    const input = { gymId: f.gymId, memberId: f.memberId, source: 'trial_form' as const, now };
    await Promise.all([1, 2].map(() => database.forGym(f.gymId, tx => recordLeadIntake(tx, input))));
    await database.forGym(f.gymId, tx => recordLeadIntake(tx, { ...input, source: 'phone', now: new Date('2026-11-11Z') }));
    const rows = await f.rows();
    expect(rows.leads).toHaveLength(1);
    expect(rows.leads[0]).toMatchObject({ memberId: f.memberId, source: 'trial_form', stage: 'new', revision: 1, createdAt: now });
    expect(rows.audits).toHaveLength(1);
    expect(rows.audits[0]).toMatchObject({ actorKind: 'system', actorUserId: null, targetType: 'lead', targetId: rows.leads[0]!.id,
      before: null, after: { source: 'trial_form' }, occurredAt: now });
  });
  it('rolls the lead and audit back with the caller transaction', async () => {
    const f = await fixture();
    await expect(database.forGym(f.gymId, async tx => {
      await recordLeadIntake(tx, { ...f, source: 'join', now });
      throw new Error('caller failed');
    })).rejects.toThrow('caller failed');
    expect(await f.rows()).toEqual({ leads: [], audits: [] });
  });
  it('refuses cross-gym intake without creating an audit', async () => {
    const f = await fixture(), otherGym = uuidv7(); await factory('gyms', otherGym);
    await expect(database.forGym(otherGym, tx => recordLeadIntake(tx, { gymId: otherGym, memberId: f.memberId, source: 'drop_in', now })))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await database.forGym(otherGym, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'lead.created'), eq(auditEvents.gymId, otherGym)))))
      .toEqual([]);
    expect(await f.rows()).toEqual({ leads: [], audits: [] });
  });
});
