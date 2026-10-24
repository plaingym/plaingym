// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { forSystem, gyms } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { createS3Client, S3BackupObjectStore, type Uploads } from '../../infra/storage/index.js';
import { decryptSecret, parseEncryptionKey } from '../../core/secrets.js';
import { BackupService } from './backups.js';
import { PostgresMaintenance } from './backups.database.js';

const destinationSchema = z.strictObject({
  bucket: z.string().min(1), endpoint: z.url().optional(), region: z.string().default('auto'),
  accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1),
});
export interface InstallBackupConfig {
  readonly recipient: string; readonly blobKey: Buffer; readonly appEncryptionKey: Buffer;
  readonly budgetBytes: number; readonly destination: z.infer<typeof destinationSchema>;
  readonly gymId: string;
}
/** Owner configuration is read in system context; credentials remain encrypted on the gym row. */
export async function loadBackupConfig(appKey: Buffer): Promise<InstallBackupConfig> {
  const rows = await forSystem((tx) => tx.select().from(gyms));
  if (rows.length !== 1) throw new Error('Install snapshots require exactly one configured gym');
  const gym = rows[0]!;
  if (!gym.backupPublicKey || !gym.backupBlobKey || !gym.s3Config || !gym.backupDestination)
    throw new Error('Backup destination and public key are not configured');
  const credentials = z.object({ accessKeyId: z.string(), secretAccessKey: z.string() })
    .parse(JSON.parse(decryptSecret(appKey, 's3_config', gym.s3Config)));
  const destination = destinationSchema.parse({ ...gym.backupDestination as object, ...credentials });
  const budgetBytes = Number(gym.backupRetentionBytes ?? 8_000_000_000n);
  if (!Number.isSafeInteger(budgetBytes)) throw new Error('Invalid retention budget');
  return { recipient: gym.backupPublicKey, blobKey: parseEncryptionKey(decryptSecret(appKey, 'backup_blob_key', gym.backupBlobKey)),
    appEncryptionKey: appKey, budgetBytes, destination, gymId: gym.id };
}
const notConfigured = ['Backup destination and public key are not configured', 'Install snapshots require exactly one configured gym'];
/** Whether this install takes snapshots. Only an unconfigured install answers false; other failures throw. */
export async function backupsConfigured(appKey: Buffer): Promise<boolean> {
  try { await loadBackupConfig(appKey); return true; }
  catch (error) { if (error instanceof Error && notConfigured.includes(error.message)) return false; throw error; }
}
/** `uploadsFor` is the runtime storage resolver, so snapshots capture uploads wherever the install keeps them. */
export function configuredBackup(config: InstallBackupConfig, database: PostgresMaintenance,
  clock: Clock, stagingDirectory: string, uploadsFor: (gymId: string) => Promise<Uploads>) {
  const client = createS3Client({ region: config.destination.region,
    ...(config.destination.endpoint ? { endpoint: config.destination.endpoint } : {}),
    credentials: { accessKeyId: config.destination.accessKeyId, secretAccessKey: config.destination.secretAccessKey } });
  const store = new S3BackupObjectStore({ client, bucket: config.destination.bucket, clock });
  return { client, store, service: new BackupService({ database, store, clock, recipient: config.recipient,
    appEncryptionKey: config.appEncryptionKey, blobKey: config.blobKey, budgetBytes: config.budgetBytes,
    stagingDirectory, uploads: async () => new Map([[config.gymId, await uploadsFor(config.gymId)]]) }) };
}
