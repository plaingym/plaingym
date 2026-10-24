// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTransaction } from '@plaingym/shared/transaction';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { backupContract, readBytes, stream, uploadsContract } from '../../core/registry-infra-contracts.js';
import { FakeBackupObjectStore, FakeUploads, LocalUploads, S3BackupObjectStore, S3Uploads, createS3Client } from './index.js';
import type { Uploads } from './index.js';
import { s3Server } from './s3-server.test-helper.js';

const roots: string[] = [];
const signingKey = new Uint8Array(32).fill(7);
const clock = new TestClock('2026-10-22T12:00:00Z');
const database = useTestDatabase();
async function local(gymId = 'gym', root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'plaingym-storage-'));
  if (!root) roots.push(directory);
  return new LocalUploads({ gymId, root: directory, signingKey, downloadUrl: 'https://gym.test/uploads/download', clock });
}
let server: Awaited<ReturnType<typeof s3Server>>;
let client: ReturnType<typeof createS3Client>;
let sequence = 0;
function options() { return { client, bucket: 'bucket-' + sequence++, clock }; }
beforeAll(async () => {
  server = await s3Server();
  client = createS3Client({ endpoint: server.endpoint, maxAttempts: 1,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
});
afterAll(async () => {
  client?.destroy(); await server?.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
uploadsContract('in-memory uploads', async () => new FakeUploads('gym', clock));
backupContract('in-memory backups', async () => new FakeBackupObjectStore(clock));
uploadsContract('local disk uploads', () => local());
uploadsContract('S3 uploads over HTTP', async () => new S3Uploads({ ...options(), gymId: 'gym' }));
backupContract('S3 backups over HTTP', async () => new S3BackupObjectStore(options()));

describe('durable upload safety', () => {
  for (const implementation of ['local', 's3'] as const) {
    it(`${implementation}: reserves atomically across clients and restarts, including after sweep`, async () => {
      let make: () => Promise<Uploads>;
      if (implementation === 'local') {
        const first = await local(); const root = roots.at(-1)!;
        make = () => local('gym', root); await first.put('gym/original', stream([4]), 'text/plain');
      } else {
        const config = options(); make = async () => new S3Uploads({ ...config, gymId: 'gym' });
      }
      const a = await make(); const b = await make();
      const results = await Promise.allSettled([a.put('gym/race', stream([1]), 'text/plain'), b.put('gym/race', stream([2]), 'text/plain')]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await a.markDeleted('gym/race');
      await b.sweep({ before: clock.now() });
      const restarted = await make();
      expect(await restarted.get('gym/race')).toBeNull();
      await expect(restarted.put('gym/race', stream([3]), 'text/plain')).rejects.toThrow('immutable');
      await restarted.markDeleted('gym/race');
      expect(await restarted.head('gym/race')).toBeNull();
    });
    it(`${implementation}: preserves deferred bytes, cutoff, protected files, and missing-key behavior`, async () => {
      const store = implementation === 'local' ? await local() : new S3Uploads({ ...options(), gymId: 'gym' });
      await store.put('gym/a', stream([1]), 'text/plain');
      await store.put('gym/b', stream([2]), 'text/plain');
      await store.put('gym/c', stream([3]), 'text/plain');
      expect((await store.list()).map((info) => info.key)).toEqual(['gym/a', 'gym/b', 'gym/c']);
      await store.markDeleted('gym/a');
      expect(await store.sweep({ before: new Date(clock.now().getTime() - 1) })).toEqual([]);
      expect(await readBytes(await store.get('gym/a'))).toEqual([1]);
      expect(await store.sweep({ before: clock.now(), protectedKeys: new Set(['gym/a']) })).toEqual([]);
      expect(await store.sweep({ before: clock.now() })).toEqual(['gym/a']);
      expect(await store.head('gym/missing')).toBeNull(); await store.markDeleted('gym/missing');
    });
    it(`${implementation}: restores missing files, keeps stored ones, revives later deletions, and refuses swept keys`, async () => {
      const store = implementation === 'local' ? await local() : new S3Uploads({ ...options(), gymId: 'gym' });
      const createdAt = new Date('2026-01-01T00:00:00Z');
      await store.restore('gym/missing', stream([1]), 'image/png', createdAt);
      expect(await store.head('gym/missing')).toMatchObject({ key: 'gym/missing', size: 1, contentType: 'image/png', createdAt });
      await store.put('gym/kept', stream([2]), 'text/plain');
      await store.restore('gym/kept', stream([9]), 'text/plain', createdAt);
      expect(await readBytes(await store.get('gym/kept'))).toEqual([2]);
      await store.markDeleted('gym/kept');
      await store.restore('gym/kept', stream([2]), 'text/plain', createdAt);
      expect((await store.head('gym/kept'))!.deletedAt).toBeUndefined();
      expect(await store.sweep({ before: clock.now() })).toEqual([]);
      await store.markDeleted('gym/kept');
      expect(await store.sweep({ before: clock.now() })).toEqual(['gym/kept']);
      await expect(store.restore('gym/kept', stream([2]), 'text/plain', createdAt)).rejects.toThrow('swept');
    });
    it(`${implementation}: rejects ambiguous and control-character keys before touching storage`, async () => {
      const store = implementation === 'local' ? await local() : new S3Uploads({ ...options(), gymId: 'gym' });
      for (const key of ['/gym/x', 'gym/../x', 'gym/./x', 'gym\\x', 'gym/a\0b', 'gym/a\u007fb', 'gym/a\u0085b', 'gym/', 'other/a']) {
        await expect(store.put(key, stream([]), 'text/plain')).rejects.toThrow();
        await expect(store.get(key)).rejects.toThrow(); await expect(store.head(key)).rejects.toThrow();
        await expect(store.markDeleted(key)).rejects.toThrow(); await expect(store.signedUrl(key, 60)).rejects.toThrow();
      }
      for (const seconds of [0, -1, 1.5, NaN, Infinity, 604801]) await expect(store.signedUrl('gym/a', seconds)).rejects.toThrow();
      await expect(store.sweep({ before: new Date(NaN) })).rejects.toThrow();
    });
    it(`${implementation}: refuses every operation inside a transaction`, async () => {
      const store = implementation === 'local' ? await local() : new S3Uploads({ ...options(), gymId: 'gym' });
      const calls = [() => store.put('gym/a', stream([]), 'text/plain'), () => store.get('gym/a'),
        () => store.head('gym/a'), () => store.list(), () => store.signedUrl('gym/a', 60),
        () => store.markDeleted('gym/a'), () => store.sweep({ before: clock.now() })];
      const requests = server.state.requests;
      for (const call of calls) {
        await expect(runInTransaction<unknown>(call)).rejects.toThrow();
        await expect(database.forGym<unknown>('00000000-0000-4000-8000-000000000001', call)).rejects.toThrow();
      }
      expect(server.state.requests).toBe(requests);
    });
  }
  it('does not publish partially written local streams', async () => {
    const store = await local();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('broken')); } });
    await expect(store.put('gym/failed', body, 'text/plain')).rejects.toThrow('broken');
    expect(await store.head('gym/failed')).toBeNull(); expect(await store.get('gym/failed')).toBeNull();
    const directories = await readdir(roots.at(-1)!, { recursive: true });
    expect(directories.some((path) => path.endsWith('.part'))).toBe(false);
  });
  it('validates local download signatures, expiry, origin, and gym binding', async () => {
    const downloadClock = new TestClock('2026-10-22T12:00:00Z');
    const store = await local(); const root = roots.at(-1)!;
    const signed = new LocalUploads({ gymId: 'gym', root, signingKey, downloadUrl: 'https://gym.test/uploads/download', clock: downloadClock });
    await store.put('gym/photo', stream([7]), 'image/png');
    const link = (await signed.signedUrl('gym/photo', 60))!;
    expect(await readBytes(await signed.getSigned(link))).toEqual([7]);
    expect(await signed.getSigned('invalid URL')).toBeNull();
    for (const alter of [
      (url: URL) => url.searchParams.set('key', 'other/photo'),
      (url: URL) => url.searchParams.set('expires', '9999999999999'),
      (url: URL) => url.searchParams.set('signature', 'bad'),
      (url: URL) => { url.host = 'other.test'; },
      (url: URL) => url.searchParams.append('key', 'gym/photo'),
    ]) { const url = new URL(link); alter(url); expect(await signed.getSigned(url.toString())).toBeNull(); }
    const other = await local('other', root);
    expect(await other.getSigned(link)).toBeNull();
    downloadClock.advance(60000); expect(await signed.getSigned(link)).toBeNull();
    await expect(runInTransaction(() => signed.getSigned(link))).rejects.toThrow();
  });
  it('produces an S3 presigned URL for the immutable blob', async () => {
    const store = new S3Uploads({ ...options(), gymId: 'gym' });
    await store.put('gym/presigned', stream([9]), 'text/plain');
    const url = new URL((await store.signedUrl('gym/presigned', 60))!);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect([...new Uint8Array(await (await fetch(url)).arrayBuffer())]).toEqual([9]);
  });
});

describe('S3 multipart recovery', () => {
  it('coalesces irregular chunks into fixed-size parts with a short final part', async () => {
    const partSize = 5 * 1024 * 1024;
    const store = new S3BackupObjectStore(options());
    const size = partSize * 2 + 19;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === size) { controller.close(); return; }
      const length = Math.min(333333, size - offset); controller.enqueue(new Uint8Array(length).fill(6)); offset += length;
    } });
    const metadata = await store.putObject('large', body, { partSize });
    expect(metadata.size).toBe(size);
    expect(server.state.completedPartSizes.at(-1)).toEqual([partSize, partSize, 19]);
    const bytes = new Uint8Array(await new Response(await store.getObject('large')).arrayBuffer());
    expect(bytes.length).toBe(size); expect(bytes.every((byte) => byte === 6)).toBe(true);
  });
  for (const failure of ['part', 'complete', 'source', 'cancel'] as const) {
    it(`aborts on ${failure} failure and preserves an existing published object`, async () => {
      const store = new S3BackupObjectStore(options());
      await store.putObject('atomic', stream([8]));
      const aborted = server.state.aborted;
      const controller = new AbortController();
      if (failure === 'part') server.state.failPart = 2;
      if (failure === 'complete') server.state.failComplete = true;
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({ pull(streamController) {
        if (failure === 'cancel') { controller.abort(new Error('canceled')); return; }
        if (failure === 'source' && reads > 0) { streamController.error(new Error('broken')); return; }
        if (reads++ < 2) streamController.enqueue(new Uint8Array(5 * 1024 * 1024).fill(1));
        else streamController.close();
      } }, { highWaterMark: 0 });
      try { await expect(store.putObject('atomic', body, { partSize: 5 * 1024 * 1024, signal: controller.signal })).rejects.toThrow(); }
      finally { server.state.failPart = 0; server.state.failComplete = false; }
      expect(server.state.aborted).toBe(aborted + 1);
      expect(server.uploads.size).toBe(0);
      expect(await readBytes(await store.getObject('atomic'))).toEqual([8]);
    });
  }
  it('handles empty input and rejects invalid part sizes before initiating', async () => {
    const store = new S3BackupObjectStore(options());
    const metadata = await store.putObject('empty', stream([])); expect(metadata.size).toBe(0);
    expect(await readBytes(await store.getObject('empty'))).toEqual([]);
    const requests = server.state.requests;
    for (const partSize of [0, 1, 5 * 1024 * 1024 - 1, Infinity, 64 * 1024 * 1024 + 1])
      await expect(store.putObject('bad', stream([]), { partSize })).rejects.toThrow();
    expect(server.state.requests).toBe(requests);
  });
  it('reports the original error and an abort failure together', async () => {
    const store = new S3BackupObjectStore(options());
    server.state.failPart = 1; server.state.failAbort = true;
    try {
      let failure: unknown;
      try { await store.putObject('cleanup-error', stream([1])); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(2);
      expect((failure as AggregateError).message).toContain('abort failed');
    } finally {
      server.state.failPart = 0; server.state.failAbort = false;
      // Simulate the operator removing the deliberately inaccessible test upload.
      server.uploads.clear();
    }
  });
  it('rejects all backup operations inside a transaction before HTTP traffic', async () => {
    const store = new S3BackupObjectStore(options()); const requests = server.state.requests;
    for (const call of [() => store.putObject('x', stream([])), () => store.getObject('x'), () => store.headObject('x'),
      () => store.listObjects(''), () => store.deleteObject('x')]) await expect(runInTransaction<unknown>(call)).rejects.toThrow();
    expect(server.state.requests).toBe(requests);
  });
});
