// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
// Test-only dedicated sessions exercise PostgreSQL's crash-release behavior.
// eslint-disable-next-line no-restricted-imports
import { openConnection } from '@plaingym/db/client';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { runInTransaction } from '@plaingym/shared/transaction';
import { createRestoreCheckLease, RestoreCheckBusyError } from './restore.billing-lease.js';

const database = useTestDatabase(), lease = createRestoreCheckLease(() => database.appUrl);
it('isolates gyms and releases a lease after failure', async () => {
  const gymId = uuidv7(), otherGym = uuidv7();
  await expect(lease(gymId, async () => {
    await expect(lease(gymId, async () => undefined)).rejects.toBeInstanceOf(RestoreCheckBusyError);
    expect(await lease(otherGym, async () => 'independent')).toBe('independent');
    throw new Error('Interrupted');
  })).rejects.toThrow('Interrupted');
  expect(await lease(gymId, async () => 'retry')).toBe('retry');
});
it('releases a lost process session without waiting for an audit-marker lifetime', async () => {
  const gymId = uuidv7(), abandoned = openConnection(database.appUrl, 1);
  try {
    await abandoned.sql`select pg_advisory_lock(hashtextextended(${`billing.runner.restore:${gymId}`}, 0))`;
    await expect(lease(gymId, async () => undefined)).rejects.toBeInstanceOf(RestoreCheckBusyError);
  } finally { await abandoned.close(); }
  expect(await lease(gymId, async () => 'recovered')).toBe('recovered');
});
it('refuses a lease inside an application transaction', async () => {
  await expect(runInTransaction(() => lease(uuidv7(), async () => undefined))).rejects.toThrow('cannot run inside a transaction');
});
