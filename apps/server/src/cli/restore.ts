// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Command } from './index.js';
import { clock } from '../core/clock.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { createS3Client, S3BackupObjectStore } from '../infra/storage/index.js';
import { readIdentityFile } from '../areas/health/backups.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { configuredBackup, loadBackupConfig } from '../areas/health/restore.config.js';
import { RestoreService } from '../areas/health/restore.js';
import { RestoreGate } from '../areas/health/restore.gate.js';
import { z } from 'zod';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing ' + name);
  return value;
}
export function maintenanceEnvironment() {
  const stagingDirectory = required('BACKUP_STAGING_DIR'), uploadsDirectory = required('UPLOADS_DIR');
  return { database: new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL')),
    appEncryptionKey: parseEncryptionKey(required('APP_ENCRYPTION_KEY')), stagingDirectory, uploadsDirectory,
    gate: new RestoreGate(dirname(stagingDirectory)), clock };
}
export async function maintenanceCommand(args: readonly string[]): Promise<void> {
  if (args[0] === 'migrate') { await new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL')).migrate(); return; }
  const environment = maintenanceEnvironment();
  if (args[0] === 'snapshot') {
    const config = await loadBackupConfig(environment.appEncryptionKey);
    const backup = configuredBackup(config, environment.database, clock, environment.stagingDirectory, environment.uploadsDirectory);
    try { await backup.service.snapshot(args[1] === 'pre-upgrade' ? 'pre_upgrade' : 'manual'); }
    finally { backup.client.destroy(); }
    return;
  }
  if (args[0] === 'resume') {
    // Resumption uses already authenticated staging; it never requires saving the private age identity.
    const unusedStore = new S3BackupObjectStore({ client: createS3Client({}), bucket: 'unused' });
    try { await new RestoreService({ ...environment, store: unusedStore }).resume(); }
    finally { unusedStore.options.client.destroy(); }
    return;
  }
  if (args[0] !== 'restore' || args.length !== 4 || args[2] !== '--config') throw new Error('Usage: restore SNAPSHOT --config PRIVATE_JSON_FILE');
  // A fresh install cannot read destination credentials from a database it has not restored yet.
  // This owner-supplied private file contains destination credentials and the age identity file path.
  const config = z.strictObject({ snapshotId: z.uuid().optional(), bucket: z.string().min(1),
    endpoint: z.url().optional(), region: z.string().default('auto'),
    accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), identityFile: z.string().min(1) })
    .parse(JSON.parse(await readFile(args[3]!, 'utf8')));
  const id = z.uuid().parse(args[1]);
  if (config.snapshotId && config.snapshotId !== id) throw new Error('Restore configuration names a different snapshot');
  const client = createS3Client({ region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  try {
    const store = new S3BackupObjectStore({ client, bucket: config.bucket, clock });
    await new RestoreService({ ...environment, store }).restore(id, await readIdentityFile(config.identityFile));
  } finally { client.destroy(); }
}
export const commands: readonly Command[] = [{
  id: 'restore', description: 'Restore an authenticated encrypted install snapshot',
  async run(args, io) {
    try { await maintenanceCommand(['restore', ...args]); io.stdout('Restore complete; billing remains paused'); return 0; }
    catch { io.stderr('Restore failed; verified restores can be resumed with the maintenance CLI'); return 1; }
  },
}];
