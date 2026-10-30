// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { registerBackupJobs } from './backups.jobs.js';
import { PostgresMaintenance } from './backups.database.js';
import { inventory } from './backups.retention.js';
import { protectedName, snapshotPrefix } from './backups.format.js';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { dockerTools, useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ source: useTestDatabase(), target: useTestDatabase() });
const { gymId, clock, blobKey } = f;

describe('install snapshot and restore with real Postgres and S3', () => {
  it('deduplicates coincident system-job schedules and runs one install-wide snapshot', async () => {
    const queue = new PostgresJobs({ database: f.source, clock });
    const scheduler = registerBackupJobs(queue, f.backup(), clock);
    await Promise.all([scheduler.scheduleDue(), scheduler.scheduleDue()]);
    expect(await queue.runNext()).toBe(true);
    expect(await queue.runNext()).toBe(false);
    expect((await inventory(f.store, blobKey)).snapshots).toHaveLength(1);
    const paused = new PostgresJobs({ database: f.source, clock });
    const pausedScheduler = registerBackupJobs(paused, f.backup(), clock, async () => true);
    clock.advance(3_600_000);
    await pausedScheduler.scheduleDue();
    expect(await paused.runNext()).toBe(false);
  });

  it('drains an admitted worker waiting for the backup lock before replacing the database', async () => {
    const snapshot = await f.backup().snapshot();
    const gate = f.gate();
    const getObject = f.store.getObject.bind(f.store);
    let worker: Promise<void> | undefined, queued = false, finished = false;
    f.store.getObject = async (key) => {
      if (!queued && key.endsWith('manifest.age')) {
        queued = true;
        let admit!: () => void;
        const admitted = new Promise<void>((resolve) => { admit = resolve; });
        worker = gate.activity(async () => {
          admit();
          await f.targetMaintenance.locked(async () => { finished = true; });
        });
        await admitted;
      }
      return getObject(key);
    };
    try {
      await f.restore((phase) => { if (phase === 'database_restored') expect(finished).toBe(true); }).restore(snapshot.id, f.identity);
      await worker;
      expect(finished).toBe(true);
    } finally { f.store.getObject = getObject; }
  });

  it('keeps upload paths and content hashes inside the encrypted manifest', async () => {
    const snapshot = await f.backup().snapshot();
    const object = f.server.objects.get('backups/' + snapshotPrefix(snapshot.id) + 'references.json')!;
    expect(object.bytes.toString()).not.toContain(gymId);
    expect(object.bytes.toString()).not.toContain('/photo');
    expect(object.bytes.toString()).not.toContain('original upload');
    expect(object.bytes.toString()).not.toContain(createHash('sha256').update('original upload').digest('hex'));
  });

  it('keeps a file deleted while the dump is running in that snapshot', async () => {
    const original = f.sourceMaintenance.dump.bind(f.sourceMaintenance);
    const wrapped = new PostgresMaintenance(f.source.maintenanceUrl, dockerTools);
    wrapped.dump = async () => {
      clock.advance(1); await f.uploads.markDeleted(gymId + '/photo');
      return original();
    };
    const snapshot = await f.backup({ database: wrapped }).snapshot();
    expect(snapshot.uploads.map((u) => u.protectedHash)).toContain(protectedName(blobKey, gymId + '/photo'));
    await f.restore().restore(snapshot.id, f.identity);
  });

  it('retries aborted multipart uploads and records a failure without publishing an incomplete snapshot', async () => {
    f.server.state.failPart = 1;
    await expect(f.backup().snapshot()).rejects.toThrow('Snapshot failed');
    expect(f.server.state.aborted).toBe(3);
    expect(f.server.uploads.size).toBe(0);
    expect(await f.store.listObjects('snapshots/')).toHaveLength(0);
  });

  it('rejects a budget that cannot reserve space without publishing a snapshot', async () => {
    await expect(f.backup({ budgetBytes: 1 }).snapshot()).rejects.toThrow();
    expect(await f.store.listObjects('snapshots/')).toHaveLength(0);
  });
});
