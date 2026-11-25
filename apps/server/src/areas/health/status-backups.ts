// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { backupRuns, forSystem } from '@plaingym/db';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createS3Client, S3BackupObjectStore, type BackupObjectStore } from '../../infra/storage/index.js';
import { isBackupsUnconfigured, loadBackupConfig, type InstallBackupConfig } from './restore.config.js';
import { guardSnapshot, inventory, prunePlan, UnverifiedInventory, type BackupInventory, type RunStatuses } from './backups.retention.js';
import { backupHealthGeneration } from './backups.health-cache.js';
import { healthProvider, healthReadAgeMs, statusMessage } from './status.js';
import { backupFailureCause, type BackupFailureCause } from './backups.failure.js';

const causeMessages: Record<Exclude<BackupFailureCause, 'other'>, string> = {
  credentials_rejected: 'backupCredentialsRejected', bucket_missing: 'backupBucketMissing', endpoint_unreachable: 'backupEndpointUnreachable',
};

export function createBackupHealthProvider(options: {
  env?: NodeJS.ProcessEnv;
  scope?: typeof forSystem;
  config?: () => Promise<InstallBackupConfig | null>;
  store?: (config: InstallBackupConfig) => { store: BackupObjectStore; close(): void };
  maxLoadingAgeMs?: number;
} = {}) {
  const maxLoadingAgeMs = options.maxLoadingAgeMs ?? healthReadAgeMs;
  const env = options.env ?? process.env, scope = options.scope ?? forSystem;
  const config = options.config ?? (async () => {
    if (env.TENANCY === 'multi') return null;
    try { return await loadBackupConfig(parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? '')); }
    catch (error) { if (isBackupsUnconfigured(error)) return null; throw error; }
  });
  const open = options.store ?? ((settings: InstallBackupConfig) => {
    const client = createS3Client({ region: settings.destination.region,
      ...(settings.destination.endpoint ? { endpoint: settings.destination.endpoint } : {}),
      credentials: { accessKeyId: settings.destination.accessKeyId, secretAccessKey: settings.destination.secretAccessKey } });
    return { store: new S3BackupObjectStore({ client, bucket: settings.destination.bucket }), close: () => client.destroy() };
  });
  const runStatuses: RunStatuses = async (prefixes) => new Map((await scope((tx) => tx
    .select({ prefix: backupRuns.objectPrefix, status: backupRuns.status }).from(backupRuns)
    .where(inArray(backupRuns.objectPrefix, [...prefixes])))).map((run) => [run.prefix, run.status]));
  // Only the inventory is reused, never the tile: ages and rules are computed from it on every read.
  // The key covers the destination, the keys, the runs and the backup generation; only its hash is kept.
  let cached: { key: string; storedAt: number; seq: number; state: BackupInventory } | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let nextSeq = 0;
  type LoadingEntry = { startedAt: number; load: Promise<BackupInventory>; close: () => void };
  const loading = new Map<string, LoadingEntry>();
  const replacedLoads = new Map<string, LoadingEntry>();
  const cachedInventory = (settings: InstallBackupConfig, key: string, now: () => number, readStart: number): Promise<BackupInventory> => {
    const at = now();
    const isStale = (startedAt: number) => {
      const age = at - startedAt;
      return age > maxLoadingAgeMs || age < 0;
    };
    const evictOtherKeys = (map: Map<string, LoadingEntry>) => {
      for (const [entryKey, entry] of map) {
        if (entryKey !== key && isStale(entry.startedAt)) {
          entry.close();
          map.delete(entryKey);
        }
      }
    };
    // Evict stale loads under superseded keys even on a cache hit so a fast listing under the new key does not keep them open.
    evictOtherKeys(loading);
    evictOtherKeys(replacedLoads);
    if (cached && cached.key === key && at - cached.storedAt >= 0 && at - cached.storedAt < 60_000) {
      return Promise.resolve(cached.state);
    }
    const inFlight = loading.get(key);
    if (inFlight && !isStale(inFlight.startedAt)) return inFlight.load;
    if (inFlight) {
      replacedLoads.get(key)?.close();
      replacedLoads.set(key, inFlight);
    }
    let close = () => undefined;
    const load = (async () => {
      const destination = open(settings);
      let closed = false;
      close = () => {
        if (closed) return;
        closed = true;
        destination.close();
      };
      try { return await inventory(destination.store, settings.blobKey, runStatuses); }
      finally { close(); }
    })();
    const seq = ++nextSeq;
    const entry: LoadingEntry = { startedAt: readStart, load, close };
    loading.set(key, entry);
    // A failed load is never cached; a load the page gave up on, or one a fresh load replaced, still serves the
    // next refresh unless a load that started later has already been stored.
    load.then((state) => {
      if (cached && cached.seq > seq) return;
      cached = { key, storedAt: readStart, seq, state };
      // Drop the inventory once it is stale instead of holding the listings until the next read.
      if (expiry) clearTimeout(expiry);
      const stored = cached;
      expiry = setTimeout(() => { if (cached === stored) cached = null; expiry = undefined; }, Math.min(60_000, Math.max(0, 60_000 - (now() - readStart))));
      expiry.unref();
    }, () => undefined)
      .finally(() => {
        if (loading.get(key) === entry) loading.delete(key);
        if (replacedLoads.get(key) === entry) replacedLoads.delete(key);
      });
    return load;
  };
  return healthProvider('last_backup', async (context) => {
    const readStart = context.clock.now().getTime();
    const settings = await config(), checkedAt = context.clock.now().toISOString();
    // Install-wide snapshot history is never disclosed to another tenant.
    if (!settings || settings.gymId !== context.gymId) return { id: 'last_backup', status: 'not_configured', checkedAt, details: null, message: statusMessage('backupMissing') };
    const { runs, newestRun } = await scope(async (tx) => ({
      runs: await tx.select({ id: backupRuns.id, startedAt: backupRuns.startedAt })
        .from(backupRuns).where(eq(backupRuns.status, 'succeeded')).orderBy(desc(backupRuns.startedAt)),
      newestRun: (await tx.select({ id: backupRuns.id, status: backupRuns.status }).from(backupRuns)
        .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id)).limit(1))[0],
    }));
    const { endpoint, region, bucket, accessKeyId, secretAccessKey } = settings.destination;
    const key = createHash('sha256').update(JSON.stringify([settings.gymId, endpoint ?? '', region, bucket, accessKeyId, secretAccessKey,
      settings.recipient, settings.blobKey.toString('base64'), newestRun ? newestRun.id + ':' + newestRun.status : '', runs.length,
      backupHealthGeneration()])).digest('hex');
    let damagedGuardSnapshot: string | null = null;
    let missingGuardSnapshot: string | null = null;
    try {
      const state = await cachedInventory(settings, key, () => context.clock.now().getTime(), readStart);
      // An abandoned run is cleaned up by the next prune; only what stops pruning is reported.
      const floorSnapshot = guardSnapshot(env);
      damagedGuardSnapshot = state.damaged.find(snapshot => snapshot.id === floorSnapshot)?.id ?? null;
      missingGuardSnapshot = floorSnapshot && !damagedGuardSnapshot && !state.snapshots.some(snapshot => snapshot.id === floorSnapshot)
        ? floorSnapshot : null;
      if (prunePlan(state, context.clock.now(), floorSnapshot).stopped) throw new UnverifiedInventory('Pruning stopped');
      const latest = runs.find((run) => state.snapshots.some((snapshot) => snapshot.id === run.id && snapshot.recipient === settings.recipient));
      const retainedBytes = [...state.objects, ...state.blobs].reduce((total, object) => total + object.size, 0);
      const ageSeconds = latest ? Math.max(0, Math.floor((context.clock.now().getTime() - latest.startedAt.getTime()) / 1000)) : null;
      const overdue = ageSeconds === null || ageSeconds > 7200;
      // Any key's newest snapshot sizes the next one: the database doesn't shrink when the key changes.
      const newest = runs.find((run) => state.snapshots.some((snapshot) => snapshot.id === run.id));
      const newestSnapshot = state.snapshots.find((snapshot) => snapshot.id === newest?.id);
      const nextSnapshotBytes = newestSnapshot ? newestSnapshot.database.size + newestSnapshot.manifest.size : 0;
      const capacity = retainedBytes + nextSnapshotBytes + 128 * 1024 * 1024 > settings.budgetBytes;
      return { id: 'last_backup', status: overdue || capacity || settings.pruningHeld || damagedGuardSnapshot || missingGuardSnapshot ? 'warning' : 'healthy', checkedAt,
        // The hold message names the budget, so it explains capacity too; it never hides a missing or overdue snapshot.
        message: statusMessage(capacity ? (settings.pruningHeld ? 'backupPruningHeld' : 'backupCapacity') : !latest ? 'backupNoneUnderKey'
          : overdue ? 'backupOverdue' : settings.pruningHeld ? 'backupPruningHeld'
          : damagedGuardSnapshot ? 'backupDamagedGuardHeadline' : missingGuardSnapshot ? 'backupMissingGuardHeadline' : 'backupHealthy'),
        details: { latestRestorableAt: latest?.startedAt.toISOString() ?? null, ageSeconds, overdue,
          noneUnderCurrentKey: !latest, retainedBytes, retentionBudgetBytes: settings.budgetBytes, pruningStopped: false,
          pruningHeld: settings.pruningHeld ?? false, damagedGuardSnapshot, missingGuardSnapshot, destinationFailure: null, keyReminder: true } };
    } catch (error) {
      // The authenticated inventory is also pruning's safety check. Do not claim a snapshot is restorable when it fails.
      // A destination that refused the check names its cause class; anything else is an unverifiable inventory.
      const cause = backupFailureCause(error), destinationFailure = cause === 'other' ? null : cause;
      return { id: 'last_backup', status: 'error', checkedAt, message: statusMessage(destinationFailure ? causeMessages[destinationFailure] : 'backupPruningStopped'),
        details: { latestRestorableAt: null, ageSeconds: null, overdue: true, retainedBytes: 0,
          noneUnderCurrentKey: false, retentionBudgetBytes: settings.budgetBytes, pruningStopped: true,
          pruningHeld: settings.pruningHeld ?? false, damagedGuardSnapshot, missingGuardSnapshot, destinationFailure, keyReminder: true } };
    }
  });
}
