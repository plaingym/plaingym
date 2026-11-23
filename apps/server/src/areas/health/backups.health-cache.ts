// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Last backup tile reuses its bucket inventory briefly. A finished backup or prune bumps this generation,
 * so an inventory read before it is never served after it. Pruning and snapshots never read the cache.
 */
let generation = 0;

export function invalidateBackupHealth(): void { generation += 1; }

export function backupHealthGeneration(): number { return generation; }
