// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { RestoreService } from './restore.js';
import { S3Uploads } from '../../infra/storage/index.js';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ source: useTestDatabase(), target: useTestDatabase() }, { shared: true });
const { clock, gymId } = f;
const bucketUploads = (bucket = 'uploads') => new S3Uploads({ client: f.client, bucket, gymId, clock });
const storeRestore = (bucket = 'uploads', checkpoint?: ConstructorParameters<typeof RestoreService>[0]['checkpoint']) =>
  new RestoreService({ ...f.restore(checkpoint).options, uploadsStore: async (id) => new S3Uploads({ client: f.client, bucket, gymId: id, clock }) });
let snapshotId: string;
// The snapshot of an install whose uploads live in an S3 bucket, shared by the tests below.
beforeAll(async () => {
  snapshotId = (await f.prepare(async () => {
    await bucketUploads().put(gymId + '/s3-photo', Buffer.from('S3 source bytes'), 'image/png');
    return f.backup({ uploads: async () => new Map([[gymId, bucketUploads()]]) }).snapshot();
  })).id;
});

describe('into an install that keeps uploads in S3', () => {
  it('revives files deleted after the snapshot and marks later files deleted, leaving the uploads directory alone', async () => {
    clock.advance(60_000);
    await bucketUploads().markDeleted(gymId + '/s3-photo');
    await bucketUploads().put(gymId + '/later', Buffer.from('uploaded after the snapshot'), 'text/plain');
    await storeRestore().restore(snapshotId, f.identity);
    const restored = bucketUploads();
    expect(await new Response(await restored.get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
    expect((await restored.head(gymId + '/s3-photo'))!.deletedAt).toBeUndefined();
    expect((await restored.head(gymId + '/later'))!.deletedAt).toEqual(clock.now());
    const directory = f.restoredUploads();
    expect(await new Response(await directory.get(gymId + '/sentinel')).text()).toBe('live upload sentinel');
    expect(await directory.head(gymId + '/s3-photo')).toBeNull();
  });
  it('publishes every file into an empty bucket on a new server', async () => {
    await storeRestore('uploads-new').restore(snapshotId, f.identity);
    const restored = bucketUploads('uploads-new');
    expect(await restored.head(gymId + '/s3-photo')).toMatchObject({ contentType: 'image/png', createdAt: clock.now() });
    expect(await new Response(await restored.get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
  });
  it.each(['old_uploads_renamed', 'new_uploads_renamed'] as const)('resumes after interruption at %s', async (stop) => {
    let interrupted = false;
    await expect(storeRestore('uploads-new', (phase) => { if (!interrupted && phase === stop) { interrupted = true; throw new Error('Power loss'); } })
      .restore(snapshotId, f.identity)).rejects.toThrow('Power loss');
    // A restore journaled for the bucket never finishes into the directory.
    await expect(f.restore().resume()).rejects.toThrow('Upload storage changed');
    await storeRestore('uploads-new').resume();
    expect(await new Response(await bucketUploads('uploads-new').get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
    expect(await f.gate().isClosed()).toBe(false);
  });
});
