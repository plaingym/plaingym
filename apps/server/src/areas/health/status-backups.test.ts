// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { invalidateBackupHealth } from './backups.health-cache.js';

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
    invalidateBackupHealth(); // The objects changed behind the tile's back; a real prune drops the cached inventory.
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
  it('lists each prefix once for one tile read', async () => {
    await snapshot();
    const list = vi.spyOn(store, 'listObjects');
    expect(await read()).toMatchObject({ status: 'healthy' });
    expect(list.mock.calls.map(([prefix]) => prefix).sort()).toEqual(['blobs/', 'snapshots/']);
  });
});

describe('last-backup inventory cache', () => {
  const start = '2026-10-22T12:00:00Z';
  afterEach(() => { clock.set(start); });
  const age = (tile: HealthTile) => (tile as Extract<HealthTile, { id: 'last_backup' }>).details!.ageSeconds;
  const storeCalls = (list: { mock: { calls: unknown[] } }, get: { mock: { calls: unknown[] } }) => list.mock.calls.length + get.mock.calls.length;
  it('reuses the inventory for under a minute and computes the tile again on each read', async () => {
    await snapshot();
    const health = provider(), list = vi.spyOn(store, 'listObjects'), get = vi.spyOn(store, 'getObject');
    const first = healthTileSchema.parse(await health.read(context));
    expect(first).toMatchObject({ status: 'healthy' });
    const calls = storeCalls(list, get);
    expect(calls).toBeGreaterThan(0);
    clock.advance(30_000);
    const second = healthTileSchema.parse(await health.read(context));
    expect(storeCalls(list, get)).toBe(calls);
    expect(age(second)).toBe(age(first)! + 30);
    clock.set(new Date(new Date(start).getTime() + 61_000));
    await health.read(context);
    expect(list).toHaveBeenCalledTimes(4);
  });
  it('drops the stored inventory 60 seconds after it is stored, on an unref-ed timer', async () => {
    await snapshot();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const health = provider(), list = vi.spyOn(store, 'listObjects');
      await health.read(context);
      const expiries = timers.mock.results.filter((_, index) => timers.mock.calls[index]?.[1] === 60_000)
        .map((result, index) => ({ timer: result.value as NodeJS.Timeout, run: timers.mock.calls.filter((call) => call[1] === 60_000)[index]![0] as () => void }));
      expect(expiries).toHaveLength(1);
      expect(expiries[0]!.timer.hasRef()).toBe(false);
      expect(list).toHaveBeenCalledTimes(2);
      clock.advance(30_000);
      await health.read(context);
      expect(list).toHaveBeenCalledTimes(2);
      expiries[0]!.run();
      await health.read(context);
      expect(list).toHaveBeenCalledTimes(4);
    } finally { timers.mockRestore(); }
  });
  it('reads the bucket again after a new run or a finished backup or prune', async () => {
    await snapshot();
    const health = provider(), list = vi.spyOn(store, 'listObjects');
    await health.read(context);
    expect(list).toHaveBeenCalledTimes(2);
    await health.read(context);
    expect(list).toHaveBeenCalledTimes(2);
    await factory('backupRuns', gymId, { startedAt: clock.now(), completedAt: clock.now(), status: 'succeeded' });
    await health.read(context);
    expect(list).toHaveBeenCalledTimes(4);
    invalidateBackupHealth();
    await health.read(context);
    expect(list).toHaveBeenCalledTimes(6);
  });
  it('never caches a failed inventory', async () => {
    await snapshot();
    const health = provider(), list = vi.spyOn(store, 'listObjects').mockRejectedValueOnce(new Error('disk full'));
    expect(await health.read(context)).toMatchObject({ status: 'error', details: { pruningStopped: true } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(await health.read(context)).toMatchObject({ status: 'healthy' });
    expect(list).toHaveBeenCalledTimes(3);
  });
  it('shares one inventory between reads started together', async () => {
    await snapshot();
    const health = provider(), list = vi.spyOn(store, 'listObjects');
    const tiles = await Promise.all([health.read(context), health.read(context)]);
    expect(tiles.map((tile) => tile.status)).toEqual(['healthy', 'healthy']);
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('replaces a never-resolving listing after 30 s and discards its late resolution', async () => {
    await snapshot();
    const realList = store.listObjects.bind(store);
    let listCalls = 0;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    let resolveFirst!: (keys: Awaited<ReturnType<typeof realList>>) => void;
    vi.spyOn(store, 'listObjects').mockImplementation((prefix) => {
      listCalls++;
      if (listCalls === 1) {
        enteredFirst();
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return realList(prefix);
    });
    let scopeDone: (() => void) | undefined;
    const health = createBackupHealthProvider({
      scope: async (fn) => { try { return await database.forSystem(fn); } finally { scopeDone?.(); } },
      config: async () => settings,
      store: () => ({ store, close }),
    });
    const first = health.read(context);
    await firstEntered;
    expect(listCalls).toBe(1);
    clock.advance(10_000);
    const waitScope = new Promise<void>((resolve) => { scopeDone = resolve; });
    const second = health.read(context);
    await waitScope;
    await Promise.resolve();
    expect(listCalls).toBe(1);
    clock.advance(21_000);
    const third = health.read(context);
    expect(await third).toMatchObject({ status: 'healthy' });
    expect(listCalls).toBe(3);
    resolveFirst([]);
    await Promise.all([first, second]);
    expect(await health.read(context)).toMatchObject({ status: 'healthy' });
    expect(listCalls).toBe(4);
  });
  it('expires a slow listing 60 s after its start and caches a listing over 60 s for 0 ms', async () => {
    await snapshot();
    const realList = store.listObjects.bind(store);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      let release!: () => void;
      let entered!: () => void;
      let waitEntered = new Promise<void>((resolve) => { entered = resolve; });
      vi.spyOn(store, 'listObjects').mockImplementation(async (prefix) => {
        if (prefix === 'snapshots/') {
          entered();
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return realList(prefix);
      });
      const health = provider();
      const first = health.read(context);
      await waitEntered;
      clock.advance(20_000);
      release();
      expect(await first).toMatchObject({ status: 'healthy' });
      const forty = timers.mock.calls.filter((call) => call[1] === 40_000);
      expect(forty).toHaveLength(1);
      (forty[0]![0] as () => void)();
      waitEntered = new Promise<void>((resolve) => { entered = resolve; });
      const second = health.read(context);
      await waitEntered;
      clock.advance(70_000);
      release();
      expect(await second).toMatchObject({ status: 'healthy' });
      expect(timers.mock.calls.some((call) => call[1] === 0)).toBe(true);
    } finally { timers.mockRestore(); }
  });
});
