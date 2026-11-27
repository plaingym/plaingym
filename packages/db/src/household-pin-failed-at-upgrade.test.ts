// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0045_household_pin_lockout', { applySecurity: true });
const gymId = uuidv7(), householdId = uuidv7();

beforeAll(async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'PIN count time upgrade', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name, pin_hash, pin_failed_count)
      values (${householdId}, ${gymId}, 'Family', 'hash', 3)`;
  } finally { await maintenance.close(); }
  await migrateDatabase(database.maintenanceUrl);
});

it('keeps an existing wrong-PIN count and gives it no time', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    expect(Array.from(await maintenance.sql`select pin_hash, pin_failed_count, pin_locked_until, pin_failed_at from households where id = ${householdId}`))
      .toEqual([{ pin_hash: 'hash', pin_failed_count: 3, pin_locked_until: null, pin_failed_at: null }]);
  } finally { await maintenance.close(); }
});
