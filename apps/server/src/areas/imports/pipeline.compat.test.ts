// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { importRuns, importChunks, exportRuns, members, memberTags, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { exportDatasets, exportJobSchema, type ExportJob, type ImportJob } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createImportPipeline } from './pipeline.js';
import { autoMatch, parseCsv } from './pipeline.csv.js';
import { createExportService } from './export.js';
import { PipelineStore } from './pipeline.store.js';
import { MapperRegistry, type CsvMapper } from './mappers/registry.js';

const database = useTestDatabase(), factory = createFactories(database);
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const clock = new TestClock('2099-10-24T00:00:00Z'), storage = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock);
  const options = { clock, scope: database.forGym, uploadsFor: async () => storage, jobs };
  const store = new PipelineStore(options.uploadsFor), actor = { kind: 'system' } as const;
  return { gymId, clock, storage, store, options, context: { gymId, actor } };
}

it('continues a legacy import while the previous release is still writing checkpoints and manifests', async () => {
  const { gymId, clock, storage, store, options, context } = await fixture();
  const seen: string[] = [];
  const mapper: CsvMapper = { id: 'people', available: true,
    async analyze(_tx, rows, _plan, context) {
      seen.push(context.timezone);
      return rows.map((row) => ({ ...row, action: 'create', duplicateIds: [], issues: [] }));
    },
    async commit(tx, rows, context) {
      await tx.insert(memberTags).values(rows.map((row) => ({ gymId, name: `${context.runId}:${row.rowNumber}` })));
      return rows.length;
    },
  };
  const pipeline = createImportPipeline({ ...options, mappers: new MapperRegistry([mapper]) });
  const uploaded = await pipeline.upload(context, new File(['First Name\n' + Array.from({ length: 150 }, (_, i) => `Person ${i}\n`).join('')], 'people.csv'));
  const id = uuidv7(), chunkIds = [uuidv7(), uuidv7()];
  const input = { uploadId: uploaded.id, mapper: 'people', dryRun: false, duplicatePolicy: 'error',
    mapping: [{ sourceColumn: 'First Name', targetField: 'firstName' }] } as const;
  const job: ImportJob = { id, uploadId: uploaded.id, mapper: 'people', dryRun: false, status: 'pending',
    totalRows: 150, processedRows: 0, committedRows: 0, errorCount: 0, createdAt: clock.now().toISOString(), completedAt: null };
  const key = (file: string) => store.key(gymId, 'runs', id, file);
  // These are the exact prior-release shapes, including a run saved before timezone was recorded.
  await store.put(gymId, key('run.json'), { job, input, actor: context.actor, chunkIds });
  await store.put(gymId, key('state-00000000.json'), job);
  expect(await pipeline.get(gymId, id)).toEqual(job);

  // An old worker commits after the new process has already read the pending manifest.
  await database.forGym(gymId, async (tx) => {
    await tx.insert(memberTags).values(Array.from({ length: 100 }, (_, i) => ({ gymId, name: `${id}:${i + 2}` })));
    await writeAudit(tx, { id: chunkIds[0], gymId, actorKind: 'system', action: 'imports.chunk.committed',
      targetType: 'import', targetId: id, after: { offset: 0, count: 100, issues: [] }, occurredAt: clock.now() });
  });
  await store.put(gymId, key('state-00000002.json'), { ...job, status: 'running', processedRows: 100, committedRows: 100 });
  expect(await pipeline.get(gymId, id)).toMatchObject({ status: 'running', processedRows: 100 });
  const restarted = createImportPipeline({ ...options, mappers: new MapperRegistry([mapper]) });
  await Promise.all([restarted.run(gymId, id), restarted.run(gymId, id)]);
  expect(await restarted.get(gymId, id)).toMatchObject({ status: 'succeeded', processedRows: 150, committedRows: 150 });
  expect(await database.forGym(gymId, (tx) => tx.select().from(memberTags))).toHaveLength(150);
  expect(seen.length).toBeGreaterThan(0); expect(seen.every((timezone) => timezone === 'UTC')).toBe(true);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importRuns))).toEqual([]);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importChunks))).toEqual([]);
  const issue = { rowNumber: 151, column: null, code: 'conflict', message: 'Safe legacy issue' };
  await store.put(gymId, key('issues-00000100.json'), [issue]);
  expect(await restarted.errors(gymId, id, { offset: 0, limit: 1 })).toEqual({ data: [issue], pagination: { offset: 0, limit: 1, total: 1 } });
  expect((await storage.list(key(''))).length).toBeGreaterThan(0);
});

