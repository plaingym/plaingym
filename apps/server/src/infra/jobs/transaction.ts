// SPDX-License-Identifier: AGPL-3.0-only
import type { forGym, Transaction } from '@plaingym/db';
import { isInTransaction } from '@plaingym/shared/transaction';

/** Caller-owned gym transaction, including commit notification for in-memory queues. */
export interface JobTransaction {
  readonly tx: Transaction;
  readonly gymId: string;
}
/** Lets the in-memory queue publish on commit; not part of the jobs interface. */
export const jobTransactionStates = new WeakMap<JobTransaction, { active: boolean; committed: (() => void)[]; settled: Promise<void> }>();
/** Opens the caller's scope once; queue inserts use its handle and fake jobs publish only after commit. */
export async function withJobTransaction<T>(scope: typeof forGym, gymId: string,
  fn: (transaction: JobTransaction) => Promise<T>): Promise<T> {
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const state = { active: true, committed: [] as (() => void)[], settled };
  try {
    const result = await scope(gymId, tx => {
      const transaction = Object.freeze({ tx, gymId });
      jobTransactionStates.set(transaction, state);
      return fn(transaction);
    });
    for (const commit of state.committed) commit();
    return result;
  } finally { state.active = false; settle(); }
}
/** Rejects missing, expired or foreign-gym caller scopes before accessing the queue. */
export function assertJobTransaction(transaction: JobTransaction, gymId: string): void {
  if (!isInTransaction() || !jobTransactionStates.get(transaction)?.active || transaction.gymId !== gymId)
    throw new Error('Job transaction must be active and belong to the job gym');
}
