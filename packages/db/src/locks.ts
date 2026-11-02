// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { Transaction } from './client.js';

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

/**
 * Per-gym advisory locks. Each takes a key made of its name and a gym ID, so one gym's work never waits on
 * another's; they are held with `lockGym` inside the gym's transaction and released when it ends. The key is
 * hashed to one bigint, which Postgres keeps apart from the (namespace, key) pairs above. Two keys could in theory
 * hash alike; the cost is one wait on unrelated work, never a wrong answer.
 *
 * Don't rename a name: processes running the old and the new release at once would take different locks.
 */
export const gymAdvisoryLocks = {
  /** Staff dismissals of the gym's charge failure reports: two of one report run one after the other. */
  chargeFailures: 'billing.runner.charge_failures',
} as const;
export type GymAdvisoryLock = keyof typeof gymAdvisoryLocks;

/** The text Postgres hashes for a gym's lock. */
export function gymAdvisoryLockKey(lock: GymAdvisoryLock, gymId: string): string {
  return gymAdvisoryLocks[lock] + ':' + gymId;
}

/** Waits for a gym's lock, then holds it until `tx` ends. */
export async function lockGym(tx: Transaction, lock: GymAdvisoryLock, gymId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${gymAdvisoryLockKey(lock, gymId)}, 0))`);
}
