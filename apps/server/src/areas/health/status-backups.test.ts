// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { healthTileSchema, type HealthTile } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeBackupObjectStore } from '../../infra/storage/index.js';
import { bytesStream } from './backups.files.js';
import { referenceStream, snapshotPrefix, type Snapshot } from './backups.format.js';
import type { InstallBackupConfig } from './restore.config.js';
import * as configuration from './restore.config.js';
import { createBackupHealthProvider } from './status-backups.js';
import * as retention from './backups.retention.js';

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
async function snapshot(startedAt = clock.now(), status = 'succeeded', recipient: string | null = settings.recipient) {
  const id = uuidv7(), prefix = snapshotPrefix(id);
  const snapshot: Snapshot = { id, version: 1, kind: 'hourly', startedAt: startedAt.toISOString(),
    database: { sha256: 'a'.repeat(64), size: 3 }, manifest: { sha256: 'b'.repeat(64), size: 3 }, uploads: [], ...(recipient ? { recipient } : {}) };
  await factory('backupRuns', gymId, { id, startedAt, completedAt: clock.now(), status, objectPrefix: prefix, snapshotBytes: 6n, uploadBytes: 0n });
  await store.putObject(prefix + 'database.age', bytesStream('abc'));
  await store.putObject(prefix + 'manifest.age', bytesStream('abc'));
  await store.putObject(prefix + 'references.json', referenceStream(snapshot, settings.blobKey));
  return snapshot;
}
async function read(config?: InstallBackupConfig | null) { return healthTileSchema.parse(await provider(config).read(context)); }

