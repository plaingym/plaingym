// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Postgres advisory lock keys, as (namespace, key) pairs. Each lock serializes one kind of work only:
 * a long backup must never hold the lock job workers claim with.
 */
export const advisoryLockNamespace = 1886151021;
export const advisoryLocks = {
  migrations: 1,
  /** Snapshots, pruning, upload sweeps, and restore. Held for a whole snapshot. */
  backups: 2,
  /** The short per-gym concurrency check and claim in the job worker. */
  jobClaims: 3,
} as const;
