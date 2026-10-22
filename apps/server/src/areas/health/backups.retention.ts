// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { BackupObjectStore, Uploads } from '../../infra/storage/index.js';
import { protectedName, readReferences, snapshotPrefix, verifyReferences } from './backups.format.js';
import type { Snapshot } from './backups.format.js';

/** Distinct UTC buckets; one snapshot can satisfy hourly, daily, and weekly tiers. */
export function retainedSnapshots(snapshots: readonly Snapshot[], now: Date): ReadonlySet<string> {
  const ordered = [...snapshots].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const keep = new Set<string>();
  const tiers: [number, number][] = [[3_600_000, 24], [86_400_000, 7], [604_800_000, 4]];
  for (const [width, count] of tiers) {
    const buckets = new Set<number>();
    for (const snapshot of ordered) {
      if (snapshot.kind === 'pre_upgrade') continue;
      const bucket = Math.floor(new Date(snapshot.startedAt).getTime() / width);
      if (!buckets.has(bucket) && buckets.size < count) { buckets.add(bucket); keep.add(snapshot.id); }
    }
  }
  for (const snapshot of ordered.filter((s) => s.kind === 'pre_upgrade' &&
    now.getTime() - new Date(s.startedAt).getTime() <= 30 * 86_400_000).slice(0, 2)) keep.add(snapshot.id);
  return keep;
}
export interface BackupInventory { snapshots: Snapshot[]; objects: Awaited<ReturnType<BackupObjectStore['listObjects']>> }
/** Enumerate prefixes, not only commits: a partial run also stops pruning conservatively. */
export async function inventory(store: BackupObjectStore, blobKey: Buffer): Promise<BackupInventory> {
  const objects = await store.listObjects('snapshots/');
  const ids = new Set<string>();
  for (const object of objects) {
    const match = /^snapshots\/([^/]+)\/(database[.]age|manifest[.]age|references[.]json)$/.exec(object.key);
    if (!match || !z.uuid().safeParse(match[1]).success) throw new Error('Invalid snapshot inventory; pruning stopped');
    ids.add(match[1]!);
  }
  const snapshots: Snapshot[] = [];
  for (const id of ids) {
    const prefix = snapshotPrefix(id);
    const snapshot = verifyReferences(await readReferences(store, prefix + 'references.json'), blobKey, id);
    for (const [name, expected] of [['database.age', snapshot.database], ['manifest.age', snapshot.manifest]] as const) {
      const object = objects.find((object) => object.key === prefix + name);
      if (!object || object.size !== expected.size) throw new Error('Incomplete snapshot; pruning stopped');
    }
    snapshots.push(snapshot);
  }
  const blobs = await store.listObjects('blobs/');
  for (const snapshot of snapshots) for (const reference of snapshot.uploads) {
    const blob = blobs.find((blob) => blob.key === reference.blob);
    if (!blob || blob.size !== reference.encrypted.size) throw new Error('Missing or invalid upload blob; pruning stopped');
  }
  return { snapshots, objects };
}
export async function pruneUnlocked(store: BackupObjectStore, blobKey: Buffer, uploads: ReadonlyMap<string, Uploads>,
  now: Date, reserveBytes = 0, budget = 8_000_000_000, sweepBefore = now): Promise<{ retainedBytes: number; protectedKeys: ReadonlySet<string> }> {
  const state = await inventory(store, blobKey);
  const keep = retainedSnapshots(state.snapshots, now);
  const retained = state.snapshots.filter((s) => keep.has(s.id));
  const blobs = new Set(retained.flatMap((s) => s.uploads.map((u) => u.blob)));
  const allBlobs = await store.listObjects('blobs/');
  const required = state.objects.filter((object) => keep.has(object.key.split('/')[1]!))
    .reduce((n, object) => n + object.size, 0) +
    allBlobs.filter((blob) => blobs.has(blob.key)).reduce((n, blob) => n + blob.size, 0);
  if (required + reserveBytes > budget) throw new Error('Backup retention budget cannot meet recovery objectives and in-flight reserve');
  // Delete the commit marker last. Interruption leaves a detectable incomplete snapshot, never an unprotected blob.
  for (const snapshot of state.snapshots.filter((s) => !keep.has(s.id))) {
    const prefix = snapshotPrefix(snapshot.id);
    await store.deleteObject(prefix + 'database.age');
    await store.deleteObject(prefix + 'manifest.age');
    await store.deleteObject(prefix + 'references.json');
  }
  for (const blob of allBlobs) if (!blobs.has(blob.key)) await store.deleteObject(blob.key);
  const protectedHashes = new Set(retained.flatMap((s) => s.uploads.map((u) => u.protectedHash)));
  const protectedKeys = new Set<string>();
  for (const source of uploads.values()) for (const upload of await source.list())
    if (protectedHashes.has(protectedName(blobKey, upload.key))) protectedKeys.add(upload.key);
  for (const source of uploads.values()) await source.sweep({ before: sweepBefore, protectedKeys });
  return { retainedBytes: required, protectedKeys };
}
