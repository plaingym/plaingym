// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { importChunks, importRuns, exportRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createImportRetention, createImportRetentionJobs, IMPORT_RETENTION_JOB, RUN_RETENTION_MS, UPLOAD_RETENTION_MS } from './retention.js';
import { createImportPipeline } from './pipeline.js';
import { createExportService } from './export.js';

const database = useTestDatabase(), factory = createFactories(database);

it('marks expired uploads, then finished runs and export manifests, deleted as a whole', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-24T00:00:00Z'), storage = new FakeUploads(gymId, clock);
  await factory('gyms', gymId);
  const service = createImportRetention({ uploadsFor: async () => storage, clock, scope: database.forGym });
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
  await factory('gyms', gymId);
  createServerRegistry({ jobs: createImportRetentionJobs(createImportRetention({ uploadsFor: async () => storage, clock, scope: database.forGym })) }).registerJobs(jobs, new Set());
  expect(jobs.schedules.get(IMPORT_RETENTION_JOB)).toBe('23 * * * *');
  await storage.put(`${gymId}/imports/uploads/${uuidv7()}/source.csv`, new Uint8Array([1]), 'text/csv');
  clock.advance(UPLOAD_RETENTION_MS);
  await jobs.triggerSchedule(IMPORT_RETENTION_JOB, [{ gymId, timezone: 'UTC' }], 'hour');
  while (await jobs.runNext()) { /* drain */ }
  expect((await storage.list(`${gymId}/imports/`))[0]!.deletedAt).toBeDefined();
});

it('expires table-backed progress and chunks after the last update, sweeping files and isolating gyms', async () => {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2099-10-24T00:00:00Z');
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const storage = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock);
  const options = { uploadsFor: async () => storage, clock, scope: database.forGym, jobs };
  const pipeline = createImportPipeline(options), exports = createExportService(options), retention = createImportRetention(options);
  const context = { gymId, actor: { kind: 'system' } } as const;
  const uploaded = await pipeline.upload(context, new File(['First Name,Last Name\nTest,Member\n'], 'people.csv'));
  const run = await pipeline.start(context, { uploadId: uploaded.id, mapper: 'people', dryRun: true, duplicatePolicy: 'error',
    mapping: [{ sourceColumn: 'First Name', targetField: 'firstName' }, { sourceColumn: 'Last Name', targetField: 'lastName' }] }, 'UTC');
  const exported = await exports.create(context, 'UTC'); await exports.run(gymId, exported.id);
  const otherRun = await factory('importRuns', otherGym), otherChunk = await factory('importChunks', otherGym, { runId: otherRun.id });
  const otherExport = await factory('exportRuns', otherGym);
  clock.advance(23 * 60 * 60_000); await pipeline.run(gymId, run.id);
  clock.advance(60 * 60_000);
  expect(await retention.expire(gymId)).toBe(1); // CSV and upload metadata, not the run.
  expect((await pipeline.get(gymId, run.id)).status).toBe('succeeded');
  clock.advance(RUN_RETENTION_MS - UPLOAD_RETENTION_MS);
  expect(await retention.expire(gymId)).toBe(1); // Export state and archive together.
  expect(await database.forGym(gymId, (tx) => tx.select().from(exportRuns))).toEqual([]);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importChunks))).toHaveLength(1);
  clock.advance(23 * 60 * 60_000);
  expect(await retention.expire(gymId)).toBe(1);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importRuns))).toEqual([]);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importChunks))).toEqual([]);
  await expect(pipeline.get(gymId, run.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(exports.get(gymId, exported.id)).rejects.toMatchObject({ code: 'not_found' });
  expect(await retention.expire(gymId)).toBe(0);
  expect(await storage.sweep({ before: clock.now() })).toHaveLength(3);
  expect(await storage.list(`${gymId}/imports/`)).toEqual([]);
  expect(await database.forGym(otherGym, (tx) => tx.select().from(importRuns).where(eq(importRuns.id, otherRun.id)))).toHaveLength(1);
  expect(await database.forGym(otherGym, (tx) => tx.select().from(importChunks).where(eq(importChunks.id, otherChunk.id)))).toHaveLength(1);
  expect(await database.forGym(otherGym, (tx) => tx.select().from(exportRuns).where(eq(exportRuns.id, otherExport.id)))).toHaveLength(1);
});
