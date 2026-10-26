// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { memberships } from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';

const database = useTestDatabase(), factory = createFactories(database);

it('adds a nullable anniversary without changing existing membership dates or data', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const legacy = [
    await factory('memberships', gymId, { interval: 'annual', startsOn: '2028-02-29', nextDueOn: '2031-02-28', status: 'active' }),
    await factory('memberships', gymId, { interval: 'annual', startsOn: '2027-01-10', nextDueOn: '2031-06-19' }),
    await factory('memberships', gymId, { startsOn: '2028-01-31', nextDueOn: '2028-02-29' }),
  ];
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    // Recreate the previous schema in this disposable database, retaining all membership rows.
    await maintenance.sql`alter table payment_methods drop column processor_created_at`;
    await maintenance.sql`alter table memberships drop column anniversary_on`;
    await maintenance.sql`delete from drizzle.__drizzle_migrations where id in (select id from drizzle.__drizzle_migrations order by created_at desc limit 2)`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const rows = await database.forGym(gymId, tx => tx.select().from(memberships).orderBy(asc(memberships.id)));
  expect(rows).toEqual(legacy);
  expect(rows.every(row => row.anniversaryOn === null)).toBe(true);
  // A previous-release insert omits anniversary_on and continues to work after the upgrade.
  const inserted = await factory('memberships', gymId, { interval: 'annual', startsOn: '2027-03-01', nextDueOn: '2028-06-19' });
  expect(inserted).toMatchObject({ anniversaryOn: null, startsOn: '2027-03-01', nextDueOn: '2028-06-19' });
});
