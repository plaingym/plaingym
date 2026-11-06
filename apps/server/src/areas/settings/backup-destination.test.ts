// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createS3Client, FakeBackupObjectStore, S3BackupObjectStore } from '../../infra/storage/index.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { probeBackupDestination } from './backup-destination.js';

describe('backup destination probe', () => {
  it('writes, reads and removes a unique object under the gym prefix', async () => {
    const store = new FakeBackupObjectStore();
    const put = vi.spyOn(store, 'putObject'), get = vi.spyOn(store, 'getObject'), remove = vi.spyOn(store, 'deleteObject');
    await probeBackupDestination(store, 'gym-a');
    await probeBackupDestination(store, 'gym-b');
    const names = put.mock.calls.map(([name]) => name);
    expect(names[0]).toMatch(/^gym-a\/backup-probes\//);
    expect(names[1]).toMatch(/^gym-b\/backup-probes\//);
    expect(get.mock.calls.map(([name]) => name)).toEqual(names);
    expect(remove.mock.calls.map(([name]) => name)).toEqual(names);
    expect(await store.listObjects('')).toEqual([]);
  });
  it.each(['list-only', 'read-only', 'write-only', 'cannot-delete', 'corrupt-read'] as const)('refuses %s credentials or storage', async (mode) => {
    const store = new FakeBackupObjectStore();
    if (mode === 'list-only' || mode === 'read-only') vi.spyOn(store, 'putObject').mockRejectedValue(new Error('Forbidden'));
    if (mode === 'list-only' || mode === 'write-only') vi.spyOn(store, 'getObject').mockRejectedValue(new Error('Forbidden'));
    if (mode === 'cannot-delete' || mode === 'list-only' || mode === 'read-only') vi.spyOn(store, 'deleteObject').mockRejectedValue(new Error('Forbidden'));
    if (mode === 'corrupt-read') vi.spyOn(store, 'getObject').mockResolvedValue(new ReadableStream({ start(controller) { controller.close(); } }));
    await expect(probeBackupDestination(store, 'gym-a')).rejects.toThrow();
    if (mode !== 'cannot-delete') expect(await store.listObjects('')).toEqual([]);
  });
  it('reports the first refusal when cleanup is refused too', async () => {
    const store = new FakeBackupObjectStore();
    vi.spyOn(store, 'putObject').mockRejectedValue(new Error('Write refused'));
    vi.spyOn(store, 'deleteObject').mockRejectedValue(new Error('Delete refused'));
    await expect(probeBackupDestination(store, 'gym-a')).rejects.toThrow('Write refused');
  });
  it('passes through the real S3 store and leaves nothing behind', async () => {
    const bucket = await s3Server();
    const client = createS3Client({ endpoint: bucket.endpoint, maxAttempts: 1, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    try {
      await probeBackupDestination(new S3BackupObjectStore({ client, bucket: 'backups' }), 'gym-a');
      expect(bucket.objects.size).toBe(0);
      expect(bucket.uploads.size).toBe(0);
    } finally { client.destroy(); await bucket.close(); }
  });
});
