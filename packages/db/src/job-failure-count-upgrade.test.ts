// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0039_job_acknowledged', { applySecurity: true });
const gymId = uuidv7(), failedId = uuidv7(), pendingId = uuidv7();
// The raw maintenance connection takes instants as text.
const runAt = '2026-11-20T12:00:00.000Z';

beforeAll(async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Job failure count upgrade', ${gymId})`;
    await maintenance.sql`insert into jobs (id, gym_id, name, run_at, attempts, max_attempts, status, last_error, idempotency_key)
      values (${failedId}, ${gymId}, 'test.failed', ${runAt}, 1, 1, 'failed', 'Failed before the upgrade', 'failed'),
        (${pendingId}, ${gymId}, 'test.pending', ${runAt}, 0, 5, 'pending', null, 'pending')`;
  } finally { await maintenance.close(); }
  await migrateDatabase(database.maintenanceUrl);
});

it('starts existing jobs, failed ones included, at no counted failures and keeps their other fields', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    const rows = await maintenance.sql`select id, status, attempts, run_at = ${runAt}::timestamptz as kept_run_at, last_error,
      failure_count from jobs where id in (${failedId}, ${pendingId}) order by id`;
    expect(Array.from(rows)).toEqual([
      { id: failedId, status: 'failed', attempts: 1, kept_run_at: true, last_error: 'Failed before the upgrade', failure_count: 0 },
      { id: pendingId, status: 'pending', attempts: 0, kept_run_at: true, last_error: null, failure_count: 0 },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
  } finally { await maintenance.close(); }
});

it('defaults a new job to no failures and refuses a null count', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    const id = uuidv7();
    await maintenance.sql`insert into jobs (id, gym_id, name, run_at, idempotency_key) values (${id}, ${gymId}, 'test.new', ${runAt}, 'new')`;
    expect(Array.from(await maintenance.sql`select failure_count from jobs where id = ${id}`)).toEqual([{ failure_count: 0 }]);
    await expect(maintenance.sql`update jobs set failure_count = null where id = ${id}`).rejects.toMatchObject({ code: '23502' });
  } finally { await maintenance.close(); }
});
