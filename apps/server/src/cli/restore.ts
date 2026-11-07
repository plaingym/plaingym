// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Command } from './index.js';
import { clock } from '../core/clock.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { createS3Client, S3BackupObjectStore } from '../infra/storage/index.js';
import { createRuntimeUploads } from '../infra/storage/runtime.js';
import { readIdentityFile } from '../areas/health/backups.js';
import { snapshotPrefix } from '../areas/health/backups.format.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { BackupsNotConfiguredError, configuredBackup, loadBackupConfig } from '../areas/health/restore.config.js';
import { RestoreService } from '../areas/health/restore.js';
import { RestoreGate } from '../areas/health/restore.gate.js';
import { rotateKey, upgradeStoredSecrets } from './restore.rotate-key.js';
import { issuePaths, restoreFailureReason } from './restore.reason.js';
import { RestoreFailure } from '../areas/health/restore.failure.js';
import { z } from 'zod';
import { logInfo } from '../core/log.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new RestoreFailure('Missing ' + name);
  return value;
}
function currentAppKey(): Buffer {
  const value = required('APP_ENCRYPTION_KEY');
  try { return parseEncryptionKey(value); } catch { throw new RestoreFailure('Invalid current app key'); }
}
export function maintenanceEnvironment() {
  const stagingDirectory = required('BACKUP_STAGING_DIR'), uploadsDirectory = required('UPLOADS_DIR');
  const appEncryptionKey = currentAppKey();
  // The same storage the app uses; maintenance never creates download links.
  const uploads = createRuntimeUploads(process.env, appEncryptionKey, async () => 'https://maintenance.invalid');
  return { database: new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL')),
    appEncryptionKey, stagingDirectory, uploadsDirectory, uploads,
    gate: new RestoreGate(dirname(stagingDirectory)), clock };
}
function restoreOptions(environment: ReturnType<typeof maintenanceEnvironment>) {
  const { uploads, ...options } = environment;
  return { ...options, ...(uploads.restoreStore ? { uploadsStore: uploads.restoreStore } : {}) };
}
export async function maintenanceCommand(args: readonly string[]): Promise<void> {
  if (args[0] === 'migrate') {
    const database = new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL'));
    await database.migrate();
    // Then the one-time v1 to v2 rewrite; both install modes supply the app key to their migrate step.
    if (process.env.APP_ENCRYPTION_KEY) await upgradeStoredSecrets(database, parseEncryptionKey(process.env.APP_ENCRYPTION_KEY));
    else logInfo('secrets.upgrade_skipped', { reason: 'APP_ENCRYPTION_KEY is not configured' });
    return;
  }
  if (args[0] === 'rotate-key') {
    if (args.length !== 1) throw new Error('Usage: rotate-key');
    const staging = process.env.BACKUP_STAGING_DIR;
    await rotateKey({ database: new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL')),
      currentKey: process.env.APP_ENCRYPTION_KEY, newKey: process.env.NEW_APP_ENCRYPTION_KEY,
      gate: staging ? new RestoreGate(dirname(staging)) : null });
    return;
  }
  const environment = maintenanceEnvironment();
  try { await maintenance(args, environment); } finally { environment.uploads.close(); }
}
/** The snapshot command's answer when the owner hasn't set up backups; `update.sh` prints it and changes nothing. */
export class BackupsNotSetUpError extends Error {
  constructor() { super('Backups are not set up: set them up in Settings → Email, payments and backups, then run the update again'); this.name = 'BackupsNotSetUpError'; }
}
async function maintenance(args: readonly string[], environment: ReturnType<typeof maintenanceEnvironment>): Promise<void> {
  if (args[0] === 'snapshot') {
    const config = await loadBackupConfig(environment.appEncryptionKey).catch((error: unknown) => {
      throw error instanceof BackupsNotConfiguredError ? new BackupsNotSetUpError() : error;
    });
    const backup = configuredBackup(config, environment.database, clock, environment.stagingDirectory, environment.uploads.forGym);
    try {
      const snapshot = await backup.service.snapshot(args[1] === 'pre-upgrade' ? 'pre_upgrade' : 'manual');
      process.stdout.write(`Snapshot: ${snapshot.id}\n`);
    }
    finally { backup.client.destroy(); }
    return;
  }
  if (args[0] === 'resume') {
    // Resumption uses already authenticated staging; it never requires saving the private age identity.
    const unusedStore = new S3BackupObjectStore({ client: createS3Client({}), bucket: 'unused' });
    try { await new RestoreService({ ...restoreOptions(environment), store: unusedStore }).resume(); }
    finally { unusedStore.options.client.destroy(); }
    return;
  }
  if (args[0] !== 'restore' || args.length !== 4 || args[2] !== '--config') throw new RestoreFailure('Usage: restore SNAPSHOT --config PRIVATE_JSON_FILE');
  // A fresh install cannot read destination credentials from a database it has not restored yet.
  // This owner-supplied private file contains destination credentials and the age identity file path.
  const config = await readRestoreConfig(args[3]!);
  const id = z.uuid().safeParse(args[1]);
  if (!id.success) throw new RestoreFailure('SNAPSHOT is not a snapshot ID (a UUID)');
  if (config.snapshotId && config.snapshotId !== id.data) throw new RestoreFailure('The restore configuration names a different snapshot than SNAPSHOT');
  const identity = await readIdentityFile(config.identityFile).catch((error: unknown) => {
    throw error instanceof Error && 'code' in error ? new RestoreFailure('Cannot read the key file (' + errorCode(error) + ')') : error;
  });
  const client = createS3Client({ region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  try {
    const store = new S3BackupObjectStore({ client, bucket: config.bucket, clock });
    // Asked first, so a wrong snapshot ID doesn't look like a damaged snapshot.
    if (!await store.headObject(snapshotPrefix(id.data) + 'manifest.age')) throw new RestoreFailure('Snapshot not found in the bucket');
    await new RestoreService({ ...restoreOptions(environment), store }).restore(id.data, identity);
  } finally { client.destroy(); }
}
const errorCode = (error: Error): string => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unreadable';
};
const restoreConfigSchema = z.strictObject({ snapshotId: z.uuid().optional(), bucket: z.string().min(1),
  endpoint: z.url().optional(), region: z.string().default('auto'),
  accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), identityFile: z.string().min(1) });
