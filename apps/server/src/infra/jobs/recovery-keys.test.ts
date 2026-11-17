// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs as jobRows, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { runInTransaction } from '@plaingym/shared/transaction';
import { FakeJobs, PostgresJobs } from './index.js';

const database = useTestDatabase(), factory = createFactories(database), gymId = uuidv7(), otherGym = uuidv7();
beforeAll(async () => { await factory('gyms', gymId); await factory('gyms', otherGym); });

describe.each(['fake', 'postgres'] as const)('%s retained recovery keys', kind => {
  it('finds only the requested name and gym, includes completed jobs, and excludes missing keys', async () => {
    const queue = kind === 'fake' ? new FakeJobs() : new PostgresJobs({ database });
    const options = { gymId, timezone: 'UTC', idempotencyKey: 'same-key' };
    const { jobId } = await queue.enqueue('recovery.fixture', {}, options);
    await queue.enqueue('recovery.other', {}, { ...options, idempotencyKey: 'other-name' });
    await queue.enqueue('recovery.fixture', {}, { ...options, gymId: otherGym, idempotencyKey: 'other-gym' });
    const keys = ['same-key', 'other-name', 'other-gym', 'missing'];
    expect(await queue.existingJobs('recovery.fixture', keys, { gymId })).toEqual(['same-key']);
    if (queue instanceof FakeJobs) queue.jobs.find(job => job.id === jobId)!.status = 'completed';
    else await database.forGym(gymId, tx => tx.update(jobRows).set({ status: 'succeeded' }).where(eq(jobRows.id, jobId)));
    expect(await queue.existingJobs('recovery.fixture', keys, { gymId })).toEqual(['same-key']);
    expect(await queue.existingJobs('recovery.fixture', [], { gymId })).toEqual([]);
    await runInTransaction(async () => {
      await expect(queue.existingJobs('recovery.fixture', keys, { gymId })).rejects.toThrow('transaction');
    });
  });
});
