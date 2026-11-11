// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { leads, leadContacts, members } from './schema/index.js';
import { assertCatalog } from './security/catalog.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';
import { createFactories } from './testing/factories.js';

const database = useUpgradeTestDatabase('0025_announcement_scale', { applySecurity: true });

it('preserves populated members and adds empty lead tables without a backfill', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1), gymId = uuidv7();
  try {
    const factory = createFactories(database);
    await factory('gyms', gymId);
    await factory('members', gymId, { status: 'prospect' });
    await factory('members', gymId, { status: 'trial' });
    await factory('members', gymId, { status: 'active' });
    const before = await database.forGym(gymId, tx => tx.select().from(members).orderBy(members.id));
    await migrateDatabase(database.maintenanceUrl);
    expect(await database.forGym(gymId, tx => tx.select().from(members).orderBy(members.id))).toEqual(before);
    for (const table of [leads, leadContacts]) expect(await database.forGym(gymId, tx => tx.select().from(table))).toEqual([]);
    expect(await assertCatalog(maintenance.sql)).toEqual({ tableCount: 66, tenantTableCount: 54 });
    await expect(factory('leadContacts', gymId)).resolves.toMatchObject({ channel: 'call' });
  } finally { await maintenance.close(); }
});