describe('last-backup health', () => {
  it.each([1, 31])('names a damaged %s-day-old guard using the injected environment, even after pruning resumes', async days => {
    const record = { ...await snapshot(new Date(clock.now().getTime() - days * 86_400_000)), kind: 'pre_upgrade' as const };
    await store.putObject(snapshotPrefix(record.id) + 'references.json', referenceStream(record, settings.blobKey));
    await store.deleteObject(snapshotPrefix(record.id) + 'manifest.age');
    const latest = await snapshot();
    const health = createBackupHealthProvider({ scope: database.forSystem, config: async () => settings,
      env: { SCHEMA_ROLLBACK_FLOOR: 'v1.2.0', SCHEMA_SNAPSHOT: record.id }, store: () => ({ store, close }) });
    expect(healthTileSchema.parse(await health.read(context))).toMatchObject({ status: days === 1 ? 'error' : 'warning',
      message: expect.stringContaining(days === 1 ? 'inventory could not be verified' : 'rollback snapshot is damaged'),
      details: { damagedGuardSnapshot: record.id, pruningStopped: days === 1, latestRestorableAt: days === 1 ? null : latest.startedAt } });
  });
  it.each(['removed', 'pruned'] as const)('keeps warning after the guard snapshot is %s', async cause => {
    const guard = { ...await snapshot(new Date(clock.now().getTime() - 31 * 86_400_000)), kind: 'pre_upgrade' as const };
    await store.putObject(snapshotPrefix(guard.id) + 'references.json', referenceStream(guard, settings.blobKey));
    const latest = await snapshot(), env = { SCHEMA_ROLLBACK_FLOOR: 'v1.2.0', SCHEMA_SNAPSHOT: guard.id };
    if (cause === 'pruned') {
      await store.deleteObject(snapshotPrefix(guard.id) + 'manifest.age');
      await retention.pruneUnlocked(store, settings.blobKey, new Map(), clock.now(), 0, settings.budgetBytes,
        clock.now(), undefined, guard.id);
    } else {
      for (const name of ['database.age', 'manifest.age', 'references.json']) await store.deleteObject(snapshotPrefix(guard.id) + name);
    }
    const health = createBackupHealthProvider({ scope: database.forSystem, config: async () => settings, env,
      store: () => ({ store, close }) });
    expect(healthTileSchema.parse(await health.read(context))).toMatchObject({ status: 'warning',
      message: expect.stringContaining('rollback snapshot is missing'), details: { missingGuardSnapshot: guard.id,
        damagedGuardSnapshot: null, pruningStopped: false, latestRestorableAt: latest.startedAt } });
    // The updater writes `-` for a guard that names no restore point: nothing is missing, and the tile still parses.
    env.SCHEMA_SNAPSHOT = '-';
    expect(healthTileSchema.parse(await health.read(context))).toMatchObject({ status: 'healthy', details: { missingGuardSnapshot: null } });
    delete (env as NodeJS.ProcessEnv).SCHEMA_ROLLBACK_FLOOR;
    expect(healthTileSchema.parse(await health.read(context))).toMatchObject({ status: 'healthy', details: { missingGuardSnapshot: null } });
  });
  it('keeps the overdue headline above a damaged or missing rollback warning', async () => {
    const guard = { ...await snapshot(new Date(clock.now().getTime() - 31 * 86_400_000)), kind: 'pre_upgrade' as const };
    await store.putObject(snapshotPrefix(guard.id) + 'references.json', referenceStream(guard, settings.blobKey));
    await store.deleteObject(snapshotPrefix(guard.id) + 'manifest.age');
    await snapshot(new Date(clock.now().getTime() - 3 * 3_600_000));
    const health = createBackupHealthProvider({ scope: database.forSystem, config: async () => settings,
      env: { SCHEMA_ROLLBACK_FLOOR: 'v1.2.0', SCHEMA_SNAPSHOT: guard.id }, store: () => ({ store, close }) });
    expect(await health.read(context)).toMatchObject({ status: 'warning', message: expect.stringContaining('overdue'),
      details: { damagedGuardSnapshot: guard.id } });
    for (const name of ['database.age', 'references.json']) await store.deleteObject(snapshotPrefix(guard.id) + name);
    expect(await health.read(context)).toMatchObject({ status: 'warning', message: expect.stringContaining('overdue'),
      details: { missingGuardSnapshot: guard.id } });
  });
  it('passes the injected guard through to retention for an old complete restore point', async () => {
    const guard = { ...await snapshot(new Date(clock.now().getTime() - 60 * 86_400_000)), kind: 'pre_upgrade' as const };
    await store.putObject(snapshotPrefix(guard.id) + 'references.json', referenceStream(guard, settings.blobKey));
    await snapshot();
    const plan = vi.spyOn(retention, 'prunePlan');
    try {
      const health = createBackupHealthProvider({ scope: database.forSystem, config: async () => settings,
        env: { SCHEMA_ROLLBACK_FLOOR: 'v1.2.0', SCHEMA_SNAPSHOT: guard.id }, store: () => ({ store, close }) });
      expect(await health.read(context)).toMatchObject({ status: 'healthy' });
      expect(plan).toHaveBeenCalledWith(expect.anything(), clock.now(), guard.id);
      expect(plan.mock.results[0]!.value.keep.has(guard.id)).toBe(true);
    } finally { plan.mockRestore(); }
  });
  it('reports a restore pruning hold without treating a complete snapshot as damaged', async () => {
    const complete = await snapshot();
    expect(await read({ ...settings, pruningHeld: true })).toMatchObject({ status: 'warning',
      message: expect.stringMatching(/pruning is on hold.*retention budget/),
      details: { pruningHeld: true, pruningStopped: false, latestRestorableAt: complete.startedAt } });
  });
  it('keeps the overdue message while the pruning hold is on', async () => {
    await snapshot(new Date(clock.now().getTime() - 3 * 3_600_000));
    expect(await read({ ...settings, pruningHeld: true })).toMatchObject({ status: 'warning',
      message: expect.stringMatching(/overdue/), details: { pruningHeld: true, overdue: true } });
  });
  it('does not call an old-key or legacy snapshot restorable under a replacement key', async () => {
    await snapshot(new Date('2026-10-22T11:00:00Z'));
    const changed = { ...settings, recipient: 'age1replacement' };
    expect(await read(changed)).toMatchObject({ status: 'warning', details: { latestRestorableAt: null, noneUnderCurrentKey: true } });
    const current = await snapshot(new Date('2026-10-22T11:30:00Z'), 'succeeded', changed.recipient);
    await snapshot(new Date('2026-10-22T11:45:00Z')); // A later old-key run must not win.
    await snapshot(clock.now(), 'succeeded', null); // Legacy lists remain valid but have an unknown recipient.
    expect(await read(changed)).toMatchObject({ status: 'healthy', details: { latestRestorableAt: current.startedAt, noneUnderCurrentKey: false } });
    store = new FakeBackupObjectStore(clock); // A different destination has no objects from the previous bucket.
    expect(await read({ ...changed, destination: { ...changed.destination, bucket: 'new-bucket' } })).toMatchObject({
      status: 'warning', details: { latestRestorableAt: null, noneUnderCurrentKey: true } });
  });
  class Reworded extends configuration.BackupsNotConfiguredError { override message = 'Reworded diagnostic'; }
  it.each([new Reworded(), new configuration.InstallBackupGymCountError()])(
    'recognizes unconfigured backups by type', async (error) => {
      const spy = vi.spyOn(configuration, 'loadBackupConfig').mockRejectedValue(error);
      try {
        const health = createBackupHealthProvider({ env: { APP_ENCRYPTION_KEY: 'ab'.repeat(32) } });
        expect(await health.read(context)).toMatchObject({ status: 'not_configured' });
      } finally { spy.mockRestore(); }
    });
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
  it('sizes the next snapshot from the newest one under any key', async () => {
    await snapshot();
    const changed = { ...settings, recipient: 'age1replacement' };
    const { details } = await read(changed) as Extract<HealthTile, { id: 'last_backup' }>;
    const roomForAllButTheSnapshot = details!.retainedBytes + 128 * 1024 * 1024 + 5; // The fixture's snapshot is 6 bytes.
    expect(await read({ ...changed, budgetBytes: roomForAllButTheSnapshot })).toMatchObject({ status: 'warning', message: expect.stringContaining('retention budget') });
    expect(await read({ ...changed, budgetBytes: roomForAllButTheSnapshot + 1 })).toMatchObject({ details: { noneUnderCurrentKey: true }, message: expect.not.stringContaining('retention budget') });
  });
  it.each(['missing-reference', 'bad-mac', 'missing-manifest', 'missing-blob'] as const)('reports pruning stopped for %s', async (fault) => {
    const record = await snapshot(), prefix = snapshotPrefix(record.id);
    if (fault === 'missing-reference') await store.deleteObject(prefix + 'references.json');
    if (fault === 'missing-manifest') await store.deleteObject(prefix + 'manifest.age');
    if (fault === 'bad-mac') await store.putObject(prefix + 'references.json', bytesStream('{"payload":"bad","mac":"' + 'a'.repeat(64) + '"}'));
    if (fault === 'missing-blob') await store.putObject(prefix + 'references.json', referenceStream({ ...record,
      uploads: [{ blob: 'blobs/' + 'a'.repeat(64) + '.age', protectedHash: 'b'.repeat(64), encrypted: { sha256: 'c'.repeat(64), size: 10 } }] }, settings.blobKey));
    expect(await read()).toMatchObject({ status: 'error', details: { pruningStopped: true, latestRestorableAt: null, destinationFailure: null } });
  });
  it('names a destination that rejects the storage credentials, without its error text', async () => {
    await snapshot();
    const rejected = Object.assign(new Error('upstream says private-access is invalid'), { name: 'Unauthorized', $metadata: { httpStatusCode: 401 } });
    vi.spyOn(store, 'listObjects').mockRejectedValue(rejected);
    const tile = await read();
    expect(tile).toMatchObject({ status: 'error', message: expect.stringContaining('rejected the storage credentials'),
      details: { pruningStopped: true, latestRestorableAt: null, destinationFailure: 'credentials_rejected' } });
    expect(JSON.stringify(tile)).not.toMatch(/upstream|private-/);
  });
  it.each([['an unverified inventory', new retention.UnverifiedInventory('Pruning stopped')], ['any other error', new Error('disk full')]])(
    'keeps the pruning-stopped message for %s', async (_, error) => {
      await snapshot();
      vi.spyOn(store, 'listObjects').mockRejectedValue(error);
      expect(await read()).toMatchObject({ status: 'error', message: expect.stringContaining('inventory could not be verified'),
        details: { pruningStopped: true, destinationFailure: null } });
    });
  it('reports no destination failure for a healthy destination', async () => {
    await snapshot();
    expect(await read()).toMatchObject({ status: 'healthy', details: { destinationFailure: null } });
  });
  it('never opens install history or storage for an unconfigured or different gym', async () => {
    expect(await read(null)).toMatchObject({ status: 'not_configured', details: null });
    const readProvider = provider();
    expect(await readProvider.read({ ...context, gymId: gymB })).toMatchObject({ status: 'not_configured', details: null });
    expect(close).not.toHaveBeenCalled();
  });
});
