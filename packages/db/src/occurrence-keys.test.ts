// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { classSessions } from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';

const database = useTestDatabase();
const factory = createFactories(database);

it('upgrades class sessions in place, keying generated sessions by their start and leaving one-off sessions unkeyed', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const template = await factory('classTemplates', gymId);
  const sessions = [
    await factory('classSessions', gymId, { templateId: template.id }),
    await factory('classSessions', gymId, { templateId: template.id, startsAt: new Date('2026-01-22T12:00:00Z'), endsAt: new Date('2026-01-22T13:00:00Z') }),
    await factory('classSessions', gymId),
  ];
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    // Recreate the previous schema only inside this disposable test database, retaining its rows.
    await maintenance.sql`drop table import_chunks, import_runs, export_runs`;
    await maintenance.sql`alter table class_sessions drop constraint class_sessions_occurrence_key`;
    await maintenance.sql`alter table class_sessions drop column occurrence_starts_at`;
    await maintenance.sql`delete from drizzle.__drizzle_migrations where id in (select id from drizzle.__drizzle_migrations order by created_at desc limit 2)`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const rows = await database.forGym(gymId, (tx) => tx.select().from(classSessions).orderBy(asc(classSessions.id)));
  expect(rows).toEqual(sessions.map((session) => ({ ...session, occurrenceStartsAt: session.templateId ? session.startsAt : null })));
});
