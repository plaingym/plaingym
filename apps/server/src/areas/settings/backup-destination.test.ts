// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { inventory, pruneUnlocked } from '../health/backups.retention.js';
import { createS3Client, FakeBackupObjectStore, S3BackupObjectStore } from '../../infra/storage/index.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { probeBackupDestination } from './backup-destination.js';

describe('backup destination probe', () => {
  it('lists, writes, reads and removes a unique object under the prefixes snapshots use', async () => {
    const store = new FakeBackupObjectStore();
    const put = vi.spyOn(store, 'putObject'), get = vi.spyOn(store, 'getObject'), remove = vi.spyOn(store, 'deleteObject');
    const list = vi.spyOn(store, 'listObjects');
    await probeBackupDestination(store);
    await probeBackupDestination(store);
    const names = put.mock.calls.map(([name]) => name);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^blobs\/probe-[0-9a-f-]{36}$/);
    expect(names[0]).not.toBe(names[1]);
    expect(get.mock.calls.map(([name]) => name)).toEqual(names);
    expect(remove.mock.calls.map(([name]) => name)).toEqual(names);
    expect(list.mock.calls.map(([prefix]) => prefix.split('/')[0])).toEqual(['snapshots', 'blobs', 'snapshots', 'blobs']);
    expect(await store.listObjects('')).toEqual([]);
  });
  it('leaves a probe whose cleanup failed to pruning, without stopping it', async () => {
    const store = new FakeBackupObjectStore(), blobKey = randomBytes(32);
    const remove = vi.spyOn(store, 'deleteObject').mockRejectedValueOnce(new Error('Delete refused'));
    await expect(probeBackupDestination(store)).rejects.toThrow('Delete refused');
    remove.mockRestore();
    expect((await store.listObjects('blobs/')).map((object) => object.key)).toEqual([expect.stringMatching(/^blobs\/probe-/)]);
    expect((await inventory(store, blobKey)).suspect).toEqual([]);
    await pruneUnlocked(store, blobKey, new Map(), new Date());
    expect(await store.listObjects('')).toEqual([]);
  });
  it.each(['list-only', 'read-only', 'write-only', 'cannot-delete', 'corrupt-read'] as const)('refuses %s credentials or storage', async (mode) => {
    const store = new FakeBackupObjectStore();
    if (mode === 'list-only' || mode === 'read-only') vi.spyOn(store, 'putObject').mockRejectedValue(new Error('Forbidden'));
    if (mode === 'list-only' || mode === 'write-only') vi.spyOn(store, 'getObject').mockRejectedValue(new Error('Forbidden'));
    if (mode === 'cannot-delete' || mode === 'list-only' || mode === 'read-only') vi.spyOn(store, 'deleteObject').mockRejectedValue(new Error('Forbidden'));
    if (mode === 'corrupt-read') vi.spyOn(store, 'getObject').mockResolvedValue(new ReadableStream({ start(controller) { controller.close(); } }));
    await expect(probeBackupDestination(store)).rejects.toThrow();
    if (mode !== 'cannot-delete') expect(await store.listObjects('')).toEqual([]);
  });
  it('reports the first refusal when cleanup is refused too', async () => {
    const store = new FakeBackupObjectStore();
    vi.spyOn(store, 'putObject').mockRejectedValue(new Error('Write refused'));
    vi.spyOn(store, 'deleteObject').mockRejectedValue(new Error('Delete refused'));
    await expect(probeBackupDestination(store)).rejects.toThrow('Write refused');
  });
  it('passes through the real S3 store and leaves nothing behind', async () => {
    const bucket = await s3Server();
    const client = createS3Client({ endpoint: bucket.endpoint, maxAttempts: 1, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    try {
      await probeBackupDestination(new S3BackupObjectStore({ client, bucket: 'backups' }));
      expect(bucket.objects.size).toBe(0);
      expect(bucket.uploads.size).toBe(0);
    } finally { client.destroy(); await bucket.close(); }
  });
});
