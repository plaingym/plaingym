// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { backupRuns, uuidv7 } from '@plaingym/db';
import { inventory } from './backups.retention.js';
import { snapshotPrefix } from './backups.format.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture();
const { gymId, clock, blobKey } = f;

describe('install snapshot retention and publication with real Postgres and S3', () => {
  it('reuses immutable upload blobs and protects them across retention and tombstone sweeping', async () => {
    const first = await f.backup().snapshot('hourly');
    clock.advance(3_600_000);
    const second = await f.backup().snapshot('hourly');
    expect(first.uploads[0]!.blob).toBe(second.uploads[0]!.blob);
    expect(await f.store.listObjects('blobs/')).toHaveLength(1);
    await f.uploads.markDeleted(gymId + '/photo');
    clock.advance(3_600_000);
    const retention = await f.backup().prune();
    const retainedObjects = [...await f.store.listObjects('snapshots/'), ...await f.store.listObjects('blobs/')];
    expect(retention.retainedBytes).toBe(retainedObjects.reduce((total, object) => total + object.size, 0));
    expect(await f.uploads.get(gymId + '/photo')).not.toBeNull();
    expect(await inventory(f.store, blobKey)).toMatchObject({ snapshots: expect.any(Array) });
  });

  it.each(['missing', 'tampered'])('halts pruning on %s references without deleting any upload blob', async (mode) => {
    const snapshot = await f.backup().snapshot();
    const key = 'backups/' + snapshotPrefix(snapshot.id) + 'references.json';
    if (mode === 'missing') f.server.objects.delete(key);
    else {
      const object = f.server.objects.get(key)!; object.bytes = Buffer.from(object.bytes.toString().replace('"mac":"', '"mac":"f'));
    }
    await f.uploads.markDeleted(gymId + '/photo');
    clock.advance(1000);
    const objectsBefore = [...f.server.objects.keys()].sort();
    await expect(f.backup().prune()).rejects.toThrow();
    expect([...f.server.objects.keys()].sort()).toEqual(objectsBefore);
    expect(await f.uploads.get(gymId + '/photo')).not.toBeNull();
  });

  it('removes an interrupted publication under the lock and keeps publishing snapshots', async () => {
    // A process killed after uploading the dump: its run is recorded as running and no reference list exists.
    const id = uuidv7(), prefix = snapshotPrefix(id);
    await f.source.forSystem((tx) => tx.insert(backupRuns).values({ id, kind: 'hourly', startedAt: clock.now(), objectPrefix: prefix }));
    await f.store.putObject(prefix + 'database.age', new Blob(['partial dump']).stream());
    await f.store.putObject('blobs/' + 'f'.repeat(64) + '.age', new Blob(['orphan blob']).stream());
    for (let run = 0; run < 2; run++) { clock.advance(3_600_000); await f.backup().snapshot('hourly'); }
    const state = await inventory(f.store, blobKey);
    expect(state.snapshots).toHaveLength(2);
    expect(state.abandoned).toEqual([]); expect(state.suspect).toEqual([]);
    expect(f.server.objects.has('backups/' + prefix + 'database.age')).toBe(false);
    expect(f.server.objects.has('backups/blobs/' + 'f'.repeat(64) + '.age')).toBe(false);
  });

  it('keeps publishing over an unverifiable reference list without deleting or rewriting anything', async () => {
    const first = await f.backup().snapshot();
    const key = 'backups/' + snapshotPrefix(first.id) + 'references.json', reference = f.server.objects.get(key)!;
    reference.bytes = Buffer.from(reference.bytes.toString().replace('"mac":"', '"mac":"f'));
    const before = new Map([...f.server.objects].map(([name, object]) => [name, Buffer.from(object.bytes)]));
    clock.advance(3_600_000);
    const second = await f.backup().snapshot('hourly');
    for (const [name, bytes] of before) expect(f.server.objects.get(name)?.bytes).toEqual(bytes);
    // The stored blob is referenced as it is, not re-encrypted over the copy the first snapshot needs.
    expect(second.uploads[0]).toEqual(first.uploads[0]);
    // The new snapshot is complete and restorable even though pruning stays stopped.
    await f.restore().restore(second.id, f.identity);
  });
});
