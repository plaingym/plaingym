// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateIdentity, identityToRecipient } from '../infra/age/index.js';
import { createS3Client, S3BackupObjectStore } from '../infra/storage/index.js';
import { s3Server } from '../infra/storage/s3-server.test-helper.js';
import { bytesStream } from '../areas/health/backups.files.js';
import { referenceStream, snapshotPrefix, type Snapshot } from '../areas/health/backups.format.js';
import * as configuration from '../areas/health/restore.config.js';
import { commands, maintenanceCommand, snapshotCheckTimeoutMs } from './restore.js';

let directory: string, server: Awaited<ReturnType<typeof s3Server>>, recipient: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'snapshot-check-'));
  server = await s3Server();
  recipient = await identityToRecipient(await generateIdentity());
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('BACKUP_STAGING_DIR', join(directory, 'staging'));
  vi.stubEnv('UPLOADS_DIR', join(directory, 'uploads'));
  // Availability checks read the bucket; they never connect as maintenance or invoke database tools.
  vi.stubEnv('MAINTENANCE_DATABASE_URL', 'postgres://maintenance:unused@127.0.0.1:1/unused');
});
afterAll(async () => { vi.unstubAllEnvs(); await server.close(); await rm(directory, { recursive: true, force: true }); });

it.each(['available', 'missing', 'incomplete', 'tampered', 'missing-blob', 'truncated-blob'] as const)('checks only the named %s snapshot without changing bucket objects', async mode => {
  server.objects.clear();
  const id = randomUUID(), prefix = snapshotPrefix(id), blobKey = Buffer.alloc(32, 8);
  const client = createS3Client({ endpoint: server.endpoint, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
  const store = new S3BackupObjectStore({ client, bucket: 'backups' });
  const config = vi.spyOn(configuration, 'loadBackupConfig').mockResolvedValue({
    gymId: randomUUID(), recipient, blobKey, appEncryptionKey: Buffer.alloc(32), budgetBytes: 8_000_000_000,
    destination: { bucket: 'backups', endpoint: server.endpoint, region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture' },
  });
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const blob = 'blobs/' + 'c'.repeat(64) + '.age';
  try {
    if (mode !== 'missing') {
      const snapshot: Snapshot = { id, version: 1, kind: 'pre_upgrade', startedAt: new Date().toISOString(), recipient,
        database: { sha256: 'a'.repeat(64), size: 3 }, manifest: { sha256: 'b'.repeat(64), size: 3 },
        uploads: [{ blob, protectedHash: 'd'.repeat(64), encrypted: { sha256: 'e'.repeat(64), size: 3 } }] };
      await store.putObject(prefix + 'database.age', bytesStream('abc'));
      if (mode !== 'incomplete') await store.putObject(prefix + 'manifest.age', bytesStream('abc'));
      await store.putObject(prefix + 'references.json', mode === 'tampered' ? bytesStream('{}') : referenceStream(snapshot, blobKey));
      if (mode !== 'missing-blob') await store.putObject(blob, bytesStream(mode === 'truncated-blob' ? 'a' : 'abc'));
    }
    await store.putObject(snapshotPrefix(randomUUID()) + 'references.json', bytesStream('unrelated invalid reference list'));
    const before = [...server.objects].map(([key, value]) => [key, Buffer.from(value.bytes)]);
    const list = vi.spyOn(S3BackupObjectStore.prototype, 'listObjects').mockRejectedValue(new Error('must not list the bucket'));
    const get = vi.spyOn(S3BackupObjectStore.prototype, 'getObject'), head = vi.spyOn(S3BackupObjectStore.prototype, 'headObject');
    try {
      await maintenanceCommand(['snapshot-check', id]);
      expect(list).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledExactlyOnceWith(prefix + 'references.json');
      expect(head.mock.calls.every(([key]) => [prefix + 'references.json', prefix + 'database.age', prefix + 'manifest.age', blob].includes(key))).toBe(true);
      if (mode === 'available') for (const key of [prefix + 'database.age', prefix + 'manifest.age', blob]) expect(head).toHaveBeenCalledWith(key);
    } finally { list.mockRestore(); get.mockRestore(); head.mockRestore(); }
    expect(output).toHaveBeenCalledWith(mode === 'available' ? 'Snapshot availability: available\n' : 'Snapshot availability: missing or incomplete\n');
    expect([...server.objects].map(([key, value]) => [key, value.bytes])).toEqual(before);
  } finally { output.mockRestore(); config.mockRestore(); client.destroy(); }
});

describe('a missing backup bucket', () => {
  const restore = commands.find((command) => command.id === 'restore')!;
  async function run(bucket: string) {
    const identityFile = join(directory, 'identity.txt'), path = join(directory, 'restore.json');
    await writeFile(identityFile, await generateIdentity() + '\n');
    await writeFile(path, JSON.stringify({ bucket, endpoint: server.endpoint, region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture', identityFile }));
    const lines: string[] = [];
    const code = await restore.run([randomUUID(), '--config', path], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
    return { code, text: lines.join('\n') };
  }
  afterEach(() => { server.state.missingBuckets.clear(); });
  it('is thrown by a GET, while a HEAD still reads as a missing object', async () => {
    server.state.missingBuckets.add('absent');
    const client = createS3Client({ endpoint: server.endpoint, maxAttempts: 1, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    try {
      const store = new S3BackupObjectStore({ client, bucket: 'absent' });
      await expect(store.getObject('snapshots/x/manifest.age')).rejects.toMatchObject({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
      expect(await store.headObject('snapshots/x/manifest.age')).toBeNull();
      // A missing object in a bucket that exists is still no error.
      const present = new S3BackupObjectStore({ client, bucket: 'backups' });
      expect(await present.getObject('snapshots/x/manifest.age')).toBeNull();
      expect(await present.headObject('snapshots/x/manifest.age')).toBeNull();
    } finally { client.destroy(); }
  });
  it('makes the command-line restore name the bucket, and a missing snapshot in a bucket that exists name the snapshot', async () => {
    server.objects.clear();
    server.state.missingBuckets.add('absent');
    expect(await run('absent')).toEqual({ code: 1, text: "Restore failed: The backup bucket doesn't exist (NoSuchBucket)" });
    expect(await run('backups')).toEqual({ code: 1, text: 'Restore failed: Snapshot not found in the bucket' });
  }, 30_000);
});

it('starts the deadline before loading configuration and ignores a late configuration result', async () => {
  let resolve!: (config: Awaited<ReturnType<typeof configuration.loadBackupConfig>>) => void;
  const config = vi.spyOn(configuration, 'loadBackupConfig').mockReturnValue(new Promise(done => { resolve = done; }));
  const open = vi.spyOn(configuration, 'configuredBackup');
  vi.useFakeTimers();
  try {
    const pending = expect(maintenanceCommand(['snapshot-check', randomUUID()])).rejects.toThrow('Snapshot availability check timed out');
    await vi.advanceTimersByTimeAsync(snapshotCheckTimeoutMs);
    await pending;
    resolve({ gymId: randomUUID(), recipient, blobKey: Buffer.alloc(32), appEncryptionKey: Buffer.alloc(32), budgetBytes: 8_000_000_000,
      destination: { bucket: 'backups', region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); config.mockRestore(); open.mockRestore(); }
});
