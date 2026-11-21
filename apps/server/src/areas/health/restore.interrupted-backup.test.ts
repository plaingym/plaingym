// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { asc, inArray } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test inspects the restored database's backup jobs.
import { backupRuns, jobs, uuidv7 } from '@plaingym/db';
import { setLogSink } from '../../core/log.js';
import { PostgresJobStatsQuery } from '../../infra/jobs/postgres.js';
import { snapshotPrefix } from './backups.format.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const interrupted = 'Interrupted: the run was still in progress when this snapshot was taken';

describe('restoring a snapshot taken during a backup', () => {
  const f = useRestoreFixture();

  /** Seeds the source as a Back up now snapshot finds it: its own job running, plus an older run left running. */
  async function seed() {
    const gymId = f.gymId, now = f.clock.now();
    const backup = await f.make('jobs', gymId, { name: 'health.backup.manual', status: 'running', attempts: 1, maxAttempts: 1,
      runAt: now, lockToken: uuidv7(), lockedUntil: new Date(now.getTime() + 60_000) });
    const charge = await f.make('jobs', gymId, { name: 'billing.runner.charge', status: 'running', attempts: 1,
      runAt: now, lockToken: uuidv7(), lockedUntil: new Date(now.getTime() + 60_000) });
    const olderId = uuidv7();
    await f.make('backupRuns', gymId, { id: olderId, kind: 'hourly', status: 'running',
      startedAt: new Date(now.getTime() - 3_600_000), objectPrefix: snapshotPrefix(olderId) });
    return { backupId: backup.id as string, chargeId: charge.id as string, chargeToken: charge.lockToken as string, olderId };
  }

  const read = (ids: { backupId: string; chargeId: string }) => f.target.forSystem(async tx => ({
    runs: await tx.select().from(backupRuns).orderBy(asc(backupRuns.id)),
    jobs: await tx.select().from(jobs).where(inArray(jobs.id, [ids.backupId, ids.chargeId])).orderBy(asc(jobs.id)),
  }));

  async function expectSettled(snapshotId: string, seeded: Awaited<ReturnType<typeof seed>>) {
    const { runs, jobs: rows } = await read(seeded);
    const run = (id: string) => runs.find(row => row.id === id)!;
    expect(run(snapshotId)).toMatchObject({ status: 'succeeded', completedAt: expect.any(Date), error: null });
    expect(run(seeded.olderId)).toMatchObject({ status: 'failed', completedAt: expect.any(Date), error: interrupted });
    expect(runs.filter(row => row.status === 'running')).toEqual([]);
    const job = (id: string) => rows.find(row => row.id === id)!;
    expect(job(seeded.backupId)).toMatchObject({ status: 'failed', acknowledgedAt: expect.any(Date),
      lastError: 'Interrupted by the restored snapshot', lockToken: null, lockedUntil: null, attempts: 1 });
    expect(job(seeded.chargeId)).toMatchObject({ status: 'running', lockToken: seeded.chargeToken, lastError: null, acknowledgedAt: null });
    expect((await new PostgresJobStatsQuery(f.target).get(f.gymId)).failed).toBe(0);
    return { runs, jobs: rows };
  }

  it('counts the snapshot run as succeeded and fails and acknowledges the interrupted backups', async () => {
    const seeded = await seed();
    const snapshot = await f.backup().snapshot();
    const lines: string[] = [], previous = setLogSink(line => lines.push(line));
    try { await f.restore().restore(snapshot.id, f.identity); } finally { setLogSink(previous); }
    await expectSettled(snapshot.id, seeded);
    expect(lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'restore.backups_settled'))
      .toEqual([expect.objectContaining({ level: 'info', runs: 2, jobs: 1 })]);
  }, 120_000);

  it('reaches the same state on a resumed restore and changes no row when the step repeats', async () => {
    const seeded = await seed();
    const snapshot = await f.backup().snapshot();
    let stopped = false;
    const service = f.restore((phase) => { if (!stopped && phase === 'billing_reconciliation_queued') { stopped = true; throw new Error('Power loss'); } });
    await expect(service.restore(snapshot.id, f.identity)).rejects.toThrow();
    expect(stopped).toBe(true);
    const before = await expectSettled(snapshot.id, seeded);
    const lines: string[] = [], previous = setLogSink(line => lines.push(line));
    try { expect(await f.restore().resume()).toBeUndefined(); } finally { setLogSink(previous); }
    expect(await expectSettled(snapshot.id, seeded)).toEqual(before);
    expect(lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'restore.backups_settled'))
      .toEqual([expect.objectContaining({ runs: 0, jobs: 0 })]);
  }, 120_000);
});
