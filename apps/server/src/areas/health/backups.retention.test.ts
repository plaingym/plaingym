// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import type { Snapshot } from './backups.format.js';
import { prunePlan, retainedSnapshots, type BackupInventory } from './backups.retention.js';
const now = new Date('2026-10-22T12:00:00Z');
afterEach(() => vi.unstubAllEnvs());
function snapshot(at: Date, kind: Snapshot['kind'] = 'hourly'): Snapshot {
  return { version: 1, id: uuidv7(), kind, startedAt: at.toISOString(),
    database: { sha256: 'a'.repeat(64), size: 1 }, manifest: { sha256: 'b'.repeat(64), size: 1 }, uploads: [] };
}
describe('snapshot retention', () => {
  it('retains at most 24 hourly, 7 daily, and 4 weekly buckets while sharing coincident snapshots', () => {
    const snapshots = Array.from({ length: 40 * 24 }, (_, hours) => snapshot(new Date(now.getTime() - hours * 3_600_000)));
    const keep = retainedSnapshots(snapshots, now);
    expect(keep.size).toBeLessThanOrEqual(35);
    expect([...snapshots.slice(0, 24)].every((s) => keep.has(s.id))).toBe(true);
    expect(keep.has(snapshots[0]!.id)).toBe(true);
    expect(keep.has(snapshots.at(-1)!.id)).toBe(false);
  });
  it('keeps only two pre-upgrade snapshots within 30 days', () => {
    const snapshots = [0, 1, 2, 31].map((days) => snapshot(new Date(now.getTime() - days * 86_400_000), 'pre_upgrade'));
    const keep = retainedSnapshots(snapshots, now);
    expect(keep).toEqual(new Set(snapshots.slice(0, 2).map((s) => s.id)));
  });
  it('keeps the floor restore point beyond both age and count limits, releasing it when the guard clears', () => {
    const snapshots = [0, 1, 2, 60].map(days => snapshot(new Date(now.getTime() - days * 86_400_000), 'pre_upgrade'));
    const protectedId = snapshots[3]!.id;
    vi.stubEnv('SCHEMA_ROLLBACK_FLOOR', 'v1.2.0'); vi.stubEnv('SCHEMA_SNAPSHOT', protectedId);
    expect(retainedSnapshots(snapshots, now)).toEqual(new Set([snapshots[0]!.id, snapshots[1]!.id, protectedId]));
    const state: BackupInventory = { snapshots: snapshots.slice(0, 3), damaged: [snapshots[3]!], abandoned: [], suspect: [], objects: [] };
    expect(prunePlan(state, now)).toMatchObject({ stopped: true });
    vi.stubEnv('SCHEMA_ROLLBACK_FLOOR', '');
    expect(retainedSnapshots(snapshots, now).has(protectedId)).toBe(false);
    expect(prunePlan(state, now).stopped).toBe(false);
  });
  it('finishes deleting a damaged snapshot outside the policy and stops at damage the policy keeps', () => {
    const state = (damaged: Snapshot[], extra: Partial<BackupInventory> = {}): BackupInventory =>
      ({ snapshots: recent, damaged, abandoned: [], suspect: [], objects: [], ...extra });
    // Hourly snapshots fill all 24 hourly, 7 daily and 4 weekly buckets, so a 60-day-old one is outside the policy.
    const recent = Array.from({ length: 40 * 24 }, (_, hours) => snapshot(new Date(now.getTime() - hours * 3_600_000)));
    const expired = snapshot(new Date(now.getTime() - 60 * 86_400_000)), current = snapshot(new Date(now.getTime() + 60_000));
    expect(prunePlan(state([expired]), now)).toMatchObject({ stopped: false });
    expect(prunePlan(state([expired]), now).keep.has(expired.id)).toBe(false);
    expect(prunePlan(state([current]), now)).toMatchObject({ stopped: true });
    expect(prunePlan(state([], { abandoned: ['id'] }), now)).toMatchObject({ stopped: false });
    expect(prunePlan(state([], { suspect: ['Missing snapshot reference list'] }), now)).toMatchObject({ stopped: true });
  });
});
