// SPDX-License-Identifier: AGPL-3.0-only
import { desc, eq, inArray } from 'drizzle-orm';
import { backupRuns, forSystem } from '@plaingym/db';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createS3Client, S3BackupObjectStore, type BackupObjectStore } from '../../infra/storage/index.js';
import { loadBackupConfig, type InstallBackupConfig } from './restore.config.js';
import { inventory, prunePlan, UnverifiedInventory } from './backups.retention.js';
import { healthProvider, statusMessage } from './status.js';

export function createBackupHealthProvider(options: {
  env?: NodeJS.ProcessEnv;
  scope?: typeof forSystem;
  config?: () => Promise<InstallBackupConfig | null>;
  store?: (config: InstallBackupConfig) => { store: BackupObjectStore; close(): void };
} = {}) {
  const env = options.env ?? process.env, scope = options.scope ?? forSystem;
  const config = options.config ?? (async () => {
    if (env.TENANCY === 'multi') return null;
    try { return await loadBackupConfig(parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? '')); }
    catch (error) {
      if (error instanceof Error && ['Backup destination and public key are not configured', 'Install snapshots require exactly one configured gym'].includes(error.message)) return null;
      throw error;
    }
  });
  const open = options.store ?? ((settings: InstallBackupConfig) => {
    const client = createS3Client({ region: settings.destination.region,
      ...(settings.destination.endpoint ? { endpoint: settings.destination.endpoint } : {}),
      credentials: { accessKeyId: settings.destination.accessKeyId, secretAccessKey: settings.destination.secretAccessKey } });
    return { store: new S3BackupObjectStore({ client, bucket: settings.destination.bucket }), close: () => client.destroy() };
  });
  return healthProvider('last_backup', async (context) => {
    const settings = await config(), checkedAt = context.clock.now().toISOString();
    // Install-wide snapshot history is never disclosed to another tenant.
    if (!settings || settings.gymId !== context.gymId) return { id: 'last_backup', status: 'not_configured', checkedAt, details: null, message: statusMessage('backupMissing') };
    const runs = await scope((tx) => tx.select({ id: backupRuns.id, startedAt: backupRuns.startedAt })
      .from(backupRuns).where(eq(backupRuns.status, 'succeeded')).orderBy(desc(backupRuns.startedAt)));
    const destination = open(settings);
    try {
      const state = await inventory(destination.store, settings.blobKey, async (prefixes) => new Map((await scope((tx) => tx
        .select({ prefix: backupRuns.objectPrefix, status: backupRuns.status }).from(backupRuns)
        .where(inArray(backupRuns.objectPrefix, [...prefixes])))).map((run) => [run.prefix, run.status])));
      // An abandoned run is cleaned up by the next prune; only what stops pruning is reported.
      if (prunePlan(state, context.clock.now()).stopped) throw new UnverifiedInventory('Pruning stopped');
      const latest = runs.find((run) => state.snapshots.some((snapshot) => snapshot.id === run.id));
      const blobs = await destination.store.listObjects('blobs/');
      const retainedBytes = [...state.objects, ...blobs].reduce((total, object) => total + object.size, 0);
      const ageSeconds = latest ? Math.max(0, Math.floor((context.clock.now().getTime() - latest.startedAt.getTime()) / 1000)) : null;
      const overdue = ageSeconds === null || ageSeconds > 7200;
      const latestSnapshot = state.snapshots.find((snapshot) => snapshot.id === latest?.id);
      const nextSnapshotBytes = latestSnapshot ? latestSnapshot.database.size + latestSnapshot.manifest.size : 0;
      const capacity = retainedBytes + nextSnapshotBytes + 128 * 1024 * 1024 > settings.budgetBytes;
      return { id: 'last_backup', status: overdue || capacity ? 'warning' : 'healthy', checkedAt,
        message: statusMessage(capacity ? 'backupCapacity' : overdue ? 'backupOverdue' : 'backupHealthy'),
        details: { latestRestorableAt: latest?.startedAt.toISOString() ?? null, ageSeconds, overdue,
          retainedBytes, retentionBudgetBytes: settings.budgetBytes, pruningStopped: false, keyReminder: true } };
    } catch {
      // The authenticated inventory is also pruning's safety check. Do not claim a snapshot is restorable when it fails.
      return { id: 'last_backup', status: 'error', checkedAt, message: statusMessage('backupPruningStopped'),
        details: { latestRestorableAt: null, ageSeconds: null, overdue: true, retainedBytes: 0,
          retentionBudgetBytes: settings.budgetBytes, pruningStopped: true, keyReminder: true } };
    } finally { destination.close(); }
  });
}
