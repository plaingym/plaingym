// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { PostgresJobs, type PostgresJobsOptions } from './postgres.js';

const database = useTestDatabase();
const narrowed = 'A job queue built with finishedAtColumn or failureCountColumn false can only enqueue and fail interrupted jobs';

describe('a queue built without a jobs column', () => {
  for (const option of [{ finishedAtColumn: false }, { failureCountColumn: false }] as const) {
    it(`refuses to claim with ${Object.keys(option)[0]} false and never touches the database`, async () => {
      const untouched = () => { throw new Error('The database was called'); };
      const stub = { forGym: vi.fn(untouched), forSystem: vi.fn(untouched) } as unknown as NonNullable<PostgresJobsOptions['database']>;
      const queue = new PostgresJobs({ database: stub, clock: new TestClock('2026-11-01T00:00:00Z'), ...option });
      expect(() => queue.start({ pollMs: 10 })).toThrow(narrowed);
      await expect(queue.runNext()).rejects.toThrow(narrowed);
      expect(stub.forGym).not.toHaveBeenCalled();
      expect(stub.forSystem).not.toHaveBeenCalled();
    });
  }

  it('leaves a default queue claiming: runNext on an empty database returns false', async () => {
    const queue = new PostgresJobs({ database, clock: new TestClock('2026-11-01T00:00:00Z') });
    expect(await queue.runNext()).toBe(false);
  });
});
