// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { healthTileSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeBackupObjectStore } from '../../infra/storage/index.js';
import { bytesStream } from './backups.files.js';
import { referenceStream, snapshotPrefix, type Snapshot } from './backups.format.js';
import type { InstallBackupConfig } from './restore.config.js';
import { createBackupHealthProvider } from './status-backups.js';

const database = useTestDatabase(), factory = createFactories(database), gymId = uuidv7(), gymB = uuidv7();
const clock = new TestClock('2026-10-22T12:00:00Z'), context = { gymId, clock, roles: ['owner'] as const };
const settings: InstallBackupConfig = { gymId, recipient: 'age1test', blobKey: Buffer.alloc(32, 9), appEncryptionKey: Buffer.alloc(32, 8),
  budgetBytes: 8_000_000_000, destination: { bucket: 'private-bucket', region: 'auto', accessKeyId: 'private-access', secretAccessKey: 'private-secret' } };
let store: FakeBackupObjectStore;
const close = vi.fn();
const provider = (config: InstallBackupConfig | null = settings) => createBackupHealthProvider({ scope: database.forSystem, config: async () => config,
  store: () => ({ store, close }) });
beforeAll(async () => { await factory('gyms', gymId); await factory('gyms', gymB); });
beforeEach(async () => { await database.forSystem((tx) => tx.delete(backupRuns)); store = new FakeBackupObjectStore(clock); });
async function snapshot(startedAt = clock.now(), status = 'succeeded') {
  const id = uuidv7(), prefix = snapshotPrefix(id);
  const snapshot: Snapshot = { id, version: 1, kind: 'hourly', startedAt: startedAt.toISOString(),
    database: { sha256: 'a'.repeat(64), size: 3 }, manifest: { sha256: 'b'.repeat(64), size: 3 }, uploads: [] };
  await factory('backupRuns', gymId, { id, startedAt, completedAt: clock.now(), status, objectPrefix: prefix, snapshotBytes: 6n, uploadBytes: 0n });
  await store.putObject(prefix + 'database.age', bytesStream('abc'));
  await store.putObject(prefix + 'manifest.age', bytesStream('abc'));
  await store.putObject(prefix + 'references.json', referenceStream(snapshot, settings.blobKey));
  return snapshot;
}
async function read(config?: InstallBackupConfig | null) { return healthTileSchema.parse(await provider(config).read(context)); }

describe('last-backup health', () => {
  it('reads successful restorable snapshots from system history and validates authenticated objects', async () => {
    const recent = await snapshot(new Date('2026-10-22T11:00:00Z'));
    await snapshot(new Date('2026-10-22T11:50:00Z'), 'failed');
    const tile = await read();
    expect(tile).toMatchObject({ id: 'last_backup', status: 'healthy', checkedAt: clock.now().toISOString(),
      details: { latestRestorableAt: recent.startedAt, ageSeconds: 3600, overdue: false, pruningStopped: false, keyReminder: true } });
    expect(close).toHaveBeenCalled();
    expect(JSON.stringify(tile)).not.toMatch(/private-|age1test|snapshots\//);
  });
  it('ignores successful records whose snapshots have been pruned and measures age from the dump start', async () => {
    const retained = await snapshot(new Date('2026-10-22T10:00:00Z'));
    await factory('backupRuns', gymId, { startedAt: clock.now(), completedAt: clock.now(), status: 'succeeded' });
    expect(await read()).toMatchObject({ status: 'healthy', details: { latestRestorableAt: retained.startedAt, ageSeconds: 7200 } });
  });
  it('warns for overdue backups, no snapshots and insufficient retention headroom', async () => {
    expect(await read()).toMatchObject({ status: 'warning', details: { ageSeconds: null, overdue: true } });
    await snapshot(new Date('2026-10-22T09:00:00Z'));
    expect(await read()).toMatchObject({ status: 'warning', details: { ageSeconds: 10800, overdue: true } });
    await snapshot();
    expect(await read({ ...settings, budgetBytes: 1024 })).toMatchObject({ status: 'warning', details: { overdue: false, retentionBudgetBytes: 1024 } });
  });
  it.each(['missing-reference', 'bad-mac', 'missing-manifest', 'missing-blob'] as const)('reports pruning stopped for %s', async (fault) => {
    const record = await snapshot(), prefix = snapshotPrefix(record.id);
    if (fault === 'missing-reference') await store.deleteObject(prefix + 'references.json');
    if (fault === 'missing-manifest') await store.deleteObject(prefix + 'manifest.age');
    if (fault === 'bad-mac') await store.putObject(prefix + 'references.json', bytesStream('{"payload":"bad","mac":"' + 'a'.repeat(64) + '"}'));
    if (fault === 'missing-blob') await store.putObject(prefix + 'references.json', referenceStream({ ...record,
      uploads: [{ blob: 'blobs/' + 'a'.repeat(64) + '.age', protectedHash: 'b'.repeat(64), encrypted: { sha256: 'c'.repeat(64), size: 10 } }] }, settings.blobKey));
    expect(await read()).toMatchObject({ status: 'error', details: { pruningStopped: true, latestRestorableAt: null } });
  });
  it('never opens install history or storage for an unconfigured or different gym', async () => {
    expect(await read(null)).toMatchObject({ status: 'not_configured', details: null });
    const readProvider = provider();
    expect(await readProvider.read({ ...context, gymId: gymB })).toMatchObject({ status: 'not_configured', details: null });
    expect(close).not.toHaveBeenCalled();
  });
});
