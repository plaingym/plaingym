// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { memberships } from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0005_import_run_state'), factory = createFactories(database);

it('adds a nullable anniversary without changing existing membership dates or data', async () => {
  const gymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), planId = uuidv7();
  const defaults = {
    gymId, householdId, memberId, planId, createdAt: new Date('2026-01-15T12:00:00Z'),
    status: 'pending', amountCents: 10000, currency: 'USD', revision: 1,
    trialEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, commitmentEndsOn: null,
  };
  const legacy = [
    { ...defaults, id: uuidv7(), interval: 'annual', startsOn: '2028-02-29', nextDueOn: '2031-02-28', status: 'active' },
    { ...defaults, id: uuidv7(), interval: 'annual', startsOn: '2027-01-10', nextDueOn: '2031-06-19' },
    { ...defaults, id: uuidv7(), interval: 'monthly', startsOn: '2028-01-31', nextDueOn: '2028-02-29' },
  ];
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Test Gym', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Test Household')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    await maintenance.sql`insert into plans (id, gym_id, name, amount_cents, currency, interval)
      values (${planId}, ${gymId}, 'Test Plan', 10000, 'USD', 'annual')`;
    for (const membership of legacy) {
      await maintenance.sql`insert into memberships (id, gym_id, household_id, member_id, plan_id, created_at, status, interval, amount_cents, currency, starts_on, next_due_on)
        values (${membership.id}, ${gymId}, ${householdId}, ${memberId}, ${planId}, ${membership.createdAt.toISOString()}, ${membership.status}, ${membership.interval}, ${membership.amountCents}, ${membership.currency}, ${membership.startsOn}, ${membership.nextDueOn})`;
    }
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const rows = await database.forGym(gymId, tx => tx.select().from(memberships).orderBy(asc(memberships.id)));
  expect(rows).toMatchObject(legacy.map(row => ({ ...row, anniversaryOn: null })).sort((a, b) => a.id.localeCompare(b.id)));
  expect(rows.every(row => row.anniversaryOn === null)).toBe(true);
  // A previous-release insert omits anniversary_on and continues to work after the upgrade.
  const inserted = await factory('memberships', gymId, { interval: 'annual', startsOn: '2027-03-01', nextDueOn: '2028-06-19' });
  expect(inserted).toMatchObject({ anniversaryOn: null, startsOn: '2027-03-01', nextDueOn: '2028-06-19' });
});
