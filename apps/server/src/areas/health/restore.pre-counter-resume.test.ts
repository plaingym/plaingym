// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- The test takes the restored database back to the jobs table before its failure counter.
import { openConnection } from '@plaingym/db/client';
import { decryptSecret } from '../../core/secrets.js';
import { readRestoreJournal } from './restore.gate.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ shared: true });
let snapshotId: string, backupId: string;
beforeAll(async () => {
  snapshotId = (await f.prepare(async () => {
    const now = f.clock.now();
    backupId = (await f.make('jobs', f.gymId, { name: 'health.backup.manual', status: 'running', attempts: 1, maxAttempts: 1,
      runAt: now, lockToken: uuidv7(), lockedUntil: new Date(now.getTime() + 60_000) })).id as string;
    return f.backup().snapshot();
  })).id;
}, 120_000);

/** Runs `query` on the restored database as maintenance, which a table without the counter doesn't trouble. */
async function onTarget<T>(query: (sql: ReturnType<typeof openConnection>['sql']) => Promise<T>): Promise<T> {
  const connection = openConnection(f.target.maintenanceUrl, 1);
  try { return await query(connection.sql); } finally { await connection.close(); }
}
const hasCounter = () => onTarget(async sql => (await sql<{ present: boolean }[]>`select exists (select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'jobs' and column_name = 'failure_count') as present`)[0]!.present);
const state = () => onTarget(async sql => ({
  jobs: Array.from(await sql`select * from jobs order by id`),
  runs: Array.from(await sql`select * from backup_runs order by id`),
  audits: Array.from(await sql`select id, action from audit_events order by id`),
}));
const phase = async () => ((await readRestoreJournal(f.gate().statePath)) as { phase: string }).phase;

describe('resuming a rekeyed restore on a database before the job failure counter', () => {
  it('settles the interrupted backup, queues reconciliation once and keeps the rekeyed data', async () => {
    // An older release restored, migrated and rekeyed, then stopped before settling; its schema has no counter.
    const stopAt = (stop: string) => (reached: string) => { if (reached === stop) throw new Error('Power loss'); };
    await expect(f.restore(stopAt('uploads_switched')).restore(snapshotId, f.identity)).rejects.toThrow();
    expect(await phase()).toBe('uploads_switched');
    await onTarget(sql => sql`alter table jobs drop column failure_count`);
    expect(await hasCounter()).toBe(false);

    // The newer release resumes before its normal migration. The first resume stops after settling and queueing.
    await expect(f.restore(stopAt('billing_reconciliation_queued')).resume()).rejects.toThrow();
    expect(await phase()).toBe('uploads_switched');
    const settled = await state();
    expect(await f.restore().resume()).toBeUndefined();
    expect(await phase()).toBe('complete');
    expect(await state()).toEqual(settled);
    await f.restore().resume();
    expect(await state()).toEqual(settled);
    expect(await f.gate().isClosed()).toBe(false);

    const job = settled.jobs.find(row => row.id === backupId)!;
    expect(job).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Interrupted by the restored snapshot',
      lock_token: null, locked_until: null });
    expect(job.acknowledged_at).not.toBeNull();
    expect(settled.jobs.filter(row => row.status === 'running')).toEqual([]);
    expect(settled.jobs.filter(row => row.name === 'billing.runner.restore')).toEqual([
      expect.objectContaining({ gym_id: f.gymId, status: 'pending', attempts: 0, acknowledged_at: null })]);
    expect(settled.runs.find(row => row.id === snapshotId)).toMatchObject({ status: 'succeeded' });
    expect(settled.runs.filter(row => row.status === 'running')).toEqual([]);
    expect(settled.audits.filter(row => row.action === 'billing.runner.restore_requested')).toHaveLength(1);
    const { gym } = await f.secretRows();
    expect(decryptSecret(f.currentKey, f.context('qr_key'), gym.qrKey!)).toBe('stable-qr-secret');

    // The normal migration then adds the counter: a job settled without it reads no counted failures. The test
    // dropped only the column, so it re-adds it with the job failure count migration's statement, then runs the
    // migration runner (already recorded as applied) for its security and catalog checks.
    await onTarget(sql => sql`ALTER TABLE "jobs" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL`);
    await f.targetMaintenance.migrate();
    expect(await onTarget(sql => sql`select failure_count from jobs where id = ${backupId}`)).toEqual([{ failure_count: 0 }]);
  }, 180_000);
});
