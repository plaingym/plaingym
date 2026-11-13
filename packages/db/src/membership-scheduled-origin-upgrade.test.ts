// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { memberships } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0032_drop_in_charge_type_fk', { applySecurity: true });

it('adds the scheduled change origin to a populated database as null, keeps scheduled changes and checks its values', async () => {
  const gymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), planId = uuidv7(), otherPlanId = uuidv7();
  const scheduledId = uuidv7(), plainId = uuidv7();
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug, currency) values (${gymId}, 'Gym', ${gymId}, 'USD')`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    for (const id of [planId, otherPlanId])
      await maintenance.sql`insert into plans (id, gym_id, name, amount_cents, currency, interval) values (${id}, ${gymId}, 'Plan', 10000, 'USD', 'monthly')`;
    await maintenance.sql`insert into memberships (id, gym_id, household_id, member_id, plan_id, status, interval, amount_cents, currency,
      next_due_on, starts_on, scheduled_plan_id, scheduled_amount_cents, scheduled_interval, scheduled_on) values (${scheduledId}, ${gymId},
      ${householdId}, ${memberId}, ${planId}, 'active', 'monthly', 10000, 'USD', '2026-12-01', '2026-11-01', ${otherPlanId}, 9000,
      'monthly', '2026-12-01')`;
    await maintenance.sql`insert into memberships (id, gym_id, household_id, member_id, plan_id, status, interval, amount_cents, currency,
      next_due_on, starts_on) values (${plainId}, ${gymId}, ${householdId}, ${memberId}, ${planId}, 'active', 'monthly', 10000, 'USD',
      '2026-12-01', '2026-11-01')`;
    const before = await maintenance.sql`select * from memberships order by id`;

    await migrateDatabase(database.maintenanceUrl);

    // Existing scheduled changes keep a null origin, which the app reads as the switch rules.
    expect(await maintenance.sql`select * from memberships order by id`).toEqual(before.map(row => ({ ...row, scheduled_origin: null })));
    await expect(maintenance.sql`update memberships set scheduled_origin = 'other' where id = ${scheduledId}`)
      .rejects.toEqual(expect.objectContaining({ code: '23514' }));
    // The app role sets each origin under row-level security, and clears it.
    for (const origin of ['switch', 'downgrade', 'price_change'] as const) {
      await database.forGym(gymId, tx => tx.update(memberships).set({ scheduledOrigin: origin }).where(eq(memberships.id, scheduledId)));
      expect(await database.forGym(gymId, tx => tx.select({ origin: memberships.scheduledOrigin }).from(memberships)
        .where(eq(memberships.id, scheduledId)))).toEqual([{ origin }]);
    }
    await database.forGym(gymId, tx => tx.update(memberships).set({ scheduledPlanId: null, scheduledAmountCents: null,
      scheduledInterval: null, scheduledOn: null, scheduledOrigin: null }).where(eq(memberships.id, scheduledId)));
  } finally { await maintenance.close(); }
});
