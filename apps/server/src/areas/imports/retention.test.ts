// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createImportRetention, createImportRetentionJobs, IMPORT_RETENTION_JOB, RUN_RETENTION_MS, UPLOAD_RETENTION_MS } from './retention.js';

it('marks expired uploads, then finished runs and export manifests, deleted as a whole', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-24T00:00:00Z'), storage = new FakeUploads(gymId, clock);
  const service = createImportRetention({ uploadsFor: async () => storage, clock });
  const put = (path: string) => storage.put(`${gymId}/imports/${path}`, new Uint8Array([1]), 'application/json');
  const live = async () => (await storage.list(`${gymId}/imports/`)).filter((info) => !info.deletedAt).map((info) => info.key.split('/').slice(2, 4).join('/'));
  const upload = uuidv7(), run = uuidv7(), exported = uuidv7();
  await put(`uploads/${upload}/source.csv`); await put(`uploads/${upload}/meta.json`);
  await put(`runs/${run}/run.json`); await put(`exports/${exported}/pending.json`);
  clock.advance(UPLOAD_RETENTION_MS - 1);
  // The run is still writing: its newest file keeps the whole run.
  await put(`runs/${run}/state-00000001.json`);
  expect(await service.expire(gymId)).toBe(0);
  clock.advance(1);
  expect(await service.expire(gymId)).toBe(1);
  expect(new Set(await live())).toEqual(new Set([`runs/${run}`, `exports/${exported}`]));
  clock.advance(RUN_RETENTION_MS - UPLOAD_RETENTION_MS);
  expect(await service.expire(gymId)).toBe(1);
  expect(await live()).toEqual([`runs/${run}`, `runs/${run}`]);
  clock.advance(UPLOAD_RETENTION_MS);
  expect(await service.expire(gymId)).toBe(1);
  expect(await live()).toEqual([]);
  expect(await service.expire(gymId)).toBe(0);
  // Swept files are gone for good.
  expect((await storage.sweep({ before: clock.now() })).length).toBe(5);
});
it('runs hourly per gym', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-24T00:00:00Z'), storage = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock);
  createServerRegistry({ jobs: createImportRetentionJobs(createImportRetention({ uploadsFor: async () => storage, clock })) }).registerJobs(jobs, new Set());
  expect(jobs.schedules.get(IMPORT_RETENTION_JOB)).toBe('23 * * * *');
  await storage.put(`${gymId}/imports/uploads/${uuidv7()}/source.csv`, new Uint8Array([1]), 'text/csv');
  clock.advance(UPLOAD_RETENTION_MS);
  await jobs.triggerSchedule(IMPORT_RETENTION_JOB, [{ gymId, timezone: 'UTC' }], 'hour');
  while (await jobs.runNext()) { /* drain */ }
  expect((await storage.list(`${gymId}/imports/`))[0]!.deletedAt).toBeDefined();
});
