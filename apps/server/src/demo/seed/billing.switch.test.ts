// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, members } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { fixture, snapshot } from './billing.fixture.test-helper.js';

const db = useTestDatabase(), factory = createFactories(db);

describe('demo billing seed and the billing switch', { timeout: 90_000 }, () => {
  it('confirms memberships already past due when it switches billing on, then restores the switch', async () => {
    const f = await fixture(db);
    // An interrupted run can leave an assigned membership whose first period was never generated.
    const [member] = await db.forGym(f.gymId, tx => tx.select().from(members).orderBy(members.id).limit(1));
    const plan = await factory('plans', f.gymId, { name: 'Interrupted plan', currency: 'CAD' });
    const overdue = await factory('memberships', f.gymId, { householdId: member!.householdId, memberId: member!.id, planId: plan.id,
      status: 'active', currency: 'CAD', nextDueOn: '2026-10-01' });
    await f.seed.run(f.context);
    const rows = await snapshot(db, f.gymId);
    const confirmed = rows.audit.filter(row => row.action === 'settings.go_live.past_due_dates_confirmed');
    expect(confirmed).toHaveLength(1);
    expect((confirmed[0]!.after as { memberships: { id: string }[] }).memberships.map(row => row.id)).toEqual([overdue.id]);
    expect(rows.gym.billingEnabled).toBe(false);
  });
  it('restores a disabled billing switch recorded before an interrupted seed process', async () => {
    const f = await fixture(db);
    await factory('auditEvents', f.gymId, { action: 'billing.seed.started', targetType: 'gym', targetId: f.gymId,
      occurredAt: f.clock.now(), after: { billingEnabled: false } });
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, f.gymId)));
    await f.seed.run(f.context);
    expect((await snapshot(db, f.gymId)).gym.billingEnabled).toBe(false);
  });

  it('refuses an uncertain card creation after the provider idempotency window', async () => {
    const f = await fixture(db); f.gateway.seedCard.mockRejectedValueOnce(new Error('Unknown provider outcome'));
    await expect(f.seed.run(f.context)).rejects.toThrow(/Unknown provider/);
    const uncertainHousehold = f.gateway.seedCard.mock.calls[0]![1];
    const callsBeforeRetry = f.gateway.seedCard.mock.calls.filter(call => call[1] === uncertainHousehold).length;
    f.clock.advance(24 * 60 * 60 * 1000);
    await expect(f.seed.run(f.context)).rejects.toThrow(/idempotency window/);
    expect(f.gateway.seedCard.mock.calls.filter(call => call[1] === uncertainHousehold)).toHaveLength(callsBeforeRetry);
    expect((await snapshot(db, f.gymId)).gym.billingEnabled).toBe(false);
  });
});
