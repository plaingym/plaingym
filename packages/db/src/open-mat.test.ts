// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { attendances } from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';

const database = useTestDatabase();
const factory = createFactories(database);

it('upgrades attendance in place, marking earlier session-less live visits as open mat', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const member = await factory('members', gymId), session = await factory('classSessions', gymId);
  const visits = [
    await factory('attendances', gymId, { memberId: member.id, sessionId: session.id }),
    await factory('attendances', gymId, { memberId: member.id }),
    await factory('attendances', gymId, { memberId: member.id, source: 'kiosk' }),
    await factory('attendances', gymId, { memberId: member.id, source: 'import', sourceKey: 'legacy:1' }),
  ];
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    // Recreate the previous schema only inside this disposable test database, retaining its rows.
    for (const table of ['attendances', 'class_sessions', 'class_templates'])
      await maintenance.sql`alter table ${maintenance.sql(table)} drop column kind`;
    await maintenance.sql`alter table gyms drop column open_mat_counts_as_class`;
    await maintenance.sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const rows = await database.forGym(gymId, (tx) => tx.select({ id: attendances.id, kind: attendances.kind }).from(attendances).orderBy(asc(attendances.id)));
  expect(rows).toEqual(visits.map((visit, index) => ({ id: visit.id, kind: index === 1 || index === 2 ? 'open_mat' : 'class' })));
});
