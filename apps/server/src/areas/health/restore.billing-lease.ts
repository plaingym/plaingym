// SPDX-License-Identifier: AGPL-3.0-only
// Reviewed restore infrastructure: a dedicated session holds the lease outside application transactions.
// eslint-disable-next-line no-restricted-imports
import { openConnection } from '@plaingym/db/client';
import { assertNoTransaction } from '@plaingym/shared/transaction';

export class RestoreCheckBusyError extends Error {
  constructor() { super('Restore reconciliation is already running'); this.name = 'RestoreCheckBusyError'; }
}
export type RestoreCheckLease = <T>(gymId: string, action: () => Promise<T>) => Promise<T>;

/** One running check per gym, released on completion or process death, with no age-based takeover. */
export function createRestoreCheckLease(url: () => string | undefined = () => process.env.DATABASE_URL): RestoreCheckLease {
  return async (gymId, action) => {
    assertNoTransaction('restore.checkLease');
    const address = url();
    if (!address) throw new Error('Restore reconciliation database is not configured');
    const connection = openConnection(address, 1);
    try {
      const session = await connection.sql.reserve();
      try {
        // Queued checks and explicit reruns share one lease for the gym.
        const key = `billing.runner.restore:${gymId}`;
        const [lease] = await session<{ acquired: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`;
        if (!lease?.acquired) throw new RestoreCheckBusyError();
        try { return await action(); }
        // Closing the session releases the lock too, so a failed unlock mustn't replace the check's own outcome.
        finally { await session`select pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => undefined); }
      } finally { session.release(); }
    } finally { await connection.close(); }
  };
}
export const restoreCheckLease = createRestoreCheckLease();