/** Reads the private restore file; a failure names the error code or the invalid fields, never a value. */
async function readRestoreConfig(path: string): Promise<z.infer<typeof restoreConfigSchema>> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    throw new RestoreFailure('Cannot read the restore configuration file (' + (error instanceof Error ? errorCode(error) : 'unreadable') + ')');
  });
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new RestoreFailure('The restore configuration file is not valid JSON'); }
  const parsed = restoreConfigSchema.safeParse(json);
  if (!parsed.success) throw new RestoreFailure('The restore configuration file has invalid fields: ' + issuePaths(parsed.error));
  return parsed.data;
}
export async function reportRestoreResume(stderr: (line: string) => void = (line) => process.stderr.write(line + '\n')): Promise<void> {
  const staging = process.env.BACKUP_STAGING_DIR;
  if (staging && await new RestoreGate(dirname(staging)).hasStagedRestore())
    stderr('A verified restore can be resumed with the maintenance CLI');
}
export const commands: readonly Command[] = [{
  id: 'migrate', description: 'Apply database migrations as the maintenance role',
  async run(_args, io) {
    if (!process.env.MAINTENANCE_DATABASE_URL) { io.stderr('Set MAINTENANCE_DATABASE_URL (see .env.example)'); return 1; }
    try { await maintenanceCommand(['migrate']); io.stdout('Database migrated'); return 0; }
    catch (error) { io.stderr('Migration failed: ' + (error instanceof RestoreFailure ? error.message : error instanceof Error ? error.name : 'unknown error')); return 1; }
  },
}, {
  id: 'restore', description: 'Restore an authenticated encrypted install snapshot',
  async run(args, io) {
    try { await maintenanceCommand(['restore', ...args]); io.stdout('Restore complete; billing remains paused'); return 0; }
    catch (error) {
      io.stderr('Restore failed: ' + restoreFailureReason(error));
      await reportRestoreResume(io.stderr);
      return 1;
    }
  },
}];
