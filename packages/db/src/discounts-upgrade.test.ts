// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { discounts, discountPlans, membershipDiscounts } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0030_member_address_index', { applySecurity: true });
it('adds three empty discount tables to a populated database without changing existing rows', async () => {
  const gymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), planId = uuidv7(), membershipId = uuidv7(), invoiceId = uuidv7();
  const connection = openConnection(database.maintenanceUrl, 1);
  try {
    await connection.sql`insert into gyms (id, name, slug, currency) values (${gymId}, 'Gym', ${gymId}, 'USD')`;
    await connection.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    await connection.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    await connection.sql`insert into plans (id, gym_id, name, amount_cents, currency, interval)
      values (${planId}, ${gymId}, 'Monthly', 10000, 'USD', 'monthly')`;
    await connection.sql`insert into memberships (id, gym_id, household_id, member_id, plan_id, status, interval, amount_cents, currency, next_due_on, starts_on)
      values (${membershipId}, ${gymId}, ${householdId}, ${memberId}, ${planId}, 'active', 'monthly', 10000, 'USD', '2026-12-01', '2026-11-01')`;
    await connection.sql`insert into invoices (id, gym_id, household_id, kind, due_on, amount_cents, currency)
      values (${invoiceId}, ${gymId}, ${householdId}, 'one_off', '2026-12-01', 10000, 'USD')`;
    const before = await connection.sql`select row_to_json(g) as gym, row_to_json(h) as household, row_to_json(m) as member,
      row_to_json(p) as plan, row_to_json(ms) as membership, row_to_json(i) as invoice
      from gyms g, households h, members m, plans p, memberships ms, invoices i`;
    await migrateDatabase(database.maintenanceUrl);
    const after = await connection.sql`select row_to_json(g) as gym, row_to_json(h) as household, row_to_json(m) as member,
      row_to_json(p) as plan, row_to_json(ms) as membership, row_to_json(i) as invoice
      from gyms g, households h, members m, plans p, memberships ms, invoices i`;
    // A later migration (0033) adds the nullable memberships.scheduled_origin; nothing else changes.
    expect(after).toEqual(before.map(row => ({ ...row, membership: { ...row.membership, scheduled_origin: null } })));
    expect(await database.forGym(gymId, tx => tx.select().from(discounts))).toEqual([]);
    expect(await database.forGym(gymId, tx => tx.select().from(discountPlans))).toEqual([]);
    expect(await database.forGym(gymId, tx => tx.select().from(membershipDiscounts))).toEqual([]);
    const security = await connection.sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relname in ('discounts', 'discount_plans', 'membership_discounts') order by relname`;
    expect(security).toEqual(['discount_plans', 'discounts', 'membership_discounts'].map(relname =>
      ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
  } finally { await connection.close(); }
});
