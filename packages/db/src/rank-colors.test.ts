// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { ranks } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0001_schema_v1');

it('upgrades a schema-v1 rank in place with a null color and preserves its data', async () => {
  const gymId = uuidv7(), rankSystemId = uuidv7();
  const legacy = {
    id: uuidv7(), gymId, rankSystemId, createdAt: new Date('2026-01-15T12:00:00Z'),
    name: 'Existing belt', position: 0, subRanks: [],
    criteria: [{ providerId: 'classes', config: { count: 12 } }], revision: 1,
  };
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Test Gym', ${gymId})`;
    await maintenance.sql`insert into rank_systems (id, gym_id, name) values (${rankSystemId}, ${gymId}, 'Test progression')`;
    await maintenance.sql`insert into ranks (id, gym_id, rank_system_id, created_at, name, position, criteria)
      values (${legacy.id}, ${gymId}, ${rankSystemId}, ${legacy.createdAt.toISOString()}, ${legacy.name}, ${legacy.position}, ${JSON.stringify(legacy.criteria)})`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  expect(await database.forGym(gymId, (tx) => tx.select().from(ranks))).toMatchObject([{ ...legacy, color: null }]);
});