it('isolates Stripe lookup failures in a queued legacy people import', async () => {
  const { gymId, clock, store, options, context } = await fixture();
  const provider = new FakePayments(gymId, clock);
  vi.spyOn(provider, 'readBankAccountForImport').mockRejectedValue(new Error('Stripe unavailable'));
  const pipeline = createImportPipeline({ ...options, paymentsFor: async () => provider });
  const csv = 'First Name,Last Name,Stripe Customer ID,Stripe Payment Method ID\nFirst,Person,cus_First,pm_Failure\nSecond,Person,,\n';
  const upload = await pipeline.upload(context, new File([csv], 'people.csv'));
  const id = uuidv7();
  const input = { uploadId: upload.id, mapper: 'people', dryRun: false, duplicatePolicy: 'error',
    mapping: autoMatch(parseCsv(csv).columns) };
  const job: ImportJob = { id, uploadId: upload.id, mapper: 'people', dryRun: false, status: 'pending', totalRows: 2,
    processedRows: 0, committedRows: 0, errorCount: 0, createdAt: clock.now().toISOString(), completedAt: null };
  await store.put(gymId, store.key(gymId, 'runs', id, 'run.json'), { job, input, actor: context.actor, chunkIds: [uuidv7()] });
  await store.put(gymId, store.key(gymId, 'runs', id, 'state-00000000.json'), job);

  await pipeline.run(gymId, id);
  expect(await pipeline.get(gymId, id)).toMatchObject({ status: 'failed', processedRows: 2, committedRows: 1, errorCount: 1 });
  expect((await pipeline.errors(gymId, id, { offset: 0, limit: 10 })).data)
    .toMatchObject([{ rowNumber: 2, message: "Stripe couldn't check this payment method. Try again later." }]);
  expect(await database.forGym(gymId, tx => tx.select({ firstName: members.firstName }).from(members))).toEqual([{ firstName: 'Second' }]);
});

it('runs a queued legacy export and reads completion still written by the previous release', async () => {
  const { gymId, clock, store, options } = await fixture();
  const exports = createExportService(options);
  const legacy = (id: string): ExportJob => ({ id, datasets: [...exportDatasets], status: 'pending',
    createdAt: clock.now().toISOString(), completedAt: null, downloadUrl: null, expiresAt: null });
  const job = legacy(uuidv7()), key = (id: string, file: string) => store.key(gymId, 'exports', id, file);
  await store.put(gymId, key(job.id, 'pending.json'), job);
  expect(await exports.get(gymId, job.id)).toEqual(job);
  await exports.run(gymId, job.id);
  expect(await exports.get(gymId, job.id)).toMatchObject({ status: 'succeeded', downloadUrl: expect.any(String) });
  await exports.run(gymId, job.id); // Immutable legacy claim continues to deduplicate delivery.
  const other = legacy(uuidv7());
  await store.put(gymId, key(other.id, 'pending.json'), other);
  expect(await exports.get(gymId, other.id)).toEqual(other);
  const finished: ExportJob = { ...other, status: 'succeeded', completedAt: clock.now().toISOString(),
    downloadUrl: 'https://uploads.invalid/legacy.zip', expiresAt: new Date(clock.now().getTime() + 3600_000).toISOString() };
  await store.put(gymId, key(other.id, 'finished.json'), finished);
  expect(await createExportService(options).get(gymId, other.id)).toEqual(finished);
  expect(await database.forGym(gymId, (tx) => tx.select().from(exportRuns).where(eq(exportRuns.id, job.id)))).toEqual([]);
});

it('filters unknown datasets in legacy export manifests before reading or streaming them', async () => {
  const { gymId, clock, store, storage, options } = await fixture(), id = uuidv7();
  const job: ExportJob = { id, datasets: ['members', 'unknown_dataset', 'toString'] as ExportJob['datasets'], status: 'pending',
    createdAt: clock.now().toISOString(), completedAt: null, downloadUrl: null, expiresAt: null };
  const key = (file: string) => store.key(gymId, 'exports', id, file), exports = createExportService(options);
  await store.put(gymId, key('pending.json'), job);
  expect(exportJobSchema.parse(await exports.get(gymId, id)).datasets).toEqual(['members']);
  await exports.run(gymId, id);
  expect(exportJobSchema.parse(await exports.get(gymId, id))).toMatchObject({ status: 'succeeded', datasets: ['members'] });
  const raw = await new Response(await storage.get(key('export.zip'))).text();
  expect(raw).toContain('members.csv');
  expect(raw).not.toContain('unknown_dataset.csv');
  expect(raw).not.toContain('toString.csv');
  // A finished manifest written by an older worker is filtered on read too.
  const other = uuidv7();
  await store.put(gymId, store.key(gymId, 'exports', other, 'finished.json'), { ...job, id: other, status: 'succeeded',
    completedAt: clock.now().toISOString(), downloadUrl: 'https://uploads.invalid/legacy.zip',
    expiresAt: new Date(clock.now().getTime() + 3600_000).toISOString() });
  expect(exportJobSchema.parse(await exports.get(gymId, other)).datasets).toEqual(['members']);
});
