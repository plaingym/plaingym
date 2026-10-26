// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { attendances } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0002_rank_colors');

it('upgrades attendance in place, marking earlier session-less live visits as open mat', async () => {
  const gymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), sessionId = uuidv7();
  const visits = [
    { id: uuidv7(), sessionId, source: 'coach', sourceKey: null },
    { id: uuidv7(), sessionId: null, source: 'coach', sourceKey: null },
    { id: uuidv7(), sessionId: null, source: 'kiosk', sourceKey: null },
    { id: uuidv7(), sessionId: null, source: 'import', sourceKey: 'legacy:1' },
  ];
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Test Gym', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Test Household')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    await maintenance.sql`insert into class_sessions (id, gym_id, name, starts_at, ends_at)
      values (${sessionId}, ${gymId}, 'Test Class', '2026-01-15T12:00:00Z', '2026-01-15T13:00:00Z')`;
    for (const visit of visits) {
      await maintenance.sql`insert into attendances (id, gym_id, member_id, session_id, occurred_at, source, source_key)
        values (${visit.id}, ${gymId}, ${memberId}, ${visit.sessionId}, '2026-01-15T12:00:00Z', ${visit.source}, ${visit.sourceKey})`;
    }
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const rows = await database.forGym(gymId, (tx) => tx.select({ id: attendances.id, kind: attendances.kind }).from(attendances).orderBy(asc(attendances.id)));
  expect(rows).toEqual(visits.map((visit, index) => ({ id: visit.id, kind: index === 1 || index === 2 ? 'open_mat' : 'class' }))
    .sort((a, b) => a.id.localeCompare(b.id)));
});
