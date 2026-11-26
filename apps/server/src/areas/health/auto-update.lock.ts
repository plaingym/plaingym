// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated parameterized advisory lock; callers use only their gym's forGym transaction.
import { sql } from 'drizzle-orm';
import type { Transaction } from '@plaingym/db';

/**
 * Serialize this gym's automatic update reports within the caller's transaction, including the first report before
 * any audit exists. A transaction-scoped advisory lock keyed by the gym: it touches no row, so the gym's other writes
 * (which take a key-share lock on its `gyms` row for their foreign keys) never wait on it.
 */
export async function lockAutoUpdateRecording(tx: Transaction, gymId: string): Promise<void> {
  // eslint-disable-next-line database/system-tables -- Transaction-scoped advisory lock only, with the gym bound as data.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'health.auto_update.record:' + gymId}, 0))`);
}
