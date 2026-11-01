// SPDX-License-Identifier: AGPL-3.0-only
import { access, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { readBytes, stream } from '../../core/registry-infra-contracts.js';
import { digest, indexName, pool } from './common.js';
import { LocalUploads, S3Uploads, createS3Client } from './index.js';
import { s3Server } from './s3-server.test-helper.js';

const clock = new TestClock('2026-10-22T12:00:00Z');
const signingKey = new Uint8Array(32).fill(7);
const roots: string[] = [];
let server: Awaited<ReturnType<typeof s3Server>>;
let client: ReturnType<typeof createS3Client>;
let sequence = 0;
beforeAll(async () => {
  server = await s3Server();
  client = createS3Client({ endpoint: server.endpoint, maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
});
afterAll(async () => {
  client?.destroy(); await server?.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** One store, opened by as many adapters as a test needs, with the files of its index layout. */
interface Store {
  open(gymId?: string): LocalUploads | S3Uploads;
  /** Names in the gym's key index. */
  entries(gymId?: string): Promise<string[]>;
  /** Removes what the index layout adds, leaving the store as the release before it wrote it. */
  removeIndex(): Promise<void>;
  /** A copy without the index layout in a new place, which this process has never listed. */
  withoutIndex(): Promise<Store>;
  /** Writes an index entry without anything else, as a crash right after it leaves. */
  plantEntry(name: string): Promise<void>;
  /** Marks a key swept and removes its blob as the release before the index does, leaving its entry; interrupted keeps the blob. */
  sweepAsBefore(key: string, interrupted?: boolean): Promise<void>;
  hasBlob(key: string): Promise<boolean>;
  /** Makes index writes fail from the second one on; the result undoes it. */
  failIndexWrites(): Promise<() => Promise<void>>;
}
function localStore(root: string): Store {
  const gymRoot = (gymId = 'gym') => join(root, digest(gymId));
  const added = (path: string) => ['index', 'swept'].some((directory) => path === join(gymRoot(), directory) || path.startsWith(join(gymRoot(), directory) + sep));
  return {
    open: (gymId = 'gym') => new LocalUploads({ gymId, root, signingKey, downloadUrl: 'https://gym.test/uploads/download', clock }),
    entries: async (gymId) => (await readdir(join(gymRoot(gymId), 'index')).catch(() => [])).sort(),
    async removeIndex() { for (const directory of ['index', 'swept']) await rm(join(gymRoot(), directory), { recursive: true, force: true }); },
    async withoutIndex() {
      const copy = await temporaryRoot();
      await cp(root, copy, { recursive: true, filter: (path) => !added(path) });
      return localStore(copy);
    },
    async plantEntry(name) {
      await mkdir(join(gymRoot(), 'index'), { recursive: true });
      await writeFile(join(gymRoot(), 'index', name), '');
    },
    async sweepAsBefore(key, interrupted) {
      await writeFile(join(gymRoot(), digest(key), 'swept'), '');
      if (!interrupted) await rm(join(gymRoot(), digest(key), 'body'));
    },
    hasBlob: (key) => access(join(gymRoot(), digest(key), 'body')).then(() => true, () => false),
    async failIndexWrites() {
      // A file where the index directory belongs makes every index read and write fail.
      await rm(join(gymRoot(), 'index'), { recursive: true, force: true });
      await writeFile(join(gymRoot(), 'index'), '');
      return () => rm(join(gymRoot(), 'index'));
    },
  };
}
function s3Store(bucket = 'index-' + sequence++): Store & { readonly bucket: string } {
  const prefix = (gymId = 'gym') => `${bucket}/${gymId}/.storage/`;
  const object = () => ({ bytes: Buffer.alloc(0), contentType: 'text/plain', etag: '"e"', modified: 'Thu, 22 Oct 2026 12:00:00 GMT' });
  return {
    open: (gymId = 'gym') => new S3Uploads({ client, bucket, gymId, clock }),
    entries: async (gymId) => [...server.objects.keys()].filter((key) => key.startsWith(prefix(gymId) + 'index/'))
      .map((key) => key.slice((prefix(gymId) + 'index/').length)).sort(),
    async removeIndex() { for (const key of server.objects.keys()) if (key.startsWith(prefix() + 'index/')) server.objects.delete(key); },
    async withoutIndex() {
      const copy = s3Store();
      for (const [key, value] of server.objects)
        if (key.startsWith(bucket + '/') && !key.startsWith(prefix() + 'index/')) server.objects.set(key.replace(bucket, copy.bucket), value);
      return copy;
    },
    async plantEntry(name) { server.objects.set(prefix() + 'index/' + name, object()); },
    async sweepAsBefore(key, interrupted) {
      server.objects.set(prefix() + 'swept/' + digest(key), object());
      if (!interrupted) server.objects.delete(prefix() + 'blobs/' + digest(key));
    },
    hasBlob: async (key) => server.objects.has(prefix() + 'blobs/' + digest(key)),
    async failIndexWrites() {
      let writes = 0;
      server.state.fail = (method, key) => method === 'PUT' && key.startsWith(prefix() + 'index/') && ++writes >= 2;
      return async () => { server.state.fail = undefined; };
    },
    bucket,
  };
}
async function temporaryRoot() { const root = await mkdtemp(join(tmpdir(), 'plaingym-index-')); roots.push(root); return root; }
const keys = (infos: readonly { key: string }[]) => infos.map((info) => info.key);
const broken = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('Power loss')); } });

for (const implementation of ['local', 's3'] as const) {
  const create = async () => implementation === 'local' ? localStore(await temporaryRoot()) : s3Store();
  describe(`${implementation} key index`, () => {
    it('lists a store written before the index, before and after its backfill', async () => {
      const store = await create(); const uploads = store.open();
      for (const key of ['gym/a/1', 'gym/a/2', 'gym/a/3', 'gym/b/1']) await uploads.put(key, stream([1]), 'text/plain');
      await uploads.markDeleted('gym/a/2'); await uploads.markDeleted('gym/a/3');
      expect(await uploads.sweep({ before: clock.now(), protectedKeys: new Set(['gym/a/2']) })).toEqual(['gym/a/3']);
      await expect(uploads.put('gym/a/4', broken(), 'text/plain')).rejects.toThrow('Power loss');
      const old = await store.withoutIndex();
      expect(await old.entries()).toEqual([]);
      // The first listing in the process backfills the index and answers from the records it read.
      const listed = await old.open().list();
      expect(keys(listed)).toEqual(['gym/a/1', 'gym/a/2', 'gym/b/1']);
      expect(listed[1]!.deletedAt).toEqual(clock.now());
      expect(await old.entries()).toEqual(['gym/a/1', 'gym/a/2', 'gym/a/4', 'gym/b/1'].map((key) => indexName('gym', key)).sort());
      expect(keys(await old.open().list('gym/a/'))).toEqual(['gym/a/1', 'gym/a/2']);
      expect(keys(await old.open().list('gym/a'))).toEqual(['gym/a/1', 'gym/a/2']);
      for (const key of ['gym/a/3', 'gym/a/4']) await expect(old.open().put(key, stream([2]), 'text/plain')).rejects.toThrow('immutable');
      expect(await old.open().sweep({ before: clock.now() })).toEqual(['gym/a/2']);
      expect(keys(await old.open().list())).toEqual(['gym/a/1', 'gym/b/1']);
    });
    it('fails a listing whose backfill is interrupted and completes it on the next', async () => {
      const store = await create(); const uploads = store.open();
      for (const key of ['gym/1', 'gym/2', 'gym/3']) await uploads.put(key, stream([1]), 'text/plain');
      await store.removeIndex();
      const undo = await store.failIndexWrites();
      await expect(store.open().list()).rejects.toThrow();
      expect((await store.entries()).length).toBeLessThan(3);
      await undo();
      expect(keys(await store.open().list())).toEqual(['gym/1', 'gym/2', 'gym/3']);
      expect(await store.entries()).toHaveLength(3);
    });
    it('lists nothing for a crash around the reservation and keeps the key reserved', async () => {
      const store = await create();
      // Crash after the index entry, before the reservation: the entry names no record.
      await store.plantEntry(indexName('gym', 'gym/x'));
      expect(keys(await store.open().list())).not.toContain('gym/x');
      expect(await store.open().sweep({ before: clock.now() })).toEqual([]);
      expect(await store.entries()).toContain(indexName('gym', 'gym/x'));
      await store.open().put('gym/x', stream([1]), 'text/plain');
      expect(keys(await store.open().list())).toContain('gym/x');
      // Crash between the reservation and the published record.
      await expect(store.open().put('gym/y', broken(), 'text/plain')).rejects.toThrow('Power loss');
      expect(keys(await store.open().list())).not.toContain('gym/y');
      expect(await store.open().head('gym/y')).toBeNull();
      await expect(store.open().put('gym/y', stream([2]), 'text/plain')).rejects.toThrow('immutable');
      await store.open().restore('gym/y', stream([3]), 'text/plain', clock.now());
      expect((await store.open().list('gym/y')).map((info) => [info.key, info.size])).toEqual([['gym/y', 1]]);
      expect(await readBytes(await store.open().get('gym/y'))).toEqual([3]);
    });
    it('keeps the listing correct through restore and undelete in a store written before the index', async () => {
      const store = await create(); const uploads = store.open();
      for (const key of ['gym/r/kept', 'gym/r/other']) await uploads.put(key, stream([1]), 'text/plain');
      await uploads.markDeleted('gym/r/kept'); await uploads.markDeleted('gym/r/other');
      await store.removeIndex();
      await store.open().restore('gym/r/kept', stream([1]), 'text/plain', clock.now());
      const listed = await store.open().list('gym/r/');
      expect(listed.map((info) => [info.key, info.deletedAt])).toEqual([['gym/r/kept', undefined], ['gym/r/other', clock.now()]]);
      await store.open().restore('gym/r/other', stream([1]), 'text/plain', clock.now());
      await store.open().restore('gym/r/new', stream([5]), 'image/png', clock.now());
      expect((await store.open().list('gym/r/')).map((info) => [info.key, info.deletedAt])).toEqual([
        ['gym/r/kept', undefined], ['gym/r/new', undefined], ['gym/r/other', undefined]]);
      expect(await store.entries()).toEqual(['gym/r/kept', 'gym/r/new', 'gym/r/other'].map((key) => indexName('gym', key)).sort());
    });
    it("keeps another gym's keys out and refuses its prefix", async () => {
      const store = await create();
      await store.open('gym').put('gym/a', stream([1]), 'text/plain');
      await store.open('gym2').put('gym2/a', stream([2]), 'text/plain');
      expect(keys(await store.open('gym').list())).toEqual(['gym/a']);
      expect(keys(await store.open('gym2').list())).toEqual(['gym2/a']);
      for (const prefix of ['gym2/', 'gym2', 'gy', 'other/']) await expect(store.open('gym').list(prefix)).rejects.toThrow('another gym');
      // Entries that decode outside the gym, or name another gym's record, are ignored.
      await store.plantEntry(Buffer.from('../gym2/a').toString('hex'));
      await store.plantEntry(Buffer.from('a').toString('hex') + '-' + digest('gym2/a'));
      expect(keys(await store.open('gym').list())).toEqual(['gym/a']);
    });
    it('lists and sweeps long, non-ASCII and ill-formed keys by prefix', async () => {
      const store = await create(); const uploads = store.open();
      const long = 'gym/long/' + 'x'.repeat(200), longer = 'gym/long/' + 'x'.repeat(100) + 'y';
      const all = [long, longer, 'gym/ü/ñ', 'gym/s/\uD800', 'gym/s/😀'];
      for (const key of all) await uploads.put(key, stream([1]), 'text/plain');
      expect(keys(await store.open().list(long.slice(0, 150)))).toEqual([long]);
      expect(keys(await store.open().list(longer))).toEqual([longer]);
      expect(keys(await store.open().list('gym/long/'))).toEqual([long, longer].sort((a, b) => a.localeCompare(b)));
      expect(keys(await store.open().list('gym/ü'))).toEqual(['gym/ü/ñ']);
      expect(keys(await store.open().list('gym/s/'))).toHaveLength(2);
      expect(keys(await store.open().list('gym/s/\uD800'))).toEqual(['gym/s/\uD800']);
      expect(keys(await store.open().list('gym/s/\uD83D'))).toEqual(['gym/s/😀']);
      for (const key of all) await uploads.markDeleted(key);
      expect(await store.open().sweep({ before: clock.now() })).toEqual([...all].sort());
      expect(await store.open().list()).toEqual([]);
      expect(await store.entries()).toEqual([]);
    });
    it('repairs on sweep what a release before the index writes after it', async () => {
      const store = await create(); const uploads = store.open();
      await uploads.put('gym/o/1', stream([1]), 'text/plain');
      expect(keys(await uploads.list())).toEqual(['gym/o/1']);
      // That release reserves without an index entry, and sweeps without removing one.
      await uploads.put('gym/o/2', stream([2]), 'text/plain');
      await uploads.put('gym/o/3', stream([3]), 'text/plain');
      await uploads.markDeleted('gym/o/3');
      await store.removeIndex();
      await uploads.put('gym/o/1b', stream([1]), 'text/plain');
      await store.plantEntry(indexName('gym', 'gym/o/3'));
      await store.sweepAsBefore('gym/o/3');
      expect(keys(await store.open().list())).not.toContain('gym/o/3');
      expect(await store.open().sweep({ before: new Date(0) })).toEqual([]);
      expect(keys(await store.open().list())).toEqual(['gym/o/1', 'gym/o/1b', 'gym/o/2']);
      expect(await store.entries()).not.toContain(indexName('gym', 'gym/o/3'));
    });
  });
}

for (const implementation of ['local', 's3'] as const) {
  const create = async () => implementation === 'local' ? localStore(await temporaryRoot()) : s3Store();
  describe(`${implementation} key index repairs`, () => {
    it('finishes a sweep the release before the index interrupted before removing the blob', async () => {
      const store = await create(); const uploads = store.open();
      await uploads.put('gym/i/1', stream([1]), 'text/plain');
      await uploads.markDeleted('gym/i/1');
      await store.removeIndex();
      await store.sweepAsBefore('gym/i/1', true);
      expect(await store.hasBlob('gym/i/1')).toBe(true);
      expect(await store.open().list()).toEqual([]);
      expect(await store.hasBlob('gym/i/1')).toBe(false);
      expect(await store.entries()).toEqual([]);
    });
    it('leaves a key the sweep only just indexed for the next sweep, as its protection is unknown', async () => {
      const store = await create(); const uploads = store.open();
      await uploads.put('gym/n/1', stream([1]), 'text/plain');
      expect(keys(await uploads.list())).toEqual(['gym/n/1']);
      // Another process running the release before the index writes and deletes a key this one never listed.
      await uploads.put('gym/n/2', stream([2]), 'text/plain');
      await uploads.markDeleted('gym/n/1'); await uploads.markDeleted('gym/n/2');
      await store.removeIndex();
      await uploads.put('gym/n/3', stream([3]), 'text/plain');
      expect(await store.open().sweep({ before: clock.now() })).toEqual([]);
      expect(await store.open().sweep({ before: clock.now() })).toEqual(['gym/n/1', 'gym/n/2']);
      expect(keys(await store.open().list())).toEqual(['gym/n/3']);
    });
    it('keeps no entry for a failed reservation or a put of a swept key', async () => {
      const store = await create(); const uploads = store.open();
      await uploads.put('gym/f/1', stream([1]), 'text/plain');
      await uploads.markDeleted('gym/f/1');
      expect(await uploads.sweep({ before: clock.now() })).toEqual(['gym/f/1']);
      await expect(uploads.put('gym/f/1', stream([2]), 'text/plain')).rejects.toThrow('immutable');
      await expect(uploads.put('gym/f/2', stream([2]), 'text/plain')).resolves.toMatchObject({ key: 'gym/f/2' });
      await expect(uploads.put('gym/f/2', stream([3]), 'text/plain')).rejects.toThrow('immutable');
      expect(await store.entries()).toEqual([indexName('gym', 'gym/f/2')]);
      if (implementation === 's3') {
        server.state.fail = (method, key) => method === 'PUT' && key.endsWith('/records/' + digest('gym/f/3'));
        try { await expect(uploads.put('gym/f/3', stream([3]), 'text/plain')).rejects.toThrow(); }
        finally { server.state.fail = undefined; }
        expect(await store.entries()).toEqual([indexName('gym', 'gym/f/2')]);
        await uploads.put('gym/f/3', stream([3]), 'text/plain');
        expect(keys(await uploads.list())).toEqual(['gym/f/2', 'gym/f/3']);
      }
    });
  });
}

describe('bounded concurrency', () => {
  it('starts nothing after a failure and settles every started call before rejecting', async () => {
    const started: number[] = [], settled: number[] = [];
    const result = pool(Array.from({ length: 40 }, (_, i) => i), async (i) => {
      started.push(i);
      if (i === 0) throw new Error('First call fails');
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled.push(i);
    }, 4);
    await expect(result).rejects.toThrow('First call fails');
    expect(started.length).toBeLessThan(10);
    expect(settled.sort((a, b) => a - b)).toEqual(started.filter((i) => i !== 0).sort((a, b) => a - b));
  });
});

describe('S3 key index requests', () => {
  it('lists a prefix and sweeps without reading swept keys, keys outside the prefix or live keys', async () => {
    const store = s3Store(); const uploads = store.open();
    // S3's page size, so each listing below is one request.
    server.state.pageSize = 1000;
    onTestFinished(() => { server.state.pageSize = 2; server.state.log = undefined; });
    for (const key of ['gym/p/1', 'gym/p/2', 'gym/p/3', 'gym/q/1', 'gym/q/2', 'gym/q/3']) await uploads.put(key, stream([1]), 'text/plain');
    await uploads.markDeleted('gym/p/3');
    expect(await uploads.sweep({ before: clock.now() })).toEqual(['gym/p/3']);
    await uploads.markDeleted('gym/p/2'); await uploads.markDeleted('gym/q/2');
    expect(keys(await uploads.list())).toHaveLength(5);
    const touched = (log: readonly string[], key: string) => log.some((line) => line.includes(digest(key)) || line.endsWith(indexName('gym', key)));
    server.state.log = [];
    expect(keys(await store.open().list('gym/p/'))).toEqual(['gym/p/1', 'gym/p/2']);
    const listing = server.state.log;
    // One listing of the prefix's entries, then each key's record, deletion marker and sweep marker.
    expect(listing).toHaveLength(1 + 2 * 3);
    for (const key of ['gym/p/3', 'gym/q/1', 'gym/q/2', 'gym/q/3']) expect(touched(listing, key)).toBe(false);
    server.state.log = [];
    expect(await store.open().sweep({ before: new Date(0) })).toEqual([]);
    const sweep = server.state.log;
    // The index, records, sweep markers, blobs and deletion markers.
    expect(sweep.filter((line) => line.startsWith('LIST '))).toHaveLength(5);
    for (const key of ['gym/p/1', 'gym/p/3', 'gym/q/1', 'gym/q/3']) expect(touched(sweep, key)).toBe(false);
    for (const key of ['gym/p/2', 'gym/q/2']) expect(touched(sweep, key)).toBe(true);
  });
});
