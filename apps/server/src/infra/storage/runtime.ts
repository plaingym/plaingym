// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { idSchema } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { LocalUploads, S3Uploads, S3BackupObjectStore, createS3Client } from './index.js';
import type { Uploads } from './index.js';
import { createUploadPrefixCleaner } from '../../demo/storage.js';
import { demoUploads } from '../../demo/uploads.js';

/** Local download links are served by `core/uploads-download.ts`. */
export const uploadDownloadPath = '/api/uploads/download';

export function createRuntimeUploads(env: NodeJS.ProcessEnv, key: Buffer, origin: (gymId: string) => Promise<string>) {
  const bucket = env.UPLOADS_S3_BUCKET;
  if (env.TENANCY === 'multi' && !bucket) throw new Error('TENANCY=multi requires UPLOADS_S3_BUCKET');
  const client = bucket ? createS3Client({ region: env.UPLOADS_S3_REGION ?? 'auto',
    ...(env.UPLOADS_S3_ENDPOINT ? { endpoint: env.UPLOADS_S3_ENDPOINT } : {}),
    ...(env.UPLOADS_S3_ACCESS_KEY_ID && env.UPLOADS_S3_SECRET_ACCESS_KEY ? {
      credentials: { accessKeyId: env.UPLOADS_S3_ACCESS_KEY_ID, secretAccessKey: env.UPLOADS_S3_SECRET_ACCESS_KEY },
    } : {}),
  }) : undefined;
  async function unwrapped(gymId: string): Promise<Uploads> {
      idSchema.parse(gymId);
      let uploads: Uploads;
      if (client && bucket) uploads = new S3Uploads({ client, bucket, gymId });
      else {
        if (!env.UPLOADS_DIR) throw new Error('Set UPLOADS_DIR');
        uploads = new LocalUploads({ root: env.UPLOADS_DIR, gymId, signingKey: key,
          downloadUrl: new URL(uploadDownloadPath, await origin(gymId)).href });
      }
      return uploads;
  }
  return {
    async forGym(gymId: string): Promise<Uploads> {
      const uploads = await unwrapped(gymId);
      return env.DEMO_MODE === 'true' ? demoUploads(uploads) : uploads;
    },
    /** Trusted seed composition only; never inject into request-facing features. */
    forSeed: unwrapped,
    /** Restore writes a snapshot's files back into the bucket; directory installs swap the uploads tree instead. */
    restoreStore: client && bucket ? async (gymId: string) => new S3Uploads({ client, bucket, gymId: idSchema.parse(gymId) }) : undefined,
    async removeGym(gymId: string): Promise<void> {
      assertNoTransaction('storage.deleteGym');
      idSchema.parse(gymId);
      if (client && bucket) return createUploadPrefixCleaner(new S3BackupObjectStore({ client, bucket }))(gymId);
      if (!env.UPLOADS_DIR) return;
      const root = resolve(env.UPLOADS_DIR), target = resolve(root, createHash('sha256').update(gymId).digest('hex'));
      if (dirname(target) !== root) throw new Error('Invalid upload directory');
      await rm(target, { recursive: true, force: true });
    },
    close() { client?.destroy(); },
  };
}
