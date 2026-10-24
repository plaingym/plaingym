// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createUploadSweepJobs, UPLOAD_SWEEP_GRACE_MS, UPLOAD_SWEEP_JOB } from './uploads-sweep.js';

async function fixture(configured: boolean) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-23T03:40:00Z'), storage = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock);
  let locks = 0;
  createServerRegistry({ jobs: createUploadSweepJobs({ uploadsFor: async () => storage, backupsConfigured: async () => configured,
    locked: async (action) => { locks++; return action(); } }) }).registerJobs(jobs, new Set());
  await storage.put(gymId + '/old', new Uint8Array([1]), 'image/png'); await storage.markDeleted(gymId + '/old');
  clock.advance(UPLOAD_SWEEP_GRACE_MS);
  await storage.put(gymId + '/recent', new Uint8Array([2]), 'image/png'); await storage.markDeleted(gymId + '/recent');
  await storage.put(gymId + '/live', new Uint8Array([3]), 'image/png');
  await jobs.triggerSchedule(UPLOAD_SWEEP_JOB, [{ gymId, timezone: 'UTC' }], 'today');
  while (await jobs.runNext()) { /* drain */ }
  return { gymId, storage, jobs, locks: () => locks };
}

it('sweeps files deleted past the grace period under the backup lock when no backups prune', async () => {
  const { gymId, storage, jobs, locks } = await fixture(false);
  expect(jobs.schedules.get(UPLOAD_SWEEP_JOB)).toBe('40 3 * * *');
  expect(await storage.get(gymId + '/old')).toBeNull();
  expect(await storage.get(gymId + '/recent')).not.toBeNull();
  expect(await storage.get(gymId + '/live')).not.toBeNull();
  expect(locks()).toBe(1);
});
it('leaves sweeping to backup pruning when backups are configured', async () => {
  const { gymId, storage, locks } = await fixture(true);
  expect(await storage.get(gymId + '/old')).not.toBeNull();
  expect(locks()).toBe(0);
});
