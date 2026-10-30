// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { jobs, jobScheduleCursors } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0011_email_deliveries', { applySecurity: true });

it('adds an empty cursor table and leaves existing job history untouched', async () => {
  const gymId = uuidv7();
  // The previous release kept each schedule's cursor in its latest occurrence row's payload.
  const occurrence = {
    id: uuidv7(), gymId, name: 'bookings.recover', runAt: new Date('2026-10-30T07:05:00Z'), attempts: 1, maxAttempts: 3,
    status: 'succeeded', lockedUntil: null, lockToken: null, lastError: null, idempotencyKey: 'a'.repeat(64),
    createdAt: new Date('2026-10-30T07:05:00Z'),
    payload: { version: 1, timezone: 'America/Vancouver', value: {}, schedule: { expression: '*/5 * * * *', at: '2026-10-30T07:05:00.000Z' } },
  };
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Test Gym', ${gymId})`;
    await maintenance.sql`insert into jobs (id, gym_id, name, payload, run_at, attempts, max_attempts, status, idempotency_key, created_at)
      values (${occurrence.id}, ${gymId}, ${occurrence.name}, ${JSON.stringify(occurrence.payload)}::jsonb, ${occurrence.runAt.toISOString()},
        1, 3, 'succeeded', ${occurrence.idempotencyKey}, ${occurrence.createdAt.toISOString()})`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  expect(await database.forGym(gymId, (tx) => tx.select().from(jobs))).toMatchObject([occurrence]);
  // Cursors start empty; the scheduler seeds each one from that history on its first tick (infra/jobs).
  expect(await database.forGym(gymId, (tx) => tx.select().from(jobScheduleCursors))).toEqual([]);
  const [cursor] = await database.forGym(gymId, (tx) => tx.insert(jobScheduleCursors).values({ gymId, name: occurrence.name,
    expression: '*/5 * * * *', timezone: 'America/Vancouver', lastOccurrence: occurrence.runAt }).returning());
  expect(cursor).toMatchObject({ gymId, name: occurrence.name, lastOccurrence: occurrence.runAt });
  await expect(database.forGym(gymId, (tx) => tx.insert(jobScheduleCursors).values({ gymId, name: occurrence.name,
    expression: '0 * * * *', timezone: 'UTC', lastOccurrence: occurrence.runAt }))).rejects.toMatchObject({ cause: { code: '23505' } });
});
