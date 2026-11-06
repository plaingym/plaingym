// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection, scopedDatabase } from './client.js';
import { migrateDatabase } from './migrate.js';
import { intakeRateLimits, households } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0019_members_import_lookup', { applySecurity: true });
it('upgrades a populated database, preserving households and enforcing the new system-only boundary', async () => {
  const gymId = uuidv7(), householdId = uuidv7(), maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Existing gym', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Existing household')`;
  } finally { await maintenance.close(); }
  await migrateDatabase(database.maintenanceUrl);
  expect(await database.forGym(gymId, tx => tx.select().from(households))).toMatchObject([{ id: householdId, name: 'Existing household' }]);
  const app = openConnection(database.appUrl, 1), scope = scopedDatabase(app.db);
  try {
    expect(await scope.forSystem(tx => tx.select().from(intakeRateLimits))).toEqual([]);
    const counter = { gymId, routeKey: 'join', clientKey: '192.0.2.1', windowStart: new Date('2026-11-05T12:00:00Z'),
      expiresAt: new Date('2026-11-05T12:01:00Z'), count: 1 };
    await scope.forSystem(tx => tx.insert(intakeRateLimits).values(counter));
    expect(await app.db.select().from(intakeRateLimits)).toEqual([]);
    expect(await scope.forGym(gymId, tx => tx.select().from(intakeRateLimits))).toEqual([]);
    await expect(scope.forGym(gymId, tx => tx.insert(intakeRateLimits).values({ ...counter, clientKey: 'other' }))).rejects.toThrow();
    expect(await scope.forSystem(tx => tx.select().from(intakeRateLimits))).toHaveLength(1);
  } finally { await app.close(); }
});
