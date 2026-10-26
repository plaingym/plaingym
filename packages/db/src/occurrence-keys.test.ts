// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { classSessions } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0003_open_mat');

it('upgrades class sessions in place, keying generated sessions by their start and leaving one-off sessions unkeyed', async () => {
  const gymId = uuidv7(), templateId = uuidv7();
  const defaults = {
    gymId, name: 'Test Class', createdAt: new Date('2026-01-15T12:00:00Z'),
    kind: 'class', coachId: null, capacity: null, notes: null, status: 'scheduled', revision: 1,
  };
  const sessions = [
    { ...defaults, id: uuidv7(), templateId, startsAt: new Date('2026-01-15T12:00:00Z'), endsAt: new Date('2026-01-15T13:00:00Z') },
    { ...defaults, id: uuidv7(), templateId, startsAt: new Date('2026-01-22T12:00:00Z'), endsAt: new Date('2026-01-22T13:00:00Z') },
    { ...defaults, id: uuidv7(), templateId: null, startsAt: new Date('2026-01-15T12:00:00Z'), endsAt: new Date('2026-01-15T13:00:00Z') },
  ];
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Test Gym', ${gymId})`;
    await maintenance.sql`insert into class_templates (id, gym_id, name, weekday, local_start_time, duration_minutes)
      values (${templateId}, ${gymId}, 'Test Class', 1, '18:00', 60)`;
    for (const session of sessions) {
      await maintenance.sql`insert into class_sessions (id, gym_id, template_id, name, created_at, starts_at, ends_at)
        values (${session.id}, ${gymId}, ${session.templateId}, ${session.name}, ${session.createdAt.toISOString()}, ${session.startsAt.toISOString()}, ${session.endsAt.toISOString()})`;
    }
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const rows = await database.forGym(gymId, (tx) => tx.select().from(classSessions).orderBy(asc(classSessions.id)));
  expect(rows).toMatchObject(sessions.map((session) => ({ ...session, occurrenceStartsAt: session.templateId ? session.startsAt : null }))
    .sort((a, b) => a.id.localeCompare(b.id)));
});
