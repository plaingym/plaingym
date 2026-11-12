// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { AppError } from '@plaingym/shared';
import type { CreateBackupKeyRequest } from '@plaingym/shared/contracts';
import { createS3Client, S3BackupObjectStore, type BackupObjectStore } from '../../infra/storage/index.js';
import { logError } from '../../core/log.js';

export type CheckBackupDestination = (destination: CreateBackupKeyRequest['destination'], gymId: string) => Promise<void>;

/**
 * A unique, non-sensitive probe where snapshots write, so credentials scoped to `snapshots/` and `blobs/` pass and
 * ones that can't write there don't. It lists an unused snapshot prefix, then writes, reads back and deletes a blob
 * named `blobs/probe-<uuid>`: no snapshot references it and no blob is named that way (theirs are hex digests), so
 * a probe whose cleanup failed doesn't stop pruning, which deletes it with the other unreferenced blobs. It never
 * touches a snapshot or an existing object.
 */
export async function probeBackupDestination(store: BackupObjectStore): Promise<void> {
  const id = randomUUID(), name = `blobs/probe-${id}`;
  const value = new TextEncoder().encode('PlainGym backup destination check');
  await store.listObjects(`snapshots/${id}/`);
  await store.listObjects(name);
  try {
    await store.putObject(name, new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value); controller.close(); } }));
    const body = await store.getObject(name);
    if (!body) throw new Error('Backup probe is missing');
    let offset = 0;
    for await (const chunk of body) {
      if (offset + chunk.length > value.length || chunk.some((byte, index) => byte !== value[offset + index]))
        throw new Error('Backup probe does not match');
      offset += chunk.length;
    }
    if (offset !== value.length) throw new Error('Backup probe is incomplete');
  } catch (error) {
    // A failed write may still have reached storage; the logged reason stays this first failure.
    await store.deleteObject(name).catch(() => undefined);
    throw error;
  }
  // Delete permission is required too: a destination that cannot prune is not usable.
  await store.deleteObject(name);
}

const checkBackupDestination: CheckBackupDestination = async (destination) => {
  const client = createS3Client({ region: destination.region, endpoint: destination.endpoint,
    credentials: { accessKeyId: destination.accessKeyId, secretAccessKey: destination.secretAccessKey } });
  try { await probeBackupDestination(new S3BackupObjectStore({ client, bucket: destination.bucket })); }
  finally { client.destroy(); }
};

/** Both owner flows refuse before generating or saving a key, with the same public reason. */
export async function requireBackupDestination(destination: CreateBackupKeyRequest['destination'], gymId: string,
  check: CheckBackupDestination = checkBackupDestination): Promise<void> {
  try { await check(destination, gymId); }
  catch (error) {
    logError('settings.backup_destination_check_failed', { gymId }, error);
    throw new AppError('invalid_request', 'The storage destination refused the request', { destination: ['unreachable'] });
  }
}
