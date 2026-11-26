// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { PostgresJobs } from './postgres.js';

// The rollback smoke inserts these envelopes by hand, so they must keep the shape this queue writes.
const database = useTestDatabase();
beforeEach(async () => { await database.forSystem(async (tx) => { await tx.delete(jobs); }); });

it('keeps the rollback smoke\'s newer-release envelopes in the shape the queue writes', async () => {
  const { newerReleaseJobs } = await import(new URL('../../../../../deploy/release/previous-smoke.mjs', import.meta.url).href) as
    { newerReleaseJobs: { name: string; envelope: Record<string, unknown> }[] };
  expect(newerReleaseJobs.length).toBeGreaterThan(0);
  const queue = new PostgresJobs({ database, clock: new TestClock('2026-01-01T00:00:00Z') });
  for (const { name, envelope } of newerReleaseJobs) {
    const { jobId } = await queue.enqueueSystem(name, {}, { timezone: 'UTC' });
    const [row] = await database.forSystem((tx) => tx.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, jobId)));
    const stored = row!.payload as Record<string, unknown>;
    const expected = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'addedByNewerRelease'));
    const shape = (value: Record<string, unknown>) => ({ keys: Object.keys(value).sort(), version: value.version });
    expect(shape(expected), `Update newerReleaseJobs in deploy/release/previous-smoke.mjs: ${name} is no longer queued with this envelope`)
      .toEqual(shape(stored));
  }
});
