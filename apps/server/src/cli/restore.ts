// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Command } from './index.js';
import { clock } from '../core/clock.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { createS3Client, S3BackupObjectStore } from '../infra/storage/index.js';
import { createRuntimeUploads } from '../infra/storage/runtime.js';
import { readIdentityFile } from '../areas/health/backups.js';
import { readReferences, snapshotPrefix, verifyReferences } from '../areas/health/backups.format.js';
import { SnapshotContentError } from '../areas/health/backups.content.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { BackupsNotConfiguredError, configuredBackup, loadBackupConfig } from '../areas/health/restore.config.js';
import { RestoreFailure } from '../areas/health/restore.failure.js';
import { z } from 'zod';
import { logInfo } from '../core/log.js';

export const snapshotCheckTimeoutMs = 30_000;

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
    appEncryptionKey, stagingDirectory, uploadsDirectory, uploads, clock };
}
// These imports stay in the maintenance bundle and initialize only when the command needs them.
async function restoreOptions(environment: ReturnType<typeof maintenanceEnvironment>) {
  const { RestoreGate } = await import('../areas/health/restore.gate.js');
  const { uploads, ...options } = environment;
  return { ...options,
    gate: new RestoreGate(dirname(options.stagingDirectory), {
      onDrainWait: pid => process.stderr.write('Waiting for restore activity in PID ' + pid + ' to finish\n'),
    }), ...(uploads.restoreStore ? { uploadsStore: uploads.restoreStore } : {}) };
}
export async function maintenanceCommand(args: readonly string[]): Promise<void> {
  if (args[0] === 'restore-files') {
    if (args.length !== 2 || !z.uuid().safeParse(args[1]).success) throw new RestoreFailure('Usage: restore-files SNAPSHOT');
    const { withRestoreFiles } = await import('./restore.files.js');
    await withRestoreFiles(process.stdin, dirname(required('BACKUP_STAGING_DIR')),
      path => maintenanceCommand(['restore', args[1]!, '--config', path]));
    process.stdout.write('Restore complete; billing, member emails and member texts remain off; backup pruning is on hold\n');
    return;
  }
  if (args[0] === 'migrate') {
    const database = new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL'));
    await database.migrate();
    // Then the one-time v1 to v2 rewrite; both install modes supply the app key to their migrate step.
    if (process.env.APP_ENCRYPTION_KEY) {
      const { upgradeStoredSecrets } = await import('./restore.rotate-key.js');
      await upgradeStoredSecrets(database, parseEncryptionKey(process.env.APP_ENCRYPTION_KEY));
    } else logInfo('secrets.upgrade_skipped', { reason: 'APP_ENCRYPTION_KEY is not configured' });
    return;
  }
  if (args[0] === 'rotate-key') {
    if (args.length !== 1) throw new Error('Usage: rotate-key');
    const staging = process.env.BACKUP_STAGING_DIR;
    const { rotateKey } = await import('./restore.rotate-key.js');
    const { RestoreGate } = await import('../areas/health/restore.gate.js');
    await rotateKey({ database: new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL')),
      currentKey: process.env.APP_ENCRYPTION_KEY, newKey: process.env.NEW_APP_ENCRYPTION_KEY,
      gate: staging ? new RestoreGate(dirname(staging)) : null });
    return;
  }
  if (args[0] === 'restore-connect') {
    // Lifts rotate-key's fence; deploy/rotate-key.sh decides when that is safe.
    if (args.length !== 1) throw new Error('Usage: restore-connect');
    await new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL')).restoreAppConnect();
    process.stdout.write('The app role can connect again\n');
    return;
  }
  const environment = maintenanceEnvironment();
  try { await maintenance(args, environment); } finally { environment.uploads.close(); }
}
/** The snapshot command's answer when the owner hasn't set up backups; `update.sh` prints it and changes nothing. */
export class BackupsNotSetUpError extends Error {
  constructor() { super('Backups are not set up: set them up in Settings → Integrations, then run the update again'); this.name = 'BackupsNotSetUpError'; }
}
async function maintenance(args: readonly string[], environment: ReturnType<typeof maintenanceEnvironment>): Promise<void> {
  if (args[0] === 'snapshot-check') {
    if (args.length !== 2 || !z.uuid().safeParse(args[1]).success) throw new RestoreFailure('Usage: snapshot-check SNAPSHOT');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backup: ReturnType<typeof configuredBackup> | undefined, finished = false;
    try {
      const found = await Promise.race([
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Snapshot availability check timed out')), snapshotCheckTimeoutMs); }),
        (async () => {
          const config = await loadBackupConfig(environment.appEncryptionKey);
          // Configuration may finish after the deadline. Do not open a client after cleanup.
          if (finished) return false;
          backup = configuredBackup(config, environment.database, clock, environment.stagingDirectory, environment.uploads.forGym);
          const prefix = snapshotPrefix(args[1]!);
          let snapshot;
          try { snapshot = verifyReferences(await readReferences(backup.store, prefix + 'references.json'), config.blobKey, args[1]!); }
          catch (error) { if (error instanceof SnapshotContentError || error instanceof z.ZodError) return false; throw error; }
          for (const [key, size] of [[prefix + 'database.age', snapshot.database.size], [prefix + 'manifest.age', snapshot.manifest.size],
            ...snapshot.uploads.map(upload => [upload.blob, upload.encrypted.size] as const)] as const) {
            if ((await backup.store.headObject(key))?.size !== size) return false;
          }
          return true;
        })(),
      ]);
      process.stdout.write(found ? 'Snapshot availability: available\n' : 'Snapshot availability: missing or incomplete\n');
    } finally { finished = true; clearTimeout(timer); backup?.client.destroy(); }
    return;
  }
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
    const { RestoreService } = await import('../areas/health/restore.js');
    // Resumption uses already authenticated staging; it never requires saving the private age identity.
    const unusedStore = new S3BackupObjectStore({ client: createS3Client({}), bucket: 'unused' });
    try { await new RestoreService({ ...await restoreOptions(environment), store: unusedStore }).resume(); }
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
  const { RestoreService } = await import('../areas/health/restore.js');
  const identity = await readIdentityFile(config.identityFile).catch((error: unknown) => {
    throw error instanceof Error && 'code' in error ? new RestoreFailure('Cannot read the key file (' + errorCode(error) + ')') : error;
  });
  const client = createS3Client({ region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  try {
    const store = new S3BackupObjectStore({ client, bucket: config.bucket, clock });
    // Asked first, so a wrong snapshot ID doesn't look like a damaged snapshot.
    if (!await store.headObject(snapshotPrefix(id.data) + 'manifest.age')) throw new RestoreFailure('Snapshot not found in the bucket');
    await new RestoreService({ ...await restoreOptions(environment), store }).restore(id.data, identity);
  } finally { client.destroy(); }
}
const errorCode = (error: Error): string => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unreadable';
};
/** Reads the private restore file; a failure names the error code or the invalid fields, never a value. */
async function readRestoreConfig(path: string) {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    throw new RestoreFailure('Cannot read the restore configuration file (' + (error instanceof Error ? errorCode(error) : 'unreadable') + ')');
  });
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new RestoreFailure('The restore configuration file is not valid JSON'); }
  const restoreConfigSchema = z.strictObject({ snapshotId: z.uuid().optional(), bucket: z.string().min(1),
    endpoint: z.url().optional(), region: z.string().default('auto'),
    accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), identityFile: z.string().min(1) });
  const parsed = restoreConfigSchema.safeParse(json);
  if (!parsed.success) {
    const { issuePaths } = await import('./restore.reason.js');
    throw new RestoreFailure('The restore configuration file has invalid fields: ' + issuePaths(parsed.error));
  }
  return parsed.data;
}
export async function reportRestoreResume(stderr: (line: string) => void = (line) => process.stderr.write(line + '\n')): Promise<void> {
  const staging = process.env.BACKUP_STAGING_DIR;
  if (!staging) return;
  const { RestoreGate } = await import('../areas/health/restore.gate.js');
  if (await new RestoreGate(dirname(staging)).hasStagedRestore())
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
    try { await maintenanceCommand(['restore', ...args]); io.stdout('Restore complete; billing, member emails and member texts remain off; backup pruning is on hold'); return 0; }
    catch (error) {
      const { restoreFailureReason } = await import('./restore.reason.js');
      io.stderr('Restore failed: ' + restoreFailureReason(error));
      await reportRestoreResume(io.stderr);
      return 1;
    }
  },
}];
