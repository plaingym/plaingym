// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { ranks } from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';

const database = useTestDatabase();
const factory = createFactories(database);

it('upgrades a schema-v1 rank in place with a null color and preserves its data', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const legacy = await factory('ranks', gymId, { name: 'Existing belt', criteria: [{ providerId: 'classes', config: { count: 12 } }] });
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    // Recreate v1 only inside this disposable test database, retaining its rank. Later migrations are undone first.
    await maintenance.sql`drop table import_chunks, import_runs, export_runs`;
    await maintenance.sql`alter table class_sessions drop constraint class_sessions_occurrence_key`;
    await maintenance.sql`alter table class_sessions drop column occurrence_starts_at`;
    for (const table of ['attendances', 'class_sessions', 'class_templates'])
      await maintenance.sql`alter table ${maintenance.sql(table)} drop column kind`;
    await maintenance.sql`alter table gyms drop column open_mat_counts_as_class`;
    await maintenance.sql`alter table ranks drop constraint ranks_color_check`;
    await maintenance.sql`alter table ranks drop column color`;
    await maintenance.sql`delete from drizzle.__drizzle_migrations where id in (select id from drizzle.__drizzle_migrations order by created_at desc limit 4)`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  expect(await database.forGym(gymId, (tx) => tx.select().from(ranks))).toEqual([{ ...legacy, color: null }]);
});
