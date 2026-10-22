// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import type { Snapshot } from './backups.format.js';
import { retainedSnapshots } from './backups.retention.js';
const now = new Date('2026-10-22T12:00:00Z');
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
});
