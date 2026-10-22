// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';

const transactions = new AsyncLocalStorage<true>();

export function isInTransaction(): boolean {
  return transactions.getStore() === true;
}

export function assertNoTransaction(operation: string): void {
  if (isInTransaction()) {
    throw new Error(`${operation} cannot run inside a transaction`);
  }
}

export async function runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
  assertNoTransaction('Nested transaction');
  return transactions.run(true, fn);
}
