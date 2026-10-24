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
export interface BackupInventory {
  /** Committed and complete: restorable. */
  snapshots: Snapshot[];
  /** Committed (authenticated reference list) but an object or upload blob is missing or the wrong size. */
  damaged: Snapshot[];
  /** Prefixes without a reference list whose run never succeeded: a publication that never committed. */
  abandoned: string[];
  /** Why deleting anything could lose data: unknown objects, unverifiable reference lists, unexplained prefixes. */
  suspect: string[];
  objects: Awaited<ReturnType<BackupObjectStore['listObjects']>>;
}
/** The recorded status of each snapshot's run, keyed by object prefix (from `backup_runs`). */
export type RunStatuses = (prefixes: readonly string[]) => Promise<ReadonlyMap<string, string>>;
/** Pruning stopped because the inventory cannot be verified; new snapshots still publish, deleting nothing. */
export class UnverifiedInventory extends Error {}

/**
 * Enumerate prefixes, not only commits. A prefix without a reference list is an abandoned publication only
 * when its run is recorded as not succeeded: runs hold the backup lock, so none of them is still in progress.
 */
export async function inventory(store: BackupObjectStore, blobKey: Buffer, runs?: RunStatuses): Promise<BackupInventory> {
  const objects = await store.listObjects('snapshots/');
  const ids = new Set<string>(), suspect: string[] = [];
  for (const object of objects) {
    const match = /^snapshots\/([^/]+)\/(database[.]age|manifest[.]age|references[.]json)$/.exec(object.key);
    if (!match || !z.uuid().safeParse(match[1]).success) suspect.push('Unexpected snapshot object');
    else ids.add(match[1]!);
  }
  const blobs = await store.listObjects('blobs/');
  const uncommitted = [...ids].filter((id) => !objects.some((object) => object.key === snapshotPrefix(id) + 'references.json'));
  const statuses = runs && uncommitted.length ? await runs(uncommitted.map(snapshotPrefix)) : new Map<string, string>();
  const snapshots: Snapshot[] = [], damaged: Snapshot[] = [], abandoned: string[] = [];
  for (const id of ids) {
    const prefix = snapshotPrefix(id);
    if (uncommitted.includes(id)) {
      const status = statuses.get(prefix);
      if (status !== undefined && status !== 'succeeded') abandoned.push(id);
      else suspect.push('Missing snapshot reference list');
      continue;
    }
    let snapshot: Snapshot;
    try { snapshot = verifyReferences(await readReferences(store, prefix + 'references.json'), blobKey, id); }
    catch { suspect.push('Invalid snapshot reference list'); continue; }
    const complete = ([['database.age', snapshot.database], ['manifest.age', snapshot.manifest]] as const).every(([name, expected]) =>
      objects.some((object) => object.key === prefix + name && object.size === expected.size))
      && snapshot.uploads.every((reference) => blobs.some((blob) => blob.key === reference.blob && blob.size === reference.encrypted.size));
    (complete ? snapshots : damaged).push(snapshot);
  }
  return { snapshots, damaged, abandoned, suspect, objects };
}
/**
 * What pruning keeps: the retention policy over complete snapshots, plus damaged snapshots the policy would
 * still keep (real damage, left for inspection). Damaged snapshots outside the policy are an interrupted
 * deletion, finished by pruning. Any retained damage or suspect object stops all deletion.
 */
export function prunePlan(state: BackupInventory, now: Date): { keep: ReadonlySet<string>; stopped: boolean } {
  const policy = retainedSnapshots([...state.snapshots, ...state.damaged], now);
  const keep = new Set([...retainedSnapshots(state.snapshots, now), ...state.damaged.filter((s) => policy.has(s.id)).map((s) => s.id)]);
  return { keep, stopped: state.suspect.length > 0 || state.damaged.some((s) => keep.has(s.id)) };
}
export async function pruneUnlocked(store: BackupObjectStore, blobKey: Buffer, uploads: ReadonlyMap<string, Uploads>,
  now: Date, reserveBytes = 0, budget = 8_000_000_000, sweepBefore = now, runs?: RunStatuses): Promise<{ retainedBytes: number; protectedKeys: ReadonlySet<string> }> {
  const state = await inventory(store, blobKey, runs);
  const { keep, stopped } = prunePlan(state, now);
  if (stopped) throw new UnverifiedInventory('Backup inventory could not be verified; pruning stopped');
  const retained = state.snapshots.filter((s) => keep.has(s.id));
  const blobs = new Set(retained.flatMap((s) => s.uploads.map((u) => u.blob)));
  const allBlobs = await store.listObjects('blobs/');
  const required = state.objects.filter((object) => keep.has(object.key.split('/')[1]!))
    .reduce((n, object) => n + object.size, 0) +
    allBlobs.filter((blob) => blobs.has(blob.key)).reduce((n, blob) => n + blob.size, 0);
  if (required + reserveBytes > budget) throw new Error('Backup retention budget cannot meet recovery objectives and in-flight reserve');
  for (const id of state.abandoned) {
    await store.deleteObject(snapshotPrefix(id) + 'database.age');
    await store.deleteObject(snapshotPrefix(id) + 'manifest.age');
  }
  // Delete the commit marker last. Interruption leaves a detectable incomplete snapshot, never an unprotected blob.
  for (const snapshot of [...state.snapshots, ...state.damaged].filter((s) => !keep.has(s.id))) {
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
