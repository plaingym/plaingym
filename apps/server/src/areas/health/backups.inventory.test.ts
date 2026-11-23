// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { FakeBackupObjectStore } from '../../infra/storage/index.js';
import { bytesStream } from './backups.files.js';
import { referenceStream, snapshotPrefix, type Snapshot } from './backups.format.js';
import { inventory } from './backups.retention.js';

const clock = new TestClock('2026-10-22T12:00:00Z'), blobKey = Buffer.alloc(32, 9);
async function committed(store: FakeBackupObjectStore, minutesAgo: number) {
  const id = uuidv7(), prefix = snapshotPrefix(id);
  const snapshot: Snapshot = { id, version: 1, kind: 'hourly', startedAt: new Date(clock.now().getTime() - minutesAgo * 60_000).toISOString(),
    database: { sha256: 'a'.repeat(64), size: 3 }, manifest: { sha256: 'b'.repeat(64), size: 3 }, uploads: [] };
  await store.putObject(prefix + 'database.age', bytesStream('abc'));
  await store.putObject(prefix + 'manifest.age', bytesStream('abc'));
  await store.putObject(prefix + 'references.json', referenceStream(snapshot, blobKey));
  return snapshot;
}
/** Holds every reference-list read until the test releases it, counting how many are in flight. */
function heldReads(store: FakeBackupObjectStore) {
  const read = store.getObject.bind(store), waiting: (() => void)[] = [];
  let inFlight = 0, peak = 0;
  vi.spyOn(store, 'getObject').mockImplementation(async (key, options) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => { waiting.push(resolve); });
    inFlight--;
    return read(key, options);
  });
  return { waiting, peak: () => peak };
}
async function drive<T>(work: Promise<T>, held: ReturnType<typeof heldReads>): Promise<T> {
  let done = false;
  void work.then(() => { done = true; }, () => { done = true; });
  while (!done) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(held.waiting.length).toBeLessThanOrEqual(4);
    // Later reads finish first, so the result order cannot come from completion order.
    for (const release of held.waiting.splice(0).reverse()) release();
  }
  return work;
}

describe('backup inventory reads', () => {
  it('reads reference lists at most four at a time and keeps the listing order', async () => {
    const store = new FakeBackupObjectStore(clock);
    for (let index = 0; index < 10; index++) await committed(store, index * 60);
    await store.putObject('blobs/' + 'c'.repeat(64) + '.age', bytesStream('blob'));
    const ids = [...new Set((await store.listObjects('snapshots/')).map((object) => object.key.split('/')[1]!))];
    const blobs = await store.listObjects('blobs/');
    const list = vi.spyOn(store, 'listObjects'), held = heldReads(store);
    const state = await drive(inventory(store, blobKey), held);
    expect(held.peak()).toBeLessThanOrEqual(4);
    expect(held.peak()).toBeGreaterThanOrEqual(2);
    expect(state.snapshots.map((snapshot) => snapshot.id)).toEqual(ids);
    expect(state).toMatchObject({ damaged: [], abandoned: [], suspect: [], blobs });
    expect(list.mock.calls.map(([prefix]) => prefix)).toEqual(['snapshots/', 'blobs/']);
  });
  it('marks only an unreadable reference list as suspect', async () => {
    const store = new FakeBackupObjectStore(clock);
    const snapshots = [];
    for (let index = 0; index < 10; index++) snapshots.push(await committed(store, index * 60));
    const broken = snapshots[4]!;
    await store.putObject(snapshotPrefix(broken.id) + 'references.json', bytesStream('{"payload":"bad","mac":"' + 'a'.repeat(64) + '"}'));
    const ids = [...new Set((await store.listObjects('snapshots/')).map((object) => object.key.split('/')[1]!))];
    const state = await drive(inventory(store, blobKey), heldReads(store));
    expect(state.suspect).toEqual(['Invalid snapshot reference list']);
    expect(state.snapshots.map((snapshot) => snapshot.id)).toEqual(ids.filter((id) => id !== broken.id));
    expect(state.damaged).toEqual([]);
  });
  it('lists each prefix once and returns empty results for an empty bucket', async () => {
    const store = new FakeBackupObjectStore(clock), list = vi.spyOn(store, 'listObjects'), get = vi.spyOn(store, 'getObject');
    expect(await inventory(store, blobKey)).toEqual({ snapshots: [], damaged: [], abandoned: [], suspect: [], objects: [], blobs: [] });
    expect(list.mock.calls.map(([prefix]) => prefix)).toEqual(['snapshots/', 'blobs/']);
    expect(get).not.toHaveBeenCalled();
  });
});
