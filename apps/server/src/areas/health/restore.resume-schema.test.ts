// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- The test takes the restored database back to the schema of an earlier release.
import { openConnection } from '@plaingym/db/client';
import { exists } from './backups.files.js';
import { readRestoreJournal } from './restore.gate.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ shared: true });
const otherGym = uuidv7();
let snapshotId: string, snapshotAt: string, backupId: string;
beforeAll(async () => {
  const snapshot = await f.prepare(async () => {
    await f.make('gyms', otherGym, { billingEnabled: true });
    const now = f.clock.now();
    backupId = (await f.make('jobs', f.gymId, { name: 'health.backup.manual', status: 'running', attempts: 1, maxAttempts: 1,
      runAt: now, lockToken: uuidv7(), lockedUntil: new Date(now.getTime() + 60_000) })).id as string;
    return f.backup().snapshot();
  });
  snapshotId = snapshot.id; snapshotAt = snapshot.startedAt;
}, 120_000);

/** Runs `query` on the restored database as maintenance, which a table missing later columns doesn't trouble. */
async function onTarget<T>(query: (sql: ReturnType<typeof openConnection>['sql']) => Promise<T>): Promise<T> {
  const connection = openConnection(f.target.maintenanceUrl, 1);
  try { return await query(connection.sql); } finally { await connection.close(); }
}
const state = () => onTarget(async sql => ({
  jobs: Array.from(await sql`select * from jobs order by id`),
  runs: Array.from(await sql`select * from backup_runs order by id`),
  audits: Array.from(await sql`select * from audit_events order by id`),
}));
const journal = async () => (await readRestoreJournal(f.gate().statePath)) as { id: string; phase: string };
const stopAt = (stop: string) => (reached: string) => { if (reached === stop) throw new Error('Power loss'); };
/** The queue stores a caller's idempotency key hashed with the job name. */
const storedKey = (name: string, key: string) => createHash('sha256').update(JSON.stringify([name, key])).digest('hex');
const before0039 ='This restore was started by a release before v0.8.0; resume it with that release, then update';

/** The reconciliation each restored gym holds after a resume, and the settled manual backup. */
async function expectReconciled() {
  const settled = await state();
  for (const gymId of [f.gymId, otherGym]) {
    const receipts = settled.audits.filter(row => row.gym_id === gymId && row.action === 'restore.completed');
    expect(receipts).toHaveLength(1);
    const requested = settled.audits.filter(row => row.gym_id === gymId && row.action === 'billing.runner.restore_requested');
    expect(requested).toEqual([expect.objectContaining({ actor_kind: 'system', actor_user_id: null, actor_device_id: null,
      target_type: 'restore', target_id: receipts[0]!.id, after: { snapshotAt } })]);
    // This connection reads timestamps as text.
    expect(new Date(requested[0]!.occurred_at as string)).toEqual(f.clock.now());
    expect(settled.jobs.filter(row => row.gym_id === gymId && row.name === 'billing.runner.restore')).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 0, acknowledged_at: null,
        idempotency_key: storedKey('billing.runner.restore', `restore:${receipts[0]!.id}`),
        payload: expect.objectContaining({ value: { restoreId: receipts[0]!.id, snapshotAt } }) })]);
  }
  const job = settled.jobs.find(row => row.id === backupId)!;
  expect(job).toMatchObject({ status: 'failed', last_error: 'Interrupted by the restored snapshot', lock_token: null, locked_until: null });
  expect(job.acknowledged_at).not.toBeNull();
  expect(settled.jobs.filter(row => row.status === 'running')).toEqual([]);
  expect(settled.runs.find(row => row.id === snapshotId)).toMatchObject({ status: 'succeeded' });
  expect(settled.runs.filter(row => row.status === 'running')).toEqual([]);
  return settled;
}

describe('resuming a restore an earlier release stopped after rekeying', () => {
  it('refuses a schema before the job acknowledgement, changing nothing, and resumes once the columns exist', async () => {
    await expect(f.restore(stopAt('rekeyed')).restore(snapshotId, f.identity)).rejects.toThrow();
    const { id, phase } = await journal();
    expect(phase).toBe('rekeyed');
    await onTarget(sql => sql`alter table jobs drop column failure_count, drop column acknowledged_at`);
    const before = await state();

    await expect(f.restore().resume()).rejects.toThrow(before0039);
    expect(await journal()).toMatchObject({ id, phase: 'rekeyed' });
    expect(await exists(join(f.root, 'target', 'uploads') + '.previous-' + id)).toBe(false);
    expect(await f.gate().isClosed()).toBe(true);
    expect(await state()).toEqual(before);

    await onTarget(sql => sql`alter table jobs add column acknowledged_at timestamptz,
      add column failure_count integer not null default 0`);
    expect(await f.restore().resume()).toBeUndefined();
    expect((await journal()).phase).toBe('complete');
    expect(await f.gate().isClosed()).toBe(false);
  }, 180_000);

  it('publishes reconciliation on a schema without a later audit or job column, once', async () => {
    await expect(f.restore(stopAt('uploads_switched')).restore(snapshotId, f.identity)).rejects.toThrow();
    expect((await journal()).phase).toBe('uploads_switched');
    await onTarget(sql => sql`alter table audit_events drop column before`);
    await onTarget(sql => sql`alter table jobs drop column failure_count`);

    expect(await f.restore().resume()).toBeUndefined();
    expect((await journal()).phase).toBe('complete');
    const settled = await expectReconciled();
    await f.restore().resume();
    expect(await state()).toEqual(settled);
    expect(await f.gate().isClosed()).toBe(false);
  }, 180_000);

  it('publishes the same reconciliation on the current schema', async () => {
    await expect(f.restore(stopAt('uploads_switched')).restore(snapshotId, f.identity)).rejects.toThrow();
    expect((await journal()).phase).toBe('uploads_switched');

    expect(await f.restore().resume()).toBeUndefined();
    expect((await journal()).phase).toBe('complete');
    const settled = await expectReconciled();
    expect(settled.jobs.filter(row => row.name === 'billing.runner.restore').map(row => row.failure_count)).toEqual([0, 0]);
    expect(settled.audits.filter(row => row.action === 'billing.runner.restore_requested').map(row => row.before)).toEqual([null, null]);
    await f.restore().resume();
    expect(await state()).toEqual(settled);
  }, 180_000);
});
