// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0044_jobs_finished_at', { applySecurity: true });
const gymId = uuidv7(), householdId = uuidv7();

beforeAll(async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'PIN lockout upgrade', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name, pin_hash) values (${householdId}, ${gymId}, 'Family', 'hash')`;
  } finally { await maintenance.close(); }
  await migrateDatabase(database.maintenanceUrl);
});

it('starts an existing household at no wrong PINs and no lock, and keeps its PIN', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    expect(Array.from(await maintenance.sql`select pin_hash, pin_failed_count, pin_locked_until from households where id = ${householdId}`))
      .toEqual([{ pin_hash: 'hash', pin_failed_count: 0, pin_locked_until: null }]);
  } finally { await maintenance.close(); }
});

it('refuses a negative or null wrong-PIN count', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await expect(maintenance.sql`update households set pin_failed_count = -1 where id = ${householdId}`).rejects.toMatchObject({ code: '23514' });
    await expect(maintenance.sql`update households set pin_failed_count = null where id = ${householdId}`).rejects.toMatchObject({ code: '23502' });
  } finally { await maintenance.close(); }
});
