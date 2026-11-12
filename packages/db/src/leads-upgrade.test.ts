// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { leads, leadContacts } from './schema/index.js';
import { assertCatalog } from './security/catalog.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';
import { createFactories } from './testing/factories.js';

const database = useUpgradeTestDatabase('0025_announcement_scale', { applySecurity: true });

it('preserves populated members and adds empty lead tables without a backfill', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1), gymId = uuidv7();
  try {
    const factory = createFactories(database);
    await factory('gyms', gymId);
    const householdId = uuidv7();
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    for (const status of ['prospect', 'trial', 'active']) await maintenance.sql`insert into members
      (id, gym_id, household_id, first_name, last_name, status)
      values (${uuidv7()}, ${gymId}, ${householdId}, 'Test', 'Member', ${status})`;
    // Historical fixtures must not request generated columns added by later migrations.
    const read = () => maintenance.sql`select * from members where gym_id = ${gymId} order by id`;
    const before = await read();
    await migrateDatabase(database.maintenanceUrl);
    expect((await read()).map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'email_address')))).toEqual([...before]);
    for (const table of [leads, leadContacts]) expect(await database.forGym(gymId, tx => tx.select().from(table))).toEqual([]);
    expect(await assertCatalog(maintenance.sql)).toEqual({ tableCount: 69, tenantTableCount: 57 });
    await expect(factory('leadContacts', gymId)).resolves.toMatchObject({ channel: 'call' });
  } finally { await maintenance.close(); }
});
